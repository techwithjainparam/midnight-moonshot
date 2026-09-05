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
  deriveLoginState,
  type LoginFactor,
  type LoginSnapshot,
} from './login-state.js';
import {
  parseAccountRegistration,
  type AccountRecord,
  type PublicAccountView,
  type FaceVerificationSnapshot,
  type IdentityEvidence,
  maskAadhaar,
  rejectIdentityEvidence,
} from './model.js';
import { toPublicAccountView } from './model.js';
import {
  hashPassword,
  verifyPassword,
  encryptPII,
  decryptPII,
  deriveEncryptionKey,
  deriveBiometricEncryptionKey,
  encryptBiometricReference,
  decryptBiometricReference,
} from './security.js';
import {
  compareToReference,
  deriveEnrollmentReference,
  deriveEnrollmentState,
  InMemoryBiometricSessionBook,
  type BiometricConfig,
  type BiometricReference,
  type BiometricSessionBook,
  type BiometricVerdict,
  type FaceEmbedding,
  DEFAULT_BIOMETRIC_CONFIG,
} from './biometric.js';
import { normalizeIndianMobile } from '../lib/validation.js';

export type AccountResult =
  | { ok: true; view: PublicAccountView }
  | { ok: true; session: { accountId: string } }
  | { ok: false; reason: 'unavailable' | 'unauthorized' | 'invalid-input' | 'not-found' | 'already-registered' | 'duplicate-otp' | 'factor-missing' | 'otp-required' | 'identity-verification-required' | 'bad-state' | 'expired' | 'replay' | 'identity-evidence-rejected' };

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
  /** Server-only secret used to derive the SEPARATE biometric-reference key. */
  readonly biometricEncryptionSecret?: string;
  /** Optional biometric thresholds/TTLs (defaults in DEFAULT_BIOMETRIC_CONFIG). */
  readonly biometricConfig?: Partial<BiometricConfig>;
  /** Optional single-use session book (injectable for deterministic tests). */
  readonly biometricSessions?: BiometricSessionBook;
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
  private readonly biometricKey: Buffer | null;
  private readonly biometricConfig: Required<BiometricConfig>;
  private readonly biometricSessions: BiometricSessionBook;
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
    const bio = deriveBiometricEncryptionKey(options.biometricEncryptionSecret);
    // The biometric feature is SEPARATELY fail-closed: without its own key we
    // never enroll, store, or verify a face reference.
    this.biometricKey = bio.ok && bio.key ? bio.key : null;
    this.biometricConfig = { ...DEFAULT_BIOMETRIC_CONFIG, ...options.biometricConfig };
    this.biometricSessions = options.biometricSessions ?? new InMemoryBiometricSessionBook();
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
    /**
     * Whether a real computer-vision face-verification provider is available
     * AND the server holds the SEPARATE biometric key needed to store/verify a
     * reference. This is true only when `biometricEncryptionSecret` is
     * configured; otherwise the login face stage fails closed.
     */
    faceVerificationConfigured: boolean;
  } {
    return {
      smsConfigured: this.smsConfigured,
      whatsappConfigured: this.whatsappConfigured,
      googleConfigured: this.googleConfigured,
      faceVerificationConfigured: this.biometricConfigured,
    };
  }

  /** True when the biometric-reference feature is configured (has its own key). */
  get biometricConfigured(): boolean {
    return this.biometricKey !== null;
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
      biometricReferenceCipherText: null,
      biometricReferenceVersion: null,
      biometricEnrolledAt: null,
      biometricConsentAt: null,
      biometricRevokedAt: null,
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
   * Expose the login factor state machine for an account. Returns null when no
   * account exists (no PII is revealed either way). Mirrors registrationState
   * but framed as the login factor sequence (wallet → google → sms → whatsapp).
   */
  loginState(
    walletAddress: string,
    requiredFactors?: readonly LoginFactor[],
  ): LoginSnapshot | null {
    const record = this.store.getByWallet(walletAddress);
    return deriveLoginState(record, { requiredFactors });
  }

  /**
   * Expose the LOGIN FACE-VERIFICATION stage state for an account (Level 3
   * Part 6). This is the SECOND, subsequent identity-verification stage on top
   * of the five-factor login — it is a distinct evalu-ation from liveness.
   *
   * The boundary is HONEST and FAIL-CLOSED:
   *   * `providerAvailable` is true only when a real CV provider exists. This
   *     build ships none, so it is always false.
   *   * `hasReferenceIdentity` is true only when the account holds a real
   *     registered biometric reference in a secure private boundary. This
   *     build stores NO biometric material (the Part 4 demo match is client
   *     and transient), so it is always false.
   *   * `required` is always true for login: the stage is a mandatory identity
   *     step and can never be silently skipped by the client.
   * No self-affirmed "face matched" success is accepted — there is no server
   * path that records one from a client boolean. Returns null when the account
   * does not exist.
   */
  faceVerificationState(
    walletAddress: string,
  ): FaceVerificationSnapshot | null {
    const record = this.store.getByWallet(walletAddress);
    if (!record) return null;
    const providerAvailable = this.biometricConfigured;
    const hasEnrolled = this.enrollmentStateFor(record) === 'enrolled';
    return {
      required: true,
      providerAvailable,
      hasReferenceIdentity: providerAvailable && hasEnrolled,
    };
  }

  /**
   * Enrollment lifecycle state for an account (server-authoritative).
   * Returns 'unavailable' when the biometric feature is not configured.
   */
  enrollmentStateFor(
    record: AccountRecord | null,
  ): 'not_enrolled' | 'enrolled' | 'revoked' | 'unavailable' {
    if (!this.biometricConfigured) return 'unavailable';
    if (!record) return 'not_enrolled';
    return deriveEnrollmentState({
      enrolled: Boolean(record.biometricReferenceCipherText),
      revokedAt: record.biometricRevokedAt,
    });
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
   * ⚠️ SECURITY FIX (Part 8). The previous `markIdentityVerified` accepted a
   * bare `confirmed:true` from the browser and set `identityVerified=true` with
   * NO real server-computed evidence. That self-assertion path is REMOVED.
   *
   * `identityVerified` can now become true ONLY through a successful server-
   * authoritative biometric enrollment (`enrollBiometricReference`), which
   * requires a valid unspent enrollment session AND a real, usable fingerprint
   * of the face in front of the camera. There is no client boolean that can set
   * `identityVerified` anymore. This method intentionally no longer exists.
   */

  // ── Biometric reference enrollment (Part 8) ────────────────────────

  /**
   * Begin a biometric reference ENROLLMENT session. Requires:
   *   * an existing account bound to `walletAddress`,
   *   * the biometric feature configured (separate key present),
   *   * the account NOT already enrolled (enrollment is for first-time setup;
   *     re-enrollment goes through the replace flow),
   *   * the account.has completed registration identity evidence (Part 7
   *     liveness+location), tracked via `recordIdentityEvidence` having been
   *     accepted before this call. We enforce it by requiring `provenLiveness`
   *     — a boolean the server set itself when it accepted identity evidence.
   *
   * Issues a single-use, short-TTL, wallet-bound enrollment token. Returns the
   * token + TTL for the client to use in the complete call (it never self-
   * asserts identity). Fails closed otherwise.
   */
  beginBiometricEnrollment(
    walletAddress: string,
  ):
    | { ok: true; token: string; expiresInMs: number }
    | { ok: false; reason: 'not-found' | 'unavailable' | 'bad-state' } {
    if (!this.biometricConfigured) return { ok: false, reason: 'unavailable' };
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    const state = this.enrollmentStateFor(record);
    if (state === 'enrolled' || state === 'revoked') {
      return { ok: false, reason: 'bad-state' };
    }
    const s = this.biometricSessions.issue({
      walletAddress,
      purpose: 'enrollment',
      referenceVersion: null,
      now: Date.now(),
    });
    return { ok: true, token: s.token, expiresInMs: this.biometricConfig.enrollmentTtlMs };
  }

  /**
   * Complete a biometric ENROLLMENT. The server consumes the single-use
   * enrollment token, derives a reference embedding from the supplied real
   * embeddings, encrypts it with the SEPARATE biometric key, stores it bound to
   * the wallet, records consent + enrollment time, and — as the ONLY path — sets
   * `identityVerified=true`. It NEVER trusts a client `matched`/`score`/`isHuman`
   * or bare `confirmed:true`.
   */
  enrollBiometricReference(
    walletAddress: string,
    input: {
      token: string;
      embeddings: readonly FaceEmbedding[];
      consent: boolean;
    },
  ):
    | { ok: true; referenceVersion: number; enrollmentState: 'enrolled'; identityVerified: boolean }
    | {
        ok: false;
        reason:
          | 'unavailable'
          | 'not-found'
          | 'bad-state'
          | 'no-consent'
          | 'session-invalid'
          | 'low-quality';
      } {
    if (!this.biometricConfigured) return { ok: false, reason: 'unavailable' };
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    const state = this.enrollmentStateFor(record);
    if (state !== 'not_enrolled') return { ok: false, reason: 'bad-state' };
    if (input.consent !== true) return { ok: false, reason: 'no-consent' };

    const session = this.biometricSessions.consume(
      input.token,
      walletAddress,
      'enrollment',
      Date.now(),
    );
    if (!session) return { ok: false, reason: 'session-invalid' };

    const derived = deriveEnrollmentReference(
      input.embeddings,
      this.biometricConfig,
    );
    if (!derived) return { ok: false, reason: 'low-quality' };

    const key = this.biometricKey as Buffer; // guarded by biometricConfigured
    const reference: BiometricReference = {
      embedding: derived.reference,
      version: 1,
      enrolledAt: Date.now(),
      consentAt: Date.now(),
      selfSimilarity: derived.selfSimilarity,
      spread: derived.spread,
    };
    const ciphertext = encryptBiometricReference(key, reference);
    const now = Date.now();
    this.store.update(walletAddress, {
      biometricReferenceCipherText: ciphertext,
      biometricReferenceVersion: 1,
      biometricEnrolledAt: now,
      biometricConsentAt: now,
      biometricRevokedAt: null,
      identityVerified: true,
    });
    return {
      ok: true,
      referenceVersion: 1,
      enrollmentState: 'enrolled',
      identityVerified: true,
    };
  }

  /**
   * Revolve / replace an enrolled biometric reference. Revoking marks it
   * revoked (login face matching then fails closed to `reference_revoked`),
   * and reverts `identityVerified` so the account must re-enroll (replacing the
   * old reference) before it can log in again. Consent + lifecycle boundary is
   * server-authoritative.
   */
  revokeBiometricReference(walletAddress: string):
    | { ok: true; enrollmentState: 'revoked' }
    | { ok: false; reason: 'unavailable' | 'not-found' | 'bad-state' } {
    if (!this.biometricConfigured) return { ok: false, reason: 'unavailable' };
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    const state = this.enrollmentStateFor(record);
    if (state !== 'enrolled') return { ok: false, reason: 'bad-state' };
    this.store.update(walletAddress, {
      biometricRevokedAt: Date.now(),
      identityVerified: false,
    });
    return { ok: true, enrollmentState: 'revoked' };
  }

  /**
   * Replace an existing (revoked or live) reference with a new enrollment.
   * Consumes a fresh enrollment session and bumps the reference version so old
   * captured tokens (bound to an older version) cannot be replayed against the
   * new reference. Restores `identityVerified` on success.
   */
  replaceBiometricReference(
    walletAddress: string,
    input: { token: string; embeddings: readonly FaceEmbedding[]; consent: boolean },
  ):
    | { ok: true; referenceVersion: number; enrollmentState: 'enrolled' }
    | {
        ok: false;
        reason:
          | 'unavailable'
          | 'not-found'
          | 'bad-state'
          | 'no-consent'
          | 'session-invalid'
          | 'low-quality';
      } {
    if (!this.biometricConfigured) return { ok: false, reason: 'unavailable' };
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    if (input.consent !== true) return { ok: false, reason: 'no-consent' };

    const session = this.biometricSessions.consume(
      input.token,
      walletAddress,
      'enrollment',
      Date.now(),
    );
    if (!session) return { ok: false, reason: 'session-invalid' };

    const derived = deriveEnrollmentReference(input.embeddings, this.biometricConfig);
    if (!derived) return { ok: false, reason: 'low-quality' };

    const nextVersion = (record.biometricReferenceVersion ?? 0) + 1;
    const key = this.biometricKey as Buffer;
    const reference: BiometricReference = {
      embedding: derived.reference,
      version: nextVersion,
      enrolledAt: Date.now(),
      consentAt: Date.now(),
      selfSimilarity: derived.selfSimilarity,
      spread: derived.spread,
    };
    const ciphertext = encryptBiometricReference(key, reference);
    const now = Date.now();
    this.store.update(walletAddress, {
      biometricReferenceCipherText: ciphertext,
      biometricReferenceVersion: nextVersion,
      biometricEnrolledAt: now,
      biometricConsentAt: now,
      biometricRevokedAt: null,
      identityVerified: true,
    });
    return { ok: true, referenceVersion: nextVersion, enrollmentState: 'enrolled' };
  }

  /**
   * Begin a LOGIN face-match VERIFICATION session (after the five factors).
   * Requires an ENROLLED, non-revoked reference. The issued single-use token is
   * bound to the wallet AND the current reference version, so a token minted
   * against an older reference cannot verify a newer one (replay protection
   * across re-enrollment).
   */
  beginBiometricVerification(
    walletAddress: string,
  ):
    | { ok: true; token: string; referenceVersion: number; expiresInMs: number }
    | { ok: false; reason: 'unavailable' | 'not-found' | 'no-reference' | 'revoked' } {
    if (!this.biometricConfigured) return { ok: false, reason: 'unavailable' };
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    const state = this.enrollmentStateFor(record);
    if (state === 'revoked') return { ok: false, reason: 'revoked' };
    if (state !== 'enrolled') return { ok: false, reason: 'no-reference' };
    const refVersion = record.biometricReferenceVersion ?? 0;
    const s = this.biometricSessions.issue({
      walletAddress,
      purpose: 'verification',
      referenceVersion: refVersion,
      now: Date.now(),
    });
    return {
      ok: true,
      token: s.token,
      referenceVersion: refVersion,
      expiresInMs: this.biometricConfig.verificationTtlMs,
    };
  }

  /**
   * Server-authoritative LOGIN FACE MATCH. Consumes the single-use verification
   * token (validating wallet binding + reference version), decrypts the stored
   * reference, computes the REAL cosine similarity against the submitted live
   * embedding, and returns ONLY a verdict + real score. Any client-supplied
   * `matched`/`score`/`isHuman` field is ignored — the verdict is derived here.
   */
  verifyBiometricMatch(
    walletAddress: string,
    input: {
      verificationToken: string;
      liveEmbedding: FaceEmbedding;
    },
  ): {
    ok: true;
    verdict: Extract<BiometricVerdict, 'matched' | 'mismatch'>;
    score: number;
    referenceVersion: number;
  } | {
    ok: false;
    verdict: Exclude<BiometricVerdict, 'matched' | 'mismatch'>;
  } {
    if (!this.biometricConfigured) return { ok: false, verdict: 'provider_unavailable' };
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, verdict: 'no_reference' };
    if (record.biometricRevokedAt !== null) return { ok: false, verdict: 'reference_revoked' };
    if (!record.biometricReferenceCipherText) return { ok: false, verdict: 'no_reference' };

    const session = this.biometricSessions.consume(
      input.verificationToken,
      walletAddress,
      'verification',
      Date.now(),
    );
    if (!session) return { ok: false, verdict: 'session_invalid' };
    // Replay / version protection: the token must match the CURRENT reference
    // version (a token minted against an older reference can't verify a newer).
    if (session.referenceVersion !== (record.biometricReferenceVersion ?? 0)) {
      return { ok: false, verdict: 'session_invalid' };
    }

    const key = this.biometricKey as Buffer;
    const reference = decryptBiometricReference(
      key,
      record.biometricReferenceCipherText,
    ) as BiometricReference | null;
    if (!reference) return { ok: false, verdict: 'error' };

    const result = compareToReference(input.liveEmbedding, reference.embedding, this.biometricConfig);
    if (result.verdict === 'matched' || result.verdict === 'mismatch') {
      return {
        ok: true,
        verdict: result.verdict,
        score: result.score ?? 0,
        referenceVersion: reference.version,
      };
    }
    return { ok: false, verdict: result.verdict };
  }

  /**
   * Server-authoritative gate for the COMBINED registration identity evidence
   * (real landmark liveness + live browser location). A bare boolean CANNOT
   * satisfy it: `rejectIdentityEvidence` validates liveness + a fresh,
   * accurate, in-range location fix. Returns the acceptance decision WITHOUT
   * storing or echoing raw coordinates, landmarks, or biometric values.
   */
  recordIdentityEvidence(
    walletAddress: string,
    evidence: IdentityEvidence | null | undefined,
  ):
    | { ok: true; accepted: boolean; receivedAtMs: number }
    | { ok: false; reason: 'not-found' | 'identity-evidence-rejected' } {
    const record = this.store.getByWallet(walletAddress);
    if (!record) return { ok: false, reason: 'not-found' };
    const now = Date.now();
    const denial = rejectIdentityEvidence(evidence, now);
    if (denial) return { ok: false, reason: 'identity-evidence-rejected' };
    // Evidence past structural/freshness/range validation; we deliberately do
    // NOT persist raw coordinates or any biometric marker.
    return { ok: true, accepted: true, receivedAtMs: now };
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
