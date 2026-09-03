// PRIESTATE — Server-side account service (Level 3).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Responsibilities:
//   * register a user account bound to a wallet address,
//   * store the password ONLY as a salted scrypt hash (never plaintext),
//   * store retrievable PII ONLY as an AES-256-GCM ciphertext blob, using a
//     server-only ACCOUNT_ENC_SECRET; fail closed when it is not configured,
//   * manage SMS OTP and WhatsApp OTP via two independent OtpService
//     instances (each code stored only as an HMAC hash, short-lived, single
//     use, cooldown + rate limited),
//   * model Google as a provider boundary with an honest `configured` state
//     (never fake a real OAuth exchange),
//   * enforce a COMPULSORY multi-factor login: wallet + password + SMS OTP +
//     WhatsApp OTP + Google, in addition to a completed identity check.
//
// Nothing in this module, and nothing stored by it, ever reaches the Midnight
// ledger. On-chain records reference accounts only by a random non-PII
// accountId.

import { randomBytes } from 'node:crypto';
import { OtpService, type OtpIssueResult, type OtpVerifyResult } from '../lib/otp-service.js';
import type { AccountStore } from './store.js';
import { InMemoryAccountStore } from './store.js';
import { GoogleProvider, type GoogleBeginResult, type GoogleCompleteResult } from './google-provider.js';
import {
  deriveRegistrationState,
  type RegistrationFactor,
  type RegistrationSnapshot,
} from './registration-state.js';
import {
  parseAccountRegistration,
  type AccountRecord,
  type PublicAccountView,
  maskAadhaar,
} from './model.js';
import { toPublicAccountView } from './model.js';
import {
  hashPassword,
  verifyPassword,
  encryptPII,
  decryptPII,
  deriveEncryptionKey,
} from './security.js';
import { normalizeIndianMobile } from '../lib/validation.js';

export type AccountResult =
  | { ok: true; view: PublicAccountView }
  | { ok: true; session: { accountId: string } }
  | { ok: false; reason: 'unavailable' | 'unauthorized' | 'invalid-input' | 'not-found' | 'already-registered' | 'duplicate-otp' | 'factor-missing' | 'otp-required' | 'identity-verification-required' | 'bad-state' | 'expired' | 'replay' };

export interface AccountServiceOptions {
  readonly store?: AccountStore;
  readonly otp: {
    readonly hashSecret: string;
    readonly smsTtlMs?: number;
    readonly whatsappTtlMs?: number;
    readonly smsMaxAttempts?: number;
    readonly whatsappMaxAttempts?: number;
  };
  /** Server-only secret used to derive the PII-at-rest AES key. */
  readonly encryptionSecret: string;
  /**
   * SMS delivery transport. In production this is a real gateway; when
   * `configured` is false the feature reports `unavailable` (fail closed).
   * Tests inject a capture transport that records the code they generate.
   */
  readonly smsDelivery?: { readonly configured: boolean; readonly send: (to: string, code: string) => void };
  /** WhatsApp delivery transport (same honest boundary as SMS). */
  readonly whatsappDelivery?: { readonly configured: boolean; readonly send: (to: string, code: string) => void };
  /**
   * Google OAuth boundary. In production `complete` exchanges a real auth
   * code for an ID token and validates issuer/audience. Without a live
   * provider it returns false so the feature stays `unavailable`.
   */
  readonly googleAuthenticator?: { readonly configured: boolean; readonly complete: (code: string) => boolean };
  /**
   * Optional secure Google OAuth session manager used for the registration
   * `begin`/`complete(state, nonce, code)` flow. When omitted, a provider is
   * derived from `googleAuthenticator`.
   */
  readonly googleProvider?: GoogleProvider;
  readonly now?: () => number;
}

export class AccountService {
  private readonly store: AccountStore;
  private readonly smsOtp: OtpService;
  private readonly whatsappOtp: OtpService;
  private readonly encryptionKey: Buffer | null;
  private readonly smsDelivery: { configured: boolean; send: (to: string, code: string) => void };
  private readonly whatsappDelivery: { configured: boolean; send: (to: string, code: string) => void };
  private readonly googleAuthenticator: { configured: boolean; complete: (code: string) => boolean };
  private readonly googleProvider: GoogleProvider;
  readonly smsConfigured: boolean;
  readonly whatsappConfigured: boolean;
  readonly googleConfigured: boolean;

