// PRIESTATE — User contact & identity profile (FEATURE 1).
//
// The connected Midnight wallet remains the PRIMARY Web3 identity and the
// only authorization identity. Verified contact/identity data is SECONDARY
// — never a replacement for the wallet.
//
// Profile channels:
//   email         — ownership proven via server-issued OTP delivered to
//                   the inbox (real SMTP; see server/services/contact-provider.ts)
//   mobile        — possession-proven number (reserved; not used by the
//                   current UI flow)
//   aadhaarMobile — the number was confirmed as AADHAAR-LINKED by an
//                   authorized identity/KYC provider. Only the provider's
//                   receipt is stored: providerVerificationId +
//                   verificationStatus + verifiedAt. Aadhaar numbers are
//                   never requested or stored.
//
// OTPs are generated and checked exclusively on the verification server;
// nothing here ever sees or stores a code. Persistence uses localStorage
// keyed by wallet address where available (in-memory fallback otherwise).
// Like everything else in this demo client it is NOT a security boundary.

export type ContactType = 'email' | 'mobile';

/** One verified contact channel. */
export interface VerifiedChannel {
  readonly value: string;
  readonly verifiedAt: string;
}

/**
 * Aadhaar-linked-mobile verification result. Stores ONLY what the app
 * needs — provider traceability IDs and status — never an Aadhaar number.
 */
export interface AadhaarMobileRecord {
  readonly verified: boolean;
  /** Normalized E.164 mobile that the provider confirmed. */
  readonly mobile?: string;
  readonly providerVerificationId?: string;
  readonly providerName?: string;
  readonly verificationStatus?: string;
  readonly verifiedAt?: string;
}

export interface UserProfile {
  readonly address: string;
  readonly email?: VerifiedChannel;
  readonly mobile?: VerifiedChannel;
  readonly aadhaarMobile?: AadhaarMobileRecord;
}

/**
 * Legacy v1 profile shape (single demo-verified contact). Still parsed
 * so returning users keep their completed status after the upgrade.
 */
export interface ContactProfile {
  readonly address: string;
  readonly contactType: ContactType;
  readonly contactValue: string;
  readonly verifiedAt: string;
}

// ── Validation ─────────────────────────────────────────────────────

const EMAIL_MAX_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Email address is required.';
  if (value.length > EMAIL_MAX_LENGTH) return 'Email address is too long.';
  if (!EMAIL_RE.test(value)) return 'Enter a valid email address (e.g. name@example.com).';
  return null;
}

/**
 * Normalize a mobile number to E.164-style digits (leading "+").
 * Accepts spaces, dashes, parentheses; requires 10–15 digits total.
 */
export function normalizeMobile(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

export function validateMobile(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Mobile number is required.';
  if (normalizeMobile(value) === null) {
    return 'Enter a valid mobile number (10–15 digits, optional +country code).';
  }
  return null;
}

/**
 * Normalize an INDIAN mobile to "+91XXXXXXXXXX" (for Aadhaar flows):
 * accepts bare 10-digit numbers starting 6–9, optional +91 / 0 prefixes,
 * and common formatting characters. Returns null when invalid.
 */
export function normalizeIndianMobile(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let digits = trimmed.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;

  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);

  // Valid Indian mobile subscriber number: 10 digits, first digit 6–9.
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}

/** Validate a contact input; returns the normalized value or an error message. */
export function validateContact(contactType: ContactType, raw: string): { value: string; error: null } | { value: null; error: string } {
  if (contactType === 'email') {
    const error = validateEmail(raw);
    return error ? { value: null, error } : { value: raw.trim(), error: null };
  }
  const normalized = normalizeMobile(raw);
  const error = validateMobile(raw);
  return error || normalized === null
    ? { value: null, error: error ?? 'Enter a valid mobile number.' }
    : { value: normalized, error: null };
}

// ── Profile store (localStorage-backed, memory fallback) ───────────

const PROFILE_KEY_PREFIX = 'priestate.profile.v1.';
const memoryProfiles = new Map<string, UserProfile>();

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    const k = memoryKeyOf(key);
    return memoryProfiles.has(k) ? JSON.stringify(memoryProfiles.get(k)) : null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    memoryProfiles.set(memoryKeyOf(key), JSON.parse(value) as UserProfile);
  }
}

function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
  memoryProfiles.delete(memoryKeyOf(key));
}

function memoryKeyOf(key: string): string {
  return key.slice(PROFILE_KEY_PREFIX.length);
}

function profileKey(address: string): string {
  return `${PROFILE_KEY_PREFIX}${address.trim().toLowerCase()}`;
}

