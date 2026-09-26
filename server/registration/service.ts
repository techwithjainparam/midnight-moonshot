// PRIESTATE — Server-side registration service (Part 1, new flow).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// This service drives the FULL registration stepper with REAL server-side work
// behind every step:
//
//   personal → aadhaar-document → email → sms-otp → whatsapp-otp →
//   aadhaar-mobile → password → photo → liveness → location → FINALIZE
//
//   * personal      — validates name/Aadhaar/pincode(India Post)/DOB/mobile; PII
//                     is stored at rest ONLY as an AES-256-GCM blob,
//   * aadhaar-doc   — REAL OCR via a vendor adapter; extraction cross-checked
//                     against the entered name; filename is NEVER read,
//   * email         — disposable-domain rejection + per-address rate limits,
//   * sms/whatsapp  — REAL delivery adapters; codes are hashed, single-use,
//                     expiring, rate-limited,
//   * aadhaar-mobile— authorized KYC provider link check / OTP challenge,
//   * password      — salted scrypt hash ONLY (never plaintext),
//   * photo         — server-side PNG validation (real per-pixel corner checks),
//   * liveness      — server-issued randomized challenges validated in order,
//   * location      — server-scoped evidence gate (fresh, accurate, in-range),
//   * FINALIZE      — requires every gate above to have PASSED, then hands the
//                     derived material to AccountService.createAccountFromFinal-
//                     izedRegistration (all crypto remains in AccountService).
//
// A missing/unconfigured provider makes that step report `unavailable` — never
// a fabricated success. Nothing in this module reaches the Midnight ledger.

import { createHash, randomBytes } from 'node:crypto';
import { hashPassword } from '../account/security.js';
import * as model from '../account/model.js';
import { maskAadhaar, maskEmail, passwordIssues, rejectIdentityEvidence, type IdentityEvidence } from '../account/model.js';
import type { AccountService } from '../account/service.js';
import type { SmsProvider } from '../account/sms-provider.js';
import type { WhatsAppProvider } from '../account/whatsapp-provider.js';
import { OtpService } from '../lib/otp-service.js';
import type { Mailer } from '../lib/mailer.js';
import { otpEmailHtml, otpEmailText } from '../lib/mailer.js';
import { normalizeEmail, normalizePan, buildE164, isValidNamePart, isValidIndianPincode, normalizeCountryCode, isIndianState } from '../lib/validation.js';
import { isSupportedCallingCode } from '../lib/dialling-plans.js';
import type { IdentityVerificationProvider } from '../services/identity-provider-types.js';
import type { AadhaarOcrProvider } from '../services/aadhaar-ocr-provider.js';
import type { PincodeProvider } from '../services/pincode-provider.js';
import type { GeocodingProvider } from '../services/geocoding-provider.js';
import type { DisposableEmailChecker } from '../services/disposable-email.js';
import { validatePassportPhoto, type PhotoValidationConfig } from './photo-validator.js';
import type { LivenessService, LivenessEvidenceInput } from './liveness.js';
import {
  type RegistrationSession,
  type RegistrationSessionPatch,
  type RegistrationSessionStore,
  type RegistrationStatus,
  toRegistrationStatus,
} from './session-store.js';

export type RegistrationFailure =
  | { readonly ok: false; readonly reason: 'unavailable'; readonly message?: string }
  | { readonly ok: false; readonly reason: 'bad-state'; readonly message: string }
  | { readonly ok: false; readonly reason: 'invalid-input'; readonly issues: readonly string[] }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'already-registered' }
  | { readonly ok: false; readonly reason: 'provider-error'; readonly message: string }
  | { readonly ok: false; readonly reason: 'mismatch'; readonly message: string };

export type RegistrationResult<T> = { ok: true; value: T } | RegistrationFailure;

const NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,79}$/u;
const AADHAAR_RE = /^\d{12}$/;

export interface RegistrationServiceOptions {
  readonly store: RegistrationSessionStore;
  readonly accounts: AccountService;
  readonly mailer: Mailer | null;
  readonly otp: { readonly hashSecret: string };
  readonly smsProvider: SmsProvider;
  readonly whatsAppProvider: WhatsAppProvider;
  readonly aadhaarProvider: IdentityVerificationProvider | null;
  readonly aadhaarOcr: AadhaarOcrProvider;
  readonly pincodeProvider: PincodeProvider;
  readonly geocodingProvider: GeocodingProvider;
  readonly disposableEmail: DisposableEmailChecker;
  readonly liveness: LivenessService;
  readonly photoConfig?: Partial<PhotoValidationConfig>;
  readonly sessionTtlMs?: number;
  readonly now?: () => number;
}

/**
 * Personal-information input for the first registration step.
 *
 * The name arrives as three SEPARATE parts (first / middle / last) rather than
 * one combined string. `fullName` is still accepted as a legacy fallback so an
 * older client or an in-flight session keeps working; when the parts are
 * present they are authoritative and the service composes `fullName` itself.
 *
 * Nothing in this shape is "verified" by being well-formed: Aadhaar and PAN
 * here are format-checked only. A real provider (when one is configured) is the
 * only thing that can assert authenticity, and the response never claims it.
 */