  constructor(options: AccountServiceOptions) {
    const enc = deriveEncryptionKey(options.encryptionSecret);
    // Missing/short encryption secret ⇒ the account feature is disabled
    // (fails closed). We do NOT throw here: the verification server must keep
    // serving the other endpoints even when accounts are unconfigured.
    this.encryptionKey = enc.ok && enc.key ? enc.key : null;
    this.store = options.store ?? new InMemoryAccountStore();
    this.smsOtp = new OtpService({
      hashSecret: options.otp.hashSecret,
      ttlMs: options.otp.smsTtlMs ?? 5 * 60 * 1000,
      maxAttempts: options.otp.smsMaxAttempts ?? 5,
      now: options.now,
    });
    this.whatsappOtp = new OtpService({
      hashSecret: options.otp.hashSecret,
      ttlMs: options.otp.whatsappTtlMs ?? 10 * 60 * 1000,
      maxAttempts: options.otp.whatsappMaxAttempts ?? 5,
      now: options.now,
    });
    this.smsDelivery = options.smsDelivery ?? { configured: false, send: () => undefined };
    this.whatsappDelivery = options.whatsappDelivery ?? { configured: false, send: () => undefined };
    this.googleAuthenticator =
      options.googleAuthenticator ?? { configured: false, complete: () => false };
    this.googleProvider =
      options.googleProvider ??
      new GoogleProvider({
        configured: this.googleAuthenticator.configured,
        exchange: (code) => this.googleAuthenticator.complete(code),
        now: options.now,
      });
    this.smsConfigured = this.smsDelivery.configured;
    this.whatsappConfigured = this.whatsappDelivery.configured;
    this.googleConfigured = this.googleAuthenticator.configured;
  }

  /** Public config exposed to clients so the UI can show honest states. */
  get capabilities(): {
    smsConfigured: boolean;
    whatsappConfigured: boolean;
    googleConfigured: boolean;
  } {
    return {
      smsConfigured: this.smsConfigured,
      whatsappConfigured: this.whatsappConfigured,
      googleConfigured: this.googleConfigured,
    };
  }

  /** True when the account feature has what it needs to function. */
  get available(): boolean {
    return this.encryptionKey !== null;
  }

  /** True when every external factor delivery channel is configured. */
  private get allFactorsConfigured(): boolean {
    return this.smsConfigured && this.whatsappConfigured && this.googleConfigured;
  }

  register(raw: unknown): AccountResult {
    const parsed = parseAccountRegistration(raw);
    if (!parsed.ok) return { ok: false, reason: 'invalid-input' };

    const { input } = parsed;
    if (!this.encryptionKey) return { ok: false, reason: 'unavailable' };
    if (!this.allFactorsConfigured) {
      return { ok: false, reason: 'unavailable' };
    }
    if (this.store.getByWallet(input.walletAddress)) {
      return { ok: false, reason: 'already-registered' };
    }

    const accountId = randomBytes(12).toString('hex');
    const { hash, salt } = hashPassword(input.password);

    const pii: {
      fullName: string;
      aadhaarNumber: string;
      addressOnAadhaar?: string;
      pincode?: string;
      dateOfBirth: string;
      mobileE164: string;
    } = {
      fullName: input.fullName,
      aadhaarNumber: input.aadhaarNumber,
      addressOnAadhaar: input.addressOnAadhaar,
      pincode: input.pincode,
      dateOfBirth: input.dateOfBirth,
      mobileE164: input.mobile,
    };

    const record: AccountRecord = {
      accountId,
      walletAddress: input.walletAddress,
      passwordHash: hash,
      passwordSalt: salt,
      piiCipherText: encryptPII(this.encryptionKey, pii),
      maskedMobile: (input.mobile as string).slice(0, 3) + '••••' + (input.mobile as string).slice(-2),
      maskedAadhaar: maskAadhaar(input.aadhaarNumber),
      smsOtpVerified: false,
      whatsappOtpVerified: false,
      googleLinked: false,
      identityVerified: false,
      createdAt: Date.now(),
    };

    this.store.create(record);
    return { ok: true, view: toPublicAccountView(record) };
  }