/** Parse stored JSON into a UserProfile (handles the legacy v1 shape). */
export function parseStoredProfile(raw: string): UserProfile | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const address = typeof parsed.address === 'string' ? parsed.address : '';
    if (!address) return null;

    // v1 legacy: single contactType/contactValue/verifiedAt triple.
    if (parsed.contactType && parsed.contactValue && parsed.verifiedAt) {
      const channel: VerifiedChannel = {
        value: String(parsed.contactValue),
        verifiedAt: String(parsed.verifiedAt),
      };
      return parsed.contactType === 'email'
        ? { address, email: channel }
        : { address, mobile: channel };
    }

    const out: { address: string; email?: VerifiedChannel; mobile?: VerifiedChannel; aadhaarMobile?: AadhaarMobileRecord } = { address };
    if (isChannel(parsed.email)) out.email = parsed.email;
    if (isChannel(parsed.mobile)) out.mobile = parsed.mobile;
    if (parsed.aadhaarMobile !== null && typeof parsed.aadhaarMobile === 'object') {
      const am = parsed.aadhaarMobile as AadhaarMobileRecord;
      if (typeof am.verified === 'boolean') out.aadhaarMobile = am;
    }
    return out.email || out.mobile || out.aadhaarMobile ? out : null;
  } catch {
    return null;
  }
}

function isChannel(v: unknown): v is VerifiedChannel {
  if (v === null || typeof v !== 'object') return false;
  const c = v as Partial<VerifiedChannel>;
  return typeof c.value === 'string' && typeof c.verifiedAt === 'string';
}

/** Load the full user profile for a wallet address, if any exists. */
export function getUserProfile(address: string): UserProfile | null {
  if (!address.trim()) return null;
  const raw = storageGet(profileKey(address));
  if (!raw) return null;
  return parseStoredProfile(raw);
}

/**
 * Legacy view of the profile (single primary verified contact) kept for
 * compatibility with earlier consumers/tests.
 */
export function getContactProfile(address: string): ContactProfile | null {
  const p = getUserProfile(address);
  if (!p) return null;
  if (p.email) return { address: p.address, contactType: 'email', contactValue: p.email.value, verifiedAt: p.email.verifiedAt };
  if (p.mobile) return { address: p.address, contactType: 'mobile', contactValue: p.mobile.value, verifiedAt: p.mobile.verifiedAt };
  if (p.aadhaarMobile?.verified && p.aadhaarMobile.mobile) {
    return {
      address: p.address,
      contactType: 'mobile',
      contactValue: p.aadhaarMobile.mobile,
      verifiedAt: p.aadhaarMobile.verifiedAt ?? new Date().toISOString(),
    };
  }
  return null;
}

/** True when the wallet has completed at least one verification step. */
export function hasVerifiedProfile(address: string): boolean {
  const p = getUserProfile(address);
  return Boolean(p && (p.email || p.mobile || p.aadhaarMobile?.verified));
}

function updateProfile(address: string, mutate: (draft: { address: string; email?: VerifiedChannel; mobile?: VerifiedChannel; aadhaarMobile?: AadhaarMobileRecord }) => void): UserProfile {
  const normalizedAddress = address.trim().toLowerCase();
  const current = getUserProfile(normalizedAddress) ?? { address: normalizedAddress };
  const draft = {
    address: normalizedAddress,
    ...(current.email ? { email: { ...current.email } } : {}),
    ...(current.mobile ? { mobile: { ...current.mobile } } : {}),
    ...(current.aadhaarMobile ? { aadhaarMobile: { ...current.aadhaarMobile } } : {}),
  };
  mutate(draft);
  storageSet(profileKey(normalizedAddress), JSON.stringify(draft));
  return draft as UserProfile;
}

/**
 * Persist a verified contact channel. Callers must reach this ONLY after
 * the verification server confirmed the code/receipt.
 */
export function saveVerifiedProfile(address: string, contactType: ContactType, contactValue: string): ContactProfile {
  const verifiedAt = new Date().toISOString();
  updateProfile(address, (draft) => {
    if (contactType === 'email') draft.email = { value: contactValue, verifiedAt };
    else draft.mobile = { value: contactValue, verifiedAt };
  });
  return { address: address.trim().toLowerCase(), contactType, contactValue, verifiedAt };
}

/** Record a successful Aadhaar-linked-mobile confirmation (receipt only). */
export function recordAadhaarMobileVerified(
  address: string,
  input: {
    mobile: string;
    providerVerificationId?: string;
    providerName?: string;
    verificationStatus?: string;
  },
): AadhaarMobileRecord {
  const record: AadhaarMobileRecord = {
    verified: true,
    mobile: input.mobile,
    providerVerificationId: input.providerVerificationId,
    providerName: input.providerName,
    verificationStatus: input.verificationStatus ?? 'VERIFIED',
    verifiedAt: new Date().toISOString(),
  };
  updateProfile(address, (draft) => {
    draft.aadhaarMobile = record;
  });
  return record;
}

/** Remove ALL stored verification data (e.g. "Change contact" reset). */
export function deleteContactProfile(address: string): void {
  storageRemove(profileKey(address));
}