export interface PersonalDetailsInput {
  readonly firstName?: string;
  readonly middleName?: string;
  readonly lastName?: string;
  /** Legacy combined name. Used only when the parts are absent. */
  readonly fullName?: string;
  readonly aadhaarNumber: string;
  /** Optional PAN. Format-validated when present; never a verification claim. */
  readonly panNumber?: string;
  /** Full free-text address. GPS-resolved or hand-typed, always editable. */
  readonly addressOnAadhaar?: string;
  readonly city?: string;
  readonly state?: string;
  readonly pincode?: string;
  readonly dateOfBirth: string;
  /** Country calling code, e.g. "+91". Defaults to +91 when omitted. */
  readonly mobileCountryCode?: string;
  readonly mobile: string;
}

export interface AadhaarDocumentInput {
  readonly fileName: string;
  readonly data: Buffer;
  readonly mimeType: string;
}

export class RegistrationService {
  private readonly store: RegistrationSessionStore;
  private readonly accounts: AccountService;
  private readonly mailer: Mailer | null;
  private readonly smsOtp: OtpService;
  private readonly whatsappOtp: OtpService;
  private readonly emailOtp: OtpService;
  private readonly smsProvider: SmsProvider;
  private readonly whatsAppProvider: WhatsAppProvider;
  private readonly aadhaarProvider: IdentityVerificationProvider | null;
  private readonly aadhaarOcr: AadhaarOcrProvider;
  private readonly pincodeProvider: PincodeProvider;
  private readonly geocodingProvider: GeocodingProvider;
  private readonly disposableEmail: DisposableEmailChecker;
  private readonly liveness: LivenessService;
  private readonly photoConfig: Partial<PhotoValidationConfig>;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;

  constructor(options: RegistrationServiceOptions) {
    this.store = options.store;
    this.accounts = options.accounts;
    this.mailer = options.mailer;
    this.smsProvider = options.smsProvider;
    this.whatsAppProvider = options.whatsAppProvider;
    this.aadhaarProvider = options.aadhaarProvider;
    this.aadhaarOcr = options.aadhaarOcr;
    this.pincodeProvider = options.pincodeProvider;
    this.geocodingProvider = options.geocodingProvider;
    this.disposableEmail = options.disposableEmail;
    this.liveness = options.liveness;
    this.photoConfig = options.photoConfig ?? {};
    this.sessionTtlMs = options.sessionTtlMs ?? 2 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.smsOtp = new OtpService({ hashSecret: options.otp.hashSecret, now: options.now });
    this.whatsappOtp = new OtpService({ hashSecret: options.otp.hashSecret, now: options.now });
    this.emailOtp = new OtpService({ hashSecret: options.otp.hashSecret, now: options.now });
  }

  get smsConfigured(): boolean {
    return this.smsProvider.configured;
  }

  get whatsappConfigured(): boolean {
    return this.whatsAppProvider.configured;
  }

  get emailConfigured(): boolean {
    return this.mailer !== null;
  }

  get aadhaarOcrConfigured(): boolean {
    return this.aadhaarOcr.configured;
  }

  get aadhaarMobileConfigured(): boolean {
    return this.aadhaarProvider?.available === true;
  }

  get pincodeConfigured(): boolean {
    return this.pincodeProvider.configured;
  }

  get geocodingConfigured(): boolean {
    return this.geocodingProvider.configured;
  }

  /** Capabilities echoed to the registration UI so steps can fail honestly. */
  get capabilities(): {
    smsConfigured: boolean;
    whatsappConfigured: boolean;
    emailConfigured: boolean;
    aadhaarOcrConfigured: boolean;
    aadhaarMobileConfigured: boolean;
    pincodeConfigured: boolean;
    geocodingConfigured: boolean;
  } {
    return {
      smsConfigured: this.smsConfigured,
      whatsappConfigured: this.whatsappConfigured,
      emailConfigured: this.emailConfigured,
      aadhaarOcrConfigured: this.aadhaarOcrConfigured,
      aadhaarMobileConfigured: this.aadhaarMobileConfigured,
      pincodeConfigured: this.pincodeConfigured,
      geocodingConfigured: this.geocodingConfigured,
    };
  }

  // ── Session lifecycle ────────────────────────────────────────────

  /**
   * Start a new registration session. Registration is wallet-free: the account
   * is created WITHOUT a wallet, and the Midnight wallet is associated later
   * via the authenticated wallet-association flow (after a successful login).
   * The session is tracked purely by the `priestate_reg_sid` cookie.
   */
  begin(): RegistrationResult<{ token: string; expiresAt: number }> {
    const sessionToken = randomBytes(32).toString('hex');
    const now = this.now();
    const session: RegistrationSession = {
      sessionToken,
      walletAddress: null,
      personalPiiCipherText: null,
      personalCompletedAt: null,
      maskedMobile: null,
      maskedAadhaar: null,
      aadhaarOcrCipherText: null,
      aadhaarDocumentStatus: 'unverified',
      aadhaarDocumentExtractedAt: null,
      emailVerified: false,
      emailVerifiedAt: null,
      smsOtpVerified: false,
      smsOtpVerifiedAt: null,
      whatsappOtpVerified: false,
      whatsappOtpVerifiedAt: null,
      aadhaarMobileLinked: false,
      aadhaarMobileLinkedAt: null,
      passwordHash: null,
      passwordSalt: null,
      photoStatus: 'unverified',
      photoContentHash: null,
      livenessPassed: false,
      livenessPassedAt: null,
      locationAccepted: false,
      locationAcceptedAt: null,
      finalizedAt: null,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    };
    this.store.create(session);
    return { ok: true, value: { token: sessionToken, expiresAt: session.expiresAt } };
  }