  // ── Lookup ─────────────────────────────────────────────────────────

  get(walletAddress: string): AccountResult {
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    return { ok: true, view: toPublicAccountView(record) };
  }

  getByAccountId(accountId: string): AccountResult {
    const record = this.store.getById(accountId);
    if (!record) return { ok: false, reason: 'not-found' };
    return { ok: true, view: toPublicAccountView(record) };
  }

  // ── OTP ────────────────────────────────────────────────────────────

  /**
   * Issue an SMS OTP to the account's registered mobile and hand the raw code
   * to the SMS delivery transport. The code is never returned to the caller
   * (it never reaches the browser); only the OTP service's HMAC hash is kept.
   */
  issueSmsOtp(
    walletAddress: string,
  ): OtpIssueResult | { ok: false; reason: 'unavailable' | 'not-found' } {
    if (!this.smsConfigured) return { ok: false, reason: 'unavailable' };
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    const pii = this.decryptPii(walletAddress);
    if (!pii.ok || !('pii' in pii)) return { ok: false, reason: 'not-found' };
    const key = OtpService.keyFor('sms', record.walletAddress);
    const result = this.smsOtp.issue(key);
    if (result.ok) {
      this.smsDelivery.send(pii.pii.mobileE164, result.code);
    }
    return result;
  }

  verifySmsOtp(
    walletAddress: string,
    code: string,
  ): OtpVerifyResult | { ok: false; reason: 'unavailable' | 'not-found' } {
    if (!this.smsConfigured) return { ok: false, reason: 'unavailable' };
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    const key = OtpService.keyFor('sms', record.walletAddress);
    const result = this.smsOtp.verify(key, code);
    if (result.ok) {
      this.store.update(walletAddress, { smsOtpVerified: true });
    }
    return result;
  }

  issueWhatsappOtp(
    walletAddress: string,
  ): OtpIssueResult | { ok: false; reason: 'unavailable' | 'not-found' } {
    if (!this.whatsappConfigured) return { ok: false, reason: 'unavailable' };
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    const pii = this.decryptPii(walletAddress);
    if (!pii.ok || !('pii' in pii)) return { ok: false, reason: 'not-found' };
    const key = OtpService.keyFor('whatsapp', record.walletAddress);
    const result = this.whatsappOtp.issue(key);
    if (result.ok) {
      this.whatsappDelivery.send(pii.pii.mobileE164, result.code);
    }
    return result;
  }

  verifyWhatsappOtp(
    walletAddress: string,
    code: string,
  ): OtpVerifyResult | { ok: false; reason: 'unavailable' | 'not-found' } {
    if (!this.whatsappConfigured) return { ok: false, reason: 'unavailable' };
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    const key = OtpService.keyFor('whatsapp', record.walletAddress);
    const result = this.whatsappOtp.verify(key, code);
    if (result.ok) {
      this.store.update(walletAddress, { whatsappOtpVerified: true });
    }
    return result;
  }

  // ── Google (provider boundary) ─────────────────────────────────────

  /**
   * Complete Google linking. The real OAuth exchange happens behind the
   * `googleAuthenticator` boundary; without a live provider this returns
   * `unavailable`. We never fabricate a successful exchange.
   */
  completeGoogle(walletAddress: string, authCode: string): AccountResult {
    if (!this.googleConfigured) return { ok: false, reason: 'unavailable' };
    if (!this.googleAuthenticator.complete(authCode)) {
      return { ok: false, reason: 'unauthorized' };
    }
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    this.store.update(walletAddress, { googleLinked: true });
    const updated = this.store.getByWallet(walletAddress)!;
    return { ok: true, view: toPublicAccountView(updated) };
  }

  /**
   * Start a secure Google sign-in for the registration flow. Issues a fresh
   * state + nonce challenge bound to the wallet. Fail-closed when the Google
   * provider is unconfigured. The nonce is returned to the in-app client and
   * must be echoed back alongside the OAuth state on completion.
   */
  googleBegin(walletAddress: string): GoogleBeginResult {
    return this.googleProvider.begin(walletAddress);
  }

  /**
   * Complete a secure Google sign-in. Validates the state/nonce challenge
   * (single-use, wallet-bound, TTL) before exchanging the code. On success,
   * marks the account's Google factor verified. Never fabricates a success.
   */
  googleComplete(
    walletAddress: string,
    params: { state: string; nonce: string; code: string },
  ): AccountResult {
    const result: GoogleCompleteResult = this.googleProvider.complete(walletAddress, params);
    if (!result.ok) {
      switch (result.reason) {
        case 'unavailable':
          return { ok: false, reason: 'unavailable' };
        case 'expired':
          return { ok: false, reason: 'expired' };
        case 'replay':
          return { ok: false, reason: 'replay' };
        case 'unauthorized':
          return { ok: false, reason: 'unauthorized' };
        default:
          return { ok: false, reason: 'bad-state' };
      }
    }
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    this.store.update(walletAddress, { googleLinked: true });
    const updated = this.store.getByWallet(walletAddress)!;
    return { ok: true, view: toPublicAccountView(updated) };
  }

  // ── Account existence & registration state ────────────────────────

  /**
   * Authoritative server-side existence check for a wallet. Returns ONLY
   * whether an account exists and its registration factor state — never any
   * PII. Used on wallet connect to route to registration vs login.
   */
  hasAccount(walletAddress: string): boolean {
    return this.store.getByWallet(walletAddress) !== null;
  }

  /**
   * Expose the registration factor state machine for an account. Returns null
   * when no account exists (no PII is revealed either way).
   */
  registrationState(
    walletAddress: string,
    requiredFactors?: readonly RegistrationFactor[],
  ): RegistrationSnapshot | null {
    const record = this.store.getByWallet(walletAddress);
    if (!record) return null;
    return deriveRegistrationState(record, { requiredFactors });
  }

  // ── Identity ───────────────────────────────────────────────────────

  /**
   * Record that identity verification has passed. The browser performs the
   * clearly-labelled DEMO face/document match; this endpoint only stores the
   * boolean outcome, never the selfie, document, or biometric payloads.
   */
  markIdentityVerified(walletAddress: string, confirmed: boolean): AccountResult {
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    if (!confirmed) return { ok: false, reason: 'unauthorized' };
    this.store.update(walletAddress, { identityVerified: true });
    return { ok: true, view: toPublicAccountView(this.store.getByWallet(walletAddress)!) };
  }

  // ── Login ──────────────────────────────────────────────────────────

  /**
   * Compulsory multi-factor login. Every factor is REQUIRED (not a menu of
   * alternatives): wallet address must match, password must verify, and the
   * account must already have passed SMS OTP, WhatsApp OTP, Google, and
   * identity verification. Returns a success session only when all hold.
   */
  login(input: {
    walletAddress: string;
    password: string;
  }): AccountResult {
    const record = this.store.getByWallet(input.walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    if (!verifyPassword(input.password, record.passwordHash, record.passwordSalt)) {
      return { ok: false, reason: 'unauthorized' };
    }
    if (!record.identityVerified) return { ok: false, reason: 'identity-verification-required' };
    if (!record.googleLinked) return { ok: false, reason: 'factor-missing' };
    if (!record.smsOtpVerified) return { ok: false, reason: 'factor-missing' };
    if (!record.whatsappOtpVerified) return { ok: false, reason: 'factor-missing' };
    return { ok: true, session: { accountId: record.accountId } };
  }

  /** Decrypt the owner's own PII (used only to deliver OTPs to the right mobile). */
  decryptPii(
    walletAddress: string,
  ): { ok: true; pii: AccountRecordPii } | { ok: false; reason: 'not-found' | 'unauthorized' } {
    if (!this.encryptionKey) return { ok: false, reason: 'not-found' };
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    const pii = decryptPII(this.encryptionKey, record.piiCipherText) as AccountRecordPii | null;
    if (!pii) return { ok: false, reason: 'unauthorized' };
    return { ok: true, pii };
  }

  /** Normalize/validate a mobile on the server (mirror of client checks). */
  normalizeMobile(raw: string): string | null {
    return normalizeIndianMobile(raw);
  }
}

export interface AccountRecordPii {
  readonly fullName: string;
  readonly aadhaarNumber: string;
  readonly addressOnAadhaar?: string;
  readonly dateOfBirth: string;
  readonly mobileE164: string;
}
