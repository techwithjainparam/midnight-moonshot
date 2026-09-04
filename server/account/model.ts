// PRIESTATE — Server-side user account model + validation.
//
// ⚠️ SERVER-SIDE ONLY. Runs inside the Node process; never bundled into the
// browser. Defines what a Level 3 user account holds and, crucially, WHAT IT
// NEVER HOLDS:
//
//   * password — stored ONLY as a salted scrypt hash (see security.ts),
//   * Aadhaar number / Aadhaar image / DOB / address / pincode / mobile — NEVER
//     stored in plaintext; merged into an encrypted-at-rest PII blob
//     (AES-256-GCM), or retained only as masked public-safe display fragments,
//   * OTP codes — never stored at all (OtpService keeps only HMAC hashes),
//   * passport photo / selfie / biometrics — never persisted server-side or
//     on-chain; the browser performs a clearly-labelled DEMO match and stores
//     only a boolean verification flag.
//
// Nothing here ever reaches the Midnight ledger. On-chain records carry NO
// PII; they reference an account by a random non-PII accountId.

import { normalizeIndianMobile } from '../lib/validation.js';

// Re-exported for convenience by account tests / callers.
export { normalizeIndianMobile } from '../lib/validation.js';

export const ACCOUNT_PII_VERSION = 1 as const;

/** Sensitive PII delivered to the server for encrypted-at-rest storage. */
export interface AccountPiiInput {
  readonly fullName: string;
  readonly aadhaarNumber: string;
  readonly addressOnAadhaar?: string;
  readonly pincode?: string;
  readonly dateOfBirth: string; // ISO yyyy-mm-dd
  readonly mobileE164: string;
}

/** Public-safe projection of an account (what the browser/server may expose). */
export interface PublicAccountView {
  readonly accountId: string;
  readonly status:
    | 'registered'
    | 'sms_otp_pending'
    | 'whatsapp_otp_pending'
    | 'google_pending'
    | 'identity_verified';
  readonly walletAddress: string;
  readonly fullName?: string;
  /** Masked mobile, e.g. +91 98••••••10 — never the full number. */
  readonly maskedMobile: string;
  /** Masked Aadhaar, e.g. •••• 4321 — never the full number. */
  readonly maskedAadhaar: string;
  readonly smsOtpVerified: boolean;
  readonly whatsappOtpVerified: boolean;
  readonly googleLinked: boolean;
  readonly identityVerified: boolean;
  readonly createdAt: number;
}

/**
 * Server-authoritative LOGIN FACE-VERIFICATION stage snapshot (Level 3 Part 6).
 * This is the SECOND, subsequent identity stage on top of the five-factor
 * login. It is SEPARATE from liveness and NEVER self-affirmed by the client.
 * The current build ships no real CV provider and stores no biometric
 * reference, so `providerAvailable` and `hasReferenceIdentity` are always
 * false. Only a genuine provider + a registered reference in a secure
 * private boundary can set these — never a client boolean.
 */
export interface FaceVerificationSnapshot {
  /** Login cannot complete without this subsequent identity stage. */
  readonly required: boolean;
  /** True only when a real computer-vision provider is available. */
  readonly providerAvailable: boolean;
  /** True only when a legitimate registered reference identity exists. */
  readonly hasReferenceIdentity: boolean;
}

/** The on-disk / in-store account record. */
export interface AccountRecord {
  readonly accountId: string;
  readonly walletAddress: string;
  /** salted scrypt hash — the ONLY representation of the password. */
  readonly passwordHash: string;
  readonly passwordSalt: string;
  /** AES-256-GCM encrypted PII blob (see security.ts). */
  readonly piiCipherText: string;
  readonly maskedMobile: string;
  readonly maskedAadhaar: string;
  readonly smsOtpVerified: boolean;
  readonly whatsappOtpVerified: boolean;
  readonly googleLinked: boolean;
  readonly identityVerified: boolean;
  readonly createdAt: number;
}

/** What the registration endpoint accepts from the browser. */
export interface AccountRegistrationInput {
  readonly walletAddress: string;
  readonly fullName: string;
  readonly aadhaarNumber: string;
  readonly addressOnAadhaar?: string;
  readonly pincode?: string;
  readonly dateOfBirth: string;
  readonly mobile: string;
  readonly password: string;
  readonly passwordConfirm: string;
}

const NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,79}$/u;
const AADHAAR_RE = /^\d{12}$/;
const PINCODE_RE = /^[1-9]\d{5}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Minimum acceptable password length (with diverse characters required). */
export const MIN_PASSWORD_LENGTH = 8;

/** Optional PII context used to reject passwords that reuse personal data. */
export interface PasswordContext {
  mobile?: string;
  aadhaarNumber?: string;
  fullName?: string;
}

/**
 * Validate password strength. Returns a list of unmet requirements; empty
 * means the password is acceptable. Never returns the password itself.
 */
export function passwordIssues(password: string, context: PasswordContext = {}): string[] {
  const issues: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    issues.push(`at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!/[a-z]/.test(password)) issues.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) issues.push('an uppercase letter');
  if (!/[0-9]/.test(password)) issues.push('a number');
  if (!/[^A-Za-z0-9]/.test(password)) issues.push('a symbol');
  if (context.mobile && password.includes(context.mobile)) {
    issues.push('the mobile number');
  }
  if (context.aadhaarNumber && password.includes(context.aadhaarNumber)) {
    issues.push('the Aadhaar number');
  }
  if (context.fullName && password.toLowerCase().includes(context.fullName.toLowerCase().trim())) {
    issues.push('your name');
  }
  return issues;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Validate an ISO yyyy-mm-dd DOB is a real past date (between 1899 and today). */
export function isValidPastDate(iso: string): boolean {
  if (!DATE_RE.test(iso)) return false;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return false;
  }
  return todayIso() >= iso; // must not be in the future
}

/** Mask an Aadhaar number for display: •••• 4321 (always the last 4). */
export function maskAadhaar(aadhaar: string): string {
  const digits = aadhaar.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `•••• ${digits.slice(-4)}`;
}

/**
 * Parse + validate a registration payload on the server. Independent of the
 * client so the browser is never trusted. Returns normalized input or reasons.
 */
export function parseAccountRegistration(
  raw: unknown,
): { ok: true; input: AccountRegistrationInput } | { ok: false; issues: string[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: ['Invalid payload.'] };
  }
  const r = raw as Record<string, unknown>;
  const issues: string[] = [];
  const str = (k: string): string => (typeof r[k] === 'string' ? (r[k] as string).trim() : '');

  const walletAddress = str('walletAddress');
  if (!/^0x[a-fA-F0-9]{64}$/.test(walletAddress)) issues.push('A valid wallet address is required.');

  const fullName = str('fullName');
  if (!NAME_RE.test(fullName)) issues.push('Enter a valid full name (letters, spaces, ., \' or -).');

  const aadhaarNumber = str('aadhaarNumber').replace(/\s/g, '');
  if (!AADHAAR_RE.test(aadhaarNumber)) issues.push('Aadhaar must be exactly 12 digits.');

  const addressOnAadhaar = str('addressOnAadhaar');
  if (addressOnAadhaar && addressOnAadhaar.length > 200) {
    issues.push('Address must be 200 characters or fewer.');
  }

  const pincode = str('pincode');
  if (pincode && !PINCODE_RE.test(pincode)) issues.push('Enter a valid 6-digit pincode.');

  const dateOfBirth = str('dateOfBirth');
  if (!isValidPastDate(dateOfBirth)) issues.push('Enter a valid past date of birth (1900–today).');

  const mobileRaw = str('mobile');
  const mobileE164 = normalizeIndianMobile(mobileRaw);
  if (!mobileE164) issues.push('Enter a valid Indian mobile number.');

  const password = str('password');
  const passwordConfirm = str('passwordConfirm');
  for (const issue of passwordIssues(password, {
    mobile: mobileRaw.replace(/\D/g, ''),
    aadhaarNumber,
    fullName,
  })) issues.push(`Password needs ${issue}.`);

  if (password !== passwordConfirm) issues.push('Passwords do not match.');

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    input: {
      walletAddress,
      fullName,
      aadhaarNumber,
      addressOnAadhaar: addressOnAadhaar || undefined,
      pincode: pincode || undefined,
      dateOfBirth,
      mobile: mobileE164 as string,
      password,
      passwordConfirm,
    },
  };
}

/**
 * Project a stored account record into its PUBLIC (wire) representation.
 * Never exposes the password hash, salt, or the decrypted PII blob — only
 * masked display fragments and booleans.
 */
export function toPublicAccountView(record: AccountRecord): PublicAccountView {
  return {
    accountId: record.accountId,
    status: deriveAccountStatus(record),
    walletAddress: record.walletAddress,
    fullName: undefined,
    maskedMobile: record.maskedMobile,
    maskedAadhaar: record.maskedAadhaar,
    smsOtpVerified: record.smsOtpVerified,
    whatsappOtpVerified: record.whatsappOtpVerified,
    googleLinked: record.googleLinked,
    identityVerified: record.identityVerified,
    createdAt: record.createdAt,
  };
}

function deriveAccountStatus(record: AccountRecord): PublicAccountView['status'] {
  if (record.identityVerified) return 'identity_verified';
  if (!record.googleLinked) return 'google_pending';
  if (!record.smsOtpVerified) return 'sms_otp_pending';
  if (!record.whatsappOtpVerified) return 'whatsapp_otp_pending';
  return 'registered';
}