  status(token: string): RegistrationStatus | null {
    const session = this.loadActive(token);
    if (!session) return null;
    const maskedEmail = this.maskedEmailOf(session);
    return toRegistrationStatus(session, maskedEmail);
  }

  // ── Personal details + pincode ──────────────────────────────────
  //
  // This is PHASE 1 of the two-phase personal step. It validates and stores the
  // encrypted PII record only; the step is NOT complete yet. `personalVerified`
  // is additionally gated on a verified phone number (see toRegistrationStatus),
  // so the citizen must confirm the number over SMS or WhatsApp before the
  // stepper can advance. `completePersonal()` is the explicit phase-2 gate the
  // Continue button calls.

  async personal(token: string, input: PersonalDetailsInput): Promise<RegistrationResult<RegistrationStatus>> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };

    const issues: string[] = [];

    // ── Name: three parts, first + last required, middle optional ──
    const firstName = (input.firstName ?? '').trim().replace(/\s+/g, ' ');
    const middleName = (input.middleName ?? '').trim().replace(/\s+/g, ' ');
    const lastName = (input.lastName ?? '').trim().replace(/\s+/g, ' ');
    const legacyFullName = (input.fullName ?? '').trim().replace(/\s+/g, ' ');

    let fullName: string;
    if (firstName || lastName) {
      if (!isValidNamePart(firstName)) issues.push('Enter a valid first name.');
      if (middleName && !isValidNamePart(middleName)) issues.push('Enter a valid middle name.');
      if (!isValidNamePart(lastName)) issues.push('Enter a valid last name.');
      // Composed once, here, so the Aadhaar-OCR name match keeps comparing
      // against exactly one canonical string (unchanged behaviour downstream).
      fullName = [firstName, middleName, lastName].filter(Boolean).join(' ');
    } else if (legacyFullName) {
      // Legacy client: accept the combined name, still validated the old way.
      if (!NAME_RE.test(legacyFullName)) issues.push('Enter a valid full name.');
      fullName = legacyFullName;
    } else {
      issues.push('Enter your first and last name.');
      fullName = '';
    }

    const aadhaarNumber = input.aadhaarNumber.replace(/\s/g, '');
    if (!AADHAAR_RE.test(aadhaarNumber)) issues.push('Aadhaar must be exactly 12 digits.');

    // PAN is optional. When supplied it must be well-formed, but a valid FORMAT
    // is never reported to the citizen as "PAN verified".
    const panRaw = (input.panNumber ?? '').trim();
    const pan = panRaw ? normalizePan(panRaw) : null;
    if (panRaw && pan === null) issues.push('Enter a valid PAN (e.g. ABCDE1234F).');

    const addressOnAadhaar = (input.addressOnAadhaar ?? '').trim();
    if (addressOnAadhaar.length > 200) issues.push('Address must be 200 characters or fewer.');

    const city = (input.city ?? '').trim();
    if (city.length > 80) issues.push('City must be 80 characters or fewer.');

    const state = (input.state ?? '').trim();
    if (state.length > 80) issues.push('State must be 80 characters or fewer.');
    else if (state && !isIndianState(state)) issues.push('Select a valid Indian state or union territory.');

    const pincode = (input.pincode ?? '').trim();
    if (pincode && !isValidIndianPincode(pincode)) issues.push('Enter a valid 6-digit pincode.');

    const dateOfBirth = input.dateOfBirth.trim();
    if (!model.isValidPastDate(dateOfBirth)) issues.push('Enter a valid past date of birth.');

    // The country code is captured explicitly and the number is validated
    // against that country's dialling plan, so the stored E.164 always matches
    // what the citizen dialled. A number is never silently re-mapped onto
    // another country's plan.
    const countryCodeRaw = (input.mobileCountryCode ?? '').trim() || '+91';
    const countryCode = normalizeCountryCode(countryCodeRaw);
    if (countryCode === null) {
      issues.push('Enter a valid country code.');
    } else if (!isSupportedCallingCode(countryCode)) {
      issues.push('That country code is not supported.');
    }
    const mobileE164 = buildE164(countryCodeRaw, input.mobile) ?? '';
    if (!mobileE164 && issues.length === 0) {
      issues.push(`Enter a valid ${countryCode ?? countryCodeRaw} phone number.`);
    }

    if (issues.length > 0) return { ok: false, reason: 'invalid-input', issues };

    // REAL pincode validation: the server queries India Post; an unavailable
    // upstream or a non-Indian pincode FAILS CLOSED (never silently accepted).
    // The provider retries transient upstream failures internally, so this
    // branch only fires when the upstream is genuinely unreachable.
    if (pincode) {
      const lookup = await this.pincodeProvider.lookup(pincode);
      if (!lookup.ok) {
        console.warn(
          `[priestate] registration personal: pincode could not be verified against India Post (provider=${this.pincodeProvider.name}, reason=${lookup.reason}) — failing closed.`,
        );
        return { ok: false, reason: 'provider-error', message: 'Pincode verification is temporarily unavailable. Please try again shortly.' };
      }
      if (!lookup.info.valid) {
        return { ok: false, reason: 'mismatch', message: 'That pincode could not be verified against India Post.' };
      }
    }

    // Encrypted at rest. No field here is ever written to a public ledger, and
    // the PIN is never logged (the old warn line printed it; that is removed).
    const profileCipher = this.accounts.encryptAtRest({
      fullName,
      firstName: firstName || undefined,
      middleName: middleName || undefined,
      lastName: lastName || undefined,
      aadhaarNumber,
      panNumber: pan ?? undefined,
      addressOnAadhaar: addressOnAadhaar || undefined,
      city: city || undefined,
      state: state || undefined,
      pincode: pincode || undefined,
      dateOfBirth,
      mobileE164,
    });
    if (!profileCipher) return { ok: false, reason: 'unavailable', message: 'Registration is unavailable right now.' };

    // Mask on the CALLING CODE, not a fixed character count: "+91…10" and
    // "+44…56" and "+971…78" are all legitimate, and truncating "+971" to "+97"
    // would display a country code the citizen never dialled.
    const maskedMobile = `${countryCode ?? '+91'}••••${mobileE164.slice(-2)}`;
    const now = this.now();
    const patch: RegistrationSessionPatch = {
      personalPiiCipherText: profileCipher,
      maskedMobile,
      maskedAadhaar: maskAadhaar(aadhaarNumber),
      // Editing the details invalidates any earlier phone confirmation: the
      // number may have changed, so both channels must be proven again. It also
      // revokes the Continue the citizen had already given.
      smsOtpVerified: false,
      smsOtpVerifiedAt: null,
      whatsappOtpVerified: false,
      whatsappOtpVerifiedAt: null,
      personalCompletedAt: null,
    };
    const updated = this.store.update(token, patch) ?? session;
    return { ok: true, value: this.snapshot(updated, now) };
  }

  /**
   * PHASE 2 of the personal step: the explicit gate the Continue button calls.
   *
   * Refuses until the stored phone number has been confirmed over a REAL
   * channel (SMS or WhatsApp — either satisfies it). This is what makes the
   * Continue button server-authoritative rather than a client-side fiction.
   */
  completePersonal(token: string): RegistrationResult<RegistrationStatus> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (!session.personalPiiCipherText || !session.maskedMobile) {
      return { ok: false, reason: 'bad-state', message: 'Complete personal details first.' };
    }
    if (!session.smsOtpVerified && !session.whatsappOtpVerified) {
      return {
        ok: false,
        reason: 'bad-state',
        message: 'Verify your phone number over SMS or WhatsApp before continuing.',
      };
    }
    // Durable, so the advance survives a reload and cannot be replayed by a
    // client that simply stops asking. Editing the details clears it again.
    const completed = this.store.update(token, { personalCompletedAt: this.now() }) ?? session;
    return { ok: true, value: this.snapshot(completed, this.now()) };
  }

  /**
   * Reverse-geocode a coordinate pair into an address the citizen can edit.
   *
   * Coordinates are used ONLY to derive a starting address — they are never
   * stored, never returned to the client as coordinates, and never placed on a
   * public ledger. The raw GPS pair stays in this request.
   */
  async reverseGeocode(
    token: string,
    lat: number,
    lng: number,
  ): Promise<RegistrationResult<{ address: string; city: string; state: string; pincode: string }>> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { ok: false, reason: 'invalid-input', issues: ['That location could not be read.'] };
    }
    if (!this.geocodingProvider.configured) {
      return { ok: false, reason: 'unavailable', message: 'Address lookup is temporarily unavailable. Enter your address manually.' };
    }
    // Street-level zoom: a postal address form needs the road/landmark parts and
    // the postcode, neither of which the settlement-level default returns.
    const outcome = await this.geocodingProvider.reverse(lat, lng, 18);
    if (!outcome.ok) {
      return { ok: false, reason: 'provider-error', message: 'That address could not be resolved. Enter it manually.' };
    }
    return {
      ok: true,
      value: {
        address: outcome.displayName ?? '',
        // Prefer the settlement itself; `district` names the enclosing ward.
        city: outcome.city ?? outcome.district ?? '',
        state: outcome.state ?? '',
        pincode: outcome.postcode ?? '',
      },
    };
  }

  // ── Aadhaar document OCR (real provider) ─────────────────────────

  async aadhaarDocument(token: string, input: AadhaarDocumentInput): Promise<RegistrationResult<{ status: 'verified' }>> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (!session.personalPiiCipherText) {
      return { ok: false, reason: 'bad-state', message: 'Complete personal details first.' };
    }
    if (!this.aadhaarOcr.configured) {
      return { ok: false, reason: 'unavailable', message: 'Identity document verification is temporarily unavailable. Please try again later.' };
    }
    const profile = this.decryptProfile(session);
    if (!profile) return { ok: false, reason: 'bad-state', message: 'Personal details could not be read.' };

    const ocr = await this.aadhaarOcr.ocr(input.fileName, input.data, input.mimeType);
    if (!ocr.ok) {
      if (ocr.reason === 'unconfigured') {
        return { ok: false, reason: 'unavailable', message: 'Identity document verification is temporarily unavailable. Please try again later.' };
      }
      return { ok: false, reason: 'provider-error', message: 'The document could not be read. Upload a clear photo of your Aadhaar.' };
    }
    const ext = ocr.extraction;
    if (!ext.fullName) return { ok: false, reason: 'provider-error', message: 'The document could not be read clearly.' };
    if (normalizeName(ext.fullName) !== normalizeName(profile.fullName)) {
      return {
        ok: false,
        reason: 'mismatch',
        message: 'The name on the document does not match the name you entered. Re-enter or upload the matching Aadhaar.',
      };
    }

    const ocrCipher = this.accounts.encryptAtRest(ext);
    if (!ocrCipher) return { ok: false, reason: 'unavailable', message: 'Registration is unavailable right now.' };
    const now = this.now();
    this.store.update(token, {
      aadhaarOcrCipherText: ocrCipher,
      aadhaarDocumentStatus: 'verified',
      aadhaarDocumentExtractedAt: now,
    });
    return { ok: true, value: { status: 'verified' } };
  }

  // ── Email ────────────────────────────────────────────────────────

  async submitEmail(token: string, emailRaw: string): Promise<RegistrationResult<{ maskedEmail: string }>> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    const email = normalizeEmail(emailRaw);
    if (!email) return { ok: false, reason: 'invalid-input', issues: ['Enter a valid email address.'] };
    const disposable = this.disposableEmail.check(email);
    if (disposable.blocked) {
      return { ok: false, reason: 'invalid-input', issues: ['Disposable email addresses are not accepted.'] };
    }
    if (!this.mailer) return { ok: false, reason: 'unavailable', message: 'Email confirmation is temporarily unavailable. Please try again later.' };

    // Persist the address inside the encrypted profile (never in the clear).
    const profile = this.decryptProfile(session);
    if (!profile) return { ok: false, reason: 'bad-state', message: 'Complete personal details first.' };
    const updatedProfile: typeof profile = { ...profile, email: email.toLowerCase() };
    const cipher = this.accounts.encryptAtRest(updatedProfile);
    if (!cipher) return { ok: false, reason: 'unavailable' };

    const issued = this.emailOtp.beginIssue(OtpService.keyFor('reg-email', session.sessionToken));
    if (!issued.ok) {
      return {
        ok: false,
        reason: issued.reason === 'cooldown' ? 'bad-state' : 'provider-error',
        message: issued.reason === 'cooldown' ? 'Please wait before requesting another code.' : 'Too many codes requested. Try again later.',
      };
    }

    try {
      await this.mailer.send({
        to: email,
        subject: 'PRIESTATE verification code',
        text: otpEmailText(issued.code, Math.max(1, Math.round(this.emailOtp.ttlMs / 60_000))),
        html: otpEmailHtml(issued.code, Math.max(1, Math.round(this.emailOtp.ttlMs / 60_000))),
      });
    } catch {
      return { ok: false, reason: 'provider-error', message: 'Could not send the verification email. Try again shortly.' };
    }
    const committed = this.emailOtp.commitIssue(
      OtpService.keyFor('reg-email', session.sessionToken),
      issued.code,
      issued.expiresAt,
    );
    if (!committed.ok) return { ok: false, reason: 'provider-error', message: 'Too many codes requested. Try again later.' };

    this.store.update(token, {
      personalPiiCipherText: cipher,
      emailVerified: false,
      emailVerifiedAt: null,
    });
    return { ok: true, value: { maskedEmail: maskEmail(email) } };
  }

  verifyEmailOtp(token: string, code: string): RegistrationResult<{ emailVerified: boolean }> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    const key = OtpService.keyFor('reg-email', session.sessionToken);
    const result = this.emailOtp.verify(key, code);
    if (!result.ok) {
      if (result.reason === 'invalid') {
        return { ok: false, reason: 'invalid-input', issues: ['That code is incorrect. Try again.'] };
      }
      return { ok: false, reason: 'bad-state', message: 'That code expired or was used too many times. Request a new one.' };
    }
    const now = this.now();
    this.store.update(token, { emailVerified: true, emailVerifiedAt: now });
    return { ok: true, value: { emailVerified: true } };
  }

  // ── SMS + WhatsApp OTP (delivery via REAL adapters) ──────────────

  async issueSmsOtp(token: string): Promise<RegistrationResult<{ delivered: boolean }>> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (!session.personalPiiCipherText || !session.maskedMobile) {
      return { ok: false, reason: 'bad-state', message: 'Complete personal details first.' };
    }
    if (!this.smsProvider.configured) return { ok: false, reason: 'unavailable', message: 'Mobile confirmation is temporarily unavailable. Please try again later.' };
    const profile = this.decryptProfile(session);
    if (!profile) return { ok: false, reason: 'bad-state', message: 'Complete personal details first.' };

    const key = OtpService.keyFor('reg-sms', session.sessionToken);
    const begun = this.smsOtp.beginIssue(key);
    if (!begun.ok) {
      return { ok: false, reason: 'provider-error', message: begun.reason === 'cooldown' ? 'Please wait before requesting another code.' : 'Too many codes requested. Try again later.' };
    }
    const delivery = await this.smsProvider.send(profile.mobileE164, begun.code);
    if (!delivery.ok) return { ok: false, reason: 'provider-error', message: 'The code could not be delivered. Try again shortly.' };
    const committed = this.smsOtp.commitIssue(key, begun.code, begun.expiresAt);
    if (!committed.ok) return { ok: false, reason: 'provider-error', message: 'Too many codes requested. Try again later.' };
    return { ok: true, value: { delivered: true } };
  }

  verifySmsOtp(token: string, code: string): RegistrationResult<{ smsOtpVerified: boolean }> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    const result = this.smsOtp.verify(OtpService.keyFor('reg-sms', session.sessionToken), code);
    if (!result.ok) return this.otpVerifyFailure(result.reason);
    const now = this.now();
    this.store.update(token, { smsOtpVerified: true, smsOtpVerifiedAt: now });
    return { ok: true, value: { smsOtpVerified: true } };
  }

  async issueWhatsappOtp(token: string): Promise<RegistrationResult<{ delivered: boolean }>> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (!session.personalPiiCipherText || !session.maskedMobile) {
      return { ok: false, reason: 'bad-state', message: 'Complete personal details first.' };
    }
    if (!this.whatsAppProvider.configured) return { ok: false, reason: 'unavailable', message: 'Confirmation by WhatsApp is temporarily unavailable. Please try again later.' };
    const profile = this.decryptProfile(session);
    if (!profile) return { ok: false, reason: 'bad-state', message: 'Complete personal details first.' };

    const key = OtpService.keyFor('reg-whatsapp', session.sessionToken);
    const begun = this.whatsappOtp.beginIssue(key);
    if (!begun.ok) {
      return { ok: false, reason: 'provider-error', message: begun.reason === 'cooldown' ? 'Please wait before requesting another code.' : 'Too many codes requested. Try again later.' };
    }
    const delivery = await this.whatsAppProvider.send(profile.mobileE164, begun.code);
    if (!delivery.ok) return { ok: false, reason: 'provider-error', message: 'The code could not be delivered. Try again shortly.' };
    const committed = this.whatsappOtp.commitIssue(key, begun.code, begun.expiresAt);
    if (!committed.ok) return { ok: false, reason: 'provider-error', message: 'Too many codes requested. Try again later.' };
    return { ok: true, value: { delivered: true } };
  }

  verifyWhatsappOtp(token: string, code: string): RegistrationResult<{ whatsappOtpVerified: boolean }> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    const result = this.whatsappOtp.verify(OtpService.keyFor('reg-whatsapp', session.sessionToken), code);
    if (!result.ok) return this.otpVerifyFailure(result.reason);
    const now = this.now();
    this.store.update(token, { whatsappOtpVerified: true, whatsappOtpVerifiedAt: now });
    return { ok: true, value: { whatsappOtpVerified: true } };
  }

  // ── Aadhaar-mobile linkage (authorized KYC provider) ─────────────

  async aadhaarMobileStart(
    token: string,
  ): Promise<
    | { ok: true; value: { mode: 'verified' } | { mode: 'otp-challenge'; sessionId: string; expiresAt: number } }
    | RegistrationFailure
  > {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (!session.personalPiiCipherText) return { ok: false, reason: 'bad-state', message: 'Complete personal details first.' };
    if (!this.aadhaarProvider) return { ok: false, reason: 'unavailable', message: 'This check is temporarily unavailable. Please try again later.' };
    const profile = this.decryptProfile(session);
    if (!profile) return { ok: false, reason: 'bad-state', message: 'Personal details could not be read.' };
    const result = await this.aadhaarProvider.startAadhaarMobileVerification(profile.mobileE164);
    if (!result.ok) {
      return { ok: false, reason: 'provider-error', message: result.message ?? 'The identity provider could not be reached. Try again.' };
    }
    if (result.mode === 'verified') {
      const now = this.now();
      this.store.update(token, { aadhaarMobileLinked: true, aadhaarMobileLinkedAt: now });
      return { ok: true, value: { mode: 'verified' } };
    }
    if (result.mode === 'not-linked') {
      return { ok: false, reason: 'mismatch', message: 'This mobile number is not linked to an Aadhaar record.' };
    }
    return { ok: true, value: { mode: 'otp-challenge', sessionId: result.session.id, expiresAt: result.session.expiresAt } };
  }

  async aadhaarMobileComplete(
    token: string,
    input: { sessionId: string; code: string },
  ): Promise<RegistrationResult<{ aadhaarMobileLinked: boolean }>> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (!this.aadhaarProvider) return { ok: false, reason: 'unavailable', message: 'This check is temporarily unavailable. Please try again later.' };
    const result = await this.aadhaarProvider.verifyAadhaarMobileVerification(input);
    if (!result.ok) {
      return { ok: false, reason: 'provider-error', message: result.message ?? 'The verification could not be completed. Try again.' };
    }
    if (result.mode !== 'verified') {
      return { ok: false, reason: 'mismatch', message: 'The identity provider reports this mobile is not linked to an Aadhaar.' };
    }
    const now = this.now();
    this.store.update(token, { aadhaarMobileLinked: true, aadhaarMobileLinkedAt: now });
    return { ok: true, value: { aadhaarMobileLinked: true } };
  }

  // ── Password ─────────────────────────────────────────────────────

  setPassword(
    token: string,
    input: { password: string; confirm: string },
  ): RegistrationResult<{ passwordSet: boolean }> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    const profile = this.decryptProfile(session);
    const issues = passwordIssues(input.password, {
      mobile: profile?.mobileE164 ?? '',
      aadhaarNumber: profile?.aadhaarNumber ?? '',
      fullName: profile?.fullName ?? '',
    });
    const withMeta = issues.map((issue) => `Password needs ${issue}.`);
    if (input.password !== input.confirm) withMeta.push('Passwords do not match.');
    if (withMeta.length > 0) return { ok: false, reason: 'invalid-input', issues: withMeta };
    const { hash, salt } = hashPassword(input.password);
    this.store.update(token, { passwordHash: hash, passwordSalt: salt });
    return { ok: true, value: { passwordSet: true } };
  }

  // ── Photo validation (server-side) ───────────────────────────────

  photo(token: string, data: Buffer): RegistrationResult<{ photoStatus: 'verified' }> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    const result = validatePassportPhoto(data, this.photoConfig);
    if (!result.ok) {
      const reason: 'invalid-input' | 'provider-error' = 'invalid-input';
      return {
        ok: false,
        reason,
        issues: [this.photoIssueMessage(result.reason)],
      };
    }
    const hash = createHash('sha256').update(data).digest('hex');
    this.store.update(token, {
      photoStatus: 'verified',
      photoContentHash: hash,
    });
    return { ok: true, value: { photoStatus: 'verified' } };
  }

  // ── Liveness (server-issued challenges) ──────────────────────────

  livenessStart(token: string): RegistrationResult<{ challenges: readonly import('./liveness.js').LivenessChallenge[]; expiresInMs: number }> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (session.livenessPassed) {
      return { ok: false, reason: 'bad-state', message: 'Liveness was already completed.' };
    }
    const started = this.liveness.start(token);
    return { ok: true, value: { challenges: started.challenges, expiresInMs: started.expiresInMs } };
  }

  livenessEvidence(
    token: string,
    input: LivenessEvidenceInput,
  ): RegistrationResult<{ progress: import('./liveness.js').LivenessProgress; livenessPassed: boolean }> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    const result = this.liveness.evidence(token, input);
    if (!result.ok) {
      const message = this.livenessMessage(result.verdict ?? 'invalid');
      return { ok: false, reason: message === 'Retry the current challenge.' ? 'bad-state' : 'mismatch', message };
    }
    if (result.progress.done) {
      const now = this.now();
      this.store.update(token, { livenessPassed: true, livenessPassedAt: now });
    }
    return { ok: true, value: { progress: result.progress, livenessPassed: result.progress.done } };
  }

  // ── Location evidence (server-scoped) ────────────────────────────

  async location(token: string, evidence: unknown): Promise<RegistrationResult<{ locationAccepted: boolean }>> {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    // Requirement 18: live location is accepted ONLY after real server-side
    // liveness has completed — the client's evidence flag is never trusted.
    if (!session.livenessPassed) {
      return { ok: false, reason: 'bad-state', message: 'Complete liveness verification first.' };
    }
    const denial = rejectIdentityEvidence(evidence as IdentityEvidence | null | undefined, this.now());
    if (denial) {
      return { ok: false, reason: 'invalid-input', issues: ['Location evidence was rejected. Enable permission and try again.'] };
    }
    const ev = evidence as IdentityEvidence;
    const geo = await this.geocodingProvider.reverse(
      ev.location.latitude ?? 0,
      ev.location.longitude ?? 0,
    );
    if (!geo.ok) {
      return { ok: false, reason: 'provider-error', message: 'Location verification is unavailable. Try again shortly.' };
    }
    if ((geo.country ?? '').trim().toLowerCase() !== 'india') {
      return { ok: false, reason: 'mismatch', message: 'Registration is only available from within India.' };
    }
    const now = this.now();
    this.store.update(token, { locationAccepted: true, locationAcceptedAt: now });
    return { ok: true, value: { locationAccepted: true } };
  }

  // ── Finalize ─────────────────────────────────────────────────────

  finalize(
    token: string,
  ):
    | { ok: true; value: { accountId: string; walletAddress: string | null } }
    | RegistrationFailure {
    const session = this.mustLoad(token);
    if (session === null) return { ok: false, reason: 'not-found' };
    const missing: string[] = [];
    if (!session.personalPiiCipherText) missing.push('Personal details');
    if (session.aadhaarDocumentStatus !== 'verified') missing.push('Aadhaar document');
    if (!session.emailVerified) missing.push('Email');
    // Phone is EITHER-or: one real channel (SMS or WhatsApp) is enough. The
    // citizen picks their method; we never require both.
    if (!session.smsOtpVerified && !session.whatsappOtpVerified) missing.push('Phone verification');
    if (!session.aadhaarMobileLinked) missing.push('Aadhaar-mobile link');
    if (!session.passwordHash || !session.passwordSalt) missing.push('Password');
    if (session.photoStatus !== 'verified') missing.push('Photo');
    if (!session.livenessPassed) missing.push('Liveness');
    if (!session.locationAccepted) missing.push('Location');
    if (missing.length > 0) {
      return { ok: false, reason: 'bad-state', message: `Complete ${missing.join(', ')} before finishing.` };
    }

    const evidenceAcceptedAt = Math.max(session.livenessPassedAt ?? 0, session.locationAcceptedAt ?? 0, session.createdAt);
    const created = this.accounts.createAccountFromFinalizedRegistration({
      walletAddress: null,
      piiCipherText: session.personalPiiCipherText!,
      maskedMobile: session.maskedMobile ?? '',
      maskedAadhaar: session.maskedAadhaar ?? '',
      passwordHash: session.passwordHash!,
      passwordSalt: session.passwordSalt!,
      emailVerified: session.emailVerified,
      emailVerifiedAt: session.emailVerifiedAt,
      identityEvidenceAcceptedAt: evidenceAcceptedAt,
    });
    if (!created.ok) {
      if (created.reason === 'already-registered') {
        this.store.destroy(token);
        return { ok: false, reason: 'already-registered' };
      }
      return { ok: false, reason: 'unavailable', message: 'Registration could not be completed right now.' };
    }
    const now = this.now();
    this.store.update(token, { finalizedAt: now });
    return {
      ok: true,
      value: {
        accountId: created.ok && 'view' in created ? created.view.accountId : '',
        walletAddress: null,
      },
    };
  }

  purgeExpired(now: number): number {
    this.liveness.sweep(now);
    return this.store.purgeExpired(now);
  }

  // ── internals ────────────────────────────────────────────────────

  private mustLoad(token: string): RegistrationSession | null {
    const session = this.store.get(token);
    if (!session) return null;
    if (session.expiresAt < this.now()) {
      this.store.destroy(token);
      return null;
    }
    return session;
  }

  private loadActive(token: string): RegistrationSession | null {
    return this.mustLoad(token);
  }

  private decryptProfile(session: RegistrationSession): { fullName: string; aadhaarNumber: string; addressOnAadhaar?: string; pincode?: string; dateOfBirth: string; mobileE164: string; email?: string } | null {
    if (!session.personalPiiCipherText) return null;
    const decoded = this.accounts.decryptAtRest(session.personalPiiCipherText);
    if (!decoded || typeof decoded !== 'object') return null;
    const p = decoded as Record<string, unknown>;
    if (typeof p.fullName !== 'string' || typeof p.aadhaarNumber !== 'string' || typeof p.dateOfBirth !== 'string' || typeof p.mobileE164 !== 'string') {
      return null;
    }
    return {
      fullName: p.fullName,
      aadhaarNumber: p.aadhaarNumber,
      addressOnAadhaar: typeof p.addressOnAadhaar === 'string' ? p.addressOnAadhaar : undefined,
      pincode: typeof p.pincode === 'string' ? p.pincode : undefined,
      dateOfBirth: p.dateOfBirth,
      mobileE164: p.mobileE164,
      email: typeof p.email === 'string' ? p.email : undefined,
    };
  }

  private maskedEmailOf(session: RegistrationSession): string | null {
    const profile = this.decryptProfile(session);
    if (!profile?.email) return null;
    return maskEmail(profile.email);
  }

  private snapshot(session: RegistrationSession, _now: number): RegistrationStatus {
    void _now;
    const maskedEmail = this.maskedEmailOf(session);
    return toRegistrationStatus(session, maskedEmail)!;
  }

  private otpVerifyFailure(reason: string): RegistrationFailure {
    if (reason === 'invalid') {
      return { ok: false, reason: 'invalid-input', issues: ['That code is incorrect. Try again.'] };
    }
    return { ok: false, reason: 'bad-state', message: 'That code expired or was used too many times. Request a new one.' };
  }

  private photoIssueMessage(reason: 'too-large' | 'not-png' | 'dimensions' | 'background' | 'aspect' | 'subject'): string {
    switch (reason) {
      case 'too-large':
        return 'The photo file is too large. Capture a smaller portrait.';
      case 'not-png':
        return 'The submitted photo was not a valid PNG. Use the camera step to capture one.';
      case 'dimensions':
        return 'The photo must be between 300×300 and 2048×2048 pixels.';
      case 'background':
        return 'The photo background is not uniform white. Use the background-removal step.';
      case 'aspect':
        return 'The photo must be near-square (passport crop).';
      case 'subject':
        return 'The subject must occupy 2%–70% of the frame. Center your face.';
    }
  }

  private livenessMessage(verdict: string): string {
    switch (verdict) {
      case 'phrase-mismatch':
        return 'The spoken phrase did not match. Try again.';
      case 'count-mismatch':
        return 'The finger count did not match. Try again.';
      case 'wrong-order':
        return 'Complete the current challenge first.';
      case 'duplicate':
        return 'That challenge was already completed.';
      case 'expired':
        return 'The liveness session expired. Start it again.';
      case 'not-started':
        return 'Start the liveness session first.';
      default:
        return 'Retry the current challenge.';
    }
  }
}

/** Normalize a name for OCR-vs-entered comparison. */
function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z]+/g, '');
}