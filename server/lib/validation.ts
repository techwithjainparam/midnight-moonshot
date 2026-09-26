// PRIESTATE — Server-side contact/identity validation helpers.
//
// Shared by API routes and automated tests. Mirrors the frontend
// validation in src/profile/contact-verification.ts but is independent
// so the server never trusts client-side checks.

import { findPlan } from './dialling-plans.js';

const EMAIL_MAX_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value || value.length > EMAIL_MAX_LENGTH) return null;
  if (!EMAIL_RE.test(value)) return null;
  return value;
}

export function isValidEmail(raw: string): boolean {
  return normalizeEmail(raw) !== null;
}

/**
 * Normalize an Indian mobile number to E.164 "+91XXXXXXXXXX".
 *
 * Accepts:
 *   9876543210            (bare 10-digit, must start 6-9)
 *   +91 98765 43210       (spaced)
 *   +91-98765-43210       (dashed)
 *   098765 43210          (trunk-zero form → leading 0 dropped)
 *   919876543210          (country code without +)
 */
export function normalizeIndianMobile(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let digits = trimmed.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  // A lone "+" or stray non-digits at this point means invalid input.
  if (!/^\d+$/.test(digits)) return null;

  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);

  // Valid Indian mobile: exactly 10 digits, first digit 6–9.
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}

export function isValidIndianMobile(raw: string): boolean {
  return normalizeIndianMobile(raw) !== null;
}

/** Mask a normalized mobile for display: +9198•••••210 */
export function maskMobile(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length < 6) return '••••';
  return `+${digits.slice(0, digits.length - 3).slice(0, -5)}•••••${digits.slice(-3)}`;
}

// ── Personal-information (registration step 1) ─────────────────────
//
// Everything below is pure format validation. None of it proves a document is
// genuine — a real provider is the only thing that can do that, and the UI
// never claims these values were "verified" merely because they parse.

/** One name part: letters plus the separators real names legitimately use. */
const NAME_PART_RE = /^[A-Za-z][A-Za-z .'-]{0,39}$/u;

/** A PAN is 5 letters, 4 digits, 1 letter — e.g. ABCDE1234F. */
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/u;

/** An E.164 country calling code, e.g. +91 / +1 / +44 (1–3 digits, no plus). */
const COUNTRY_CODE_RE = /^[1-9]\d{0,2}$/u;

/** Indian 6-digit PIN code: first digit 1–9. */
const INDIAN_PINCODE_RE = /^[1-9]\d{5}$/u;

export function isValidNamePart(raw: string): boolean {
  return NAME_PART_RE.test(raw.trim());
}

/** Normalize a PAN to canonical upper-case, or null when malformed. */
export function normalizePan(raw: string): string | null {
  const value = raw.trim().toUpperCase().replace(/\s/g, '');
  return PAN_RE.test(value) ? value : null;
}

export function isValidPan(raw: string): boolean {
  return normalizePan(raw) !== null;
}

/**
 * Normalize a country calling code to its canonical "+<digits>" form.
 * Accepts "+91", "91", "091" (trunk zero dropped).
 */
export function normalizeCountryCode(raw: string): string | null {
  let digits = raw.trim().replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!COUNTRY_CODE_RE.test(digits)) return null;
  return `+${digits}`;
}

/** Aadhaar is exactly 12 digits; spaces are tolerated as presentation. */
export function normalizeAadhaar(raw: string): string | null {
  const digits = raw.trim().replace(/\s/g, '');
  return /^\d{12}$/.test(digits) ? digits : null;
}

export function isValidIndianPincode(raw: string): boolean {
  return INDIAN_PINCODE_RE.test(raw.trim());
}

/**
 * Build an E.164 number from an explicit country code + national number.
 *
 * The number is validated against the selected country's dialling plan
 * (length range, mobile prefix where known, trunk-zero handling) so an
 * unroutable number is rejected before it reaches a gateway.
 *
 * SCOPE: this is FORMAT validation only. A well-formed number is not proof
 * that it is assigned, reachable, or that the configured SMS/WhatsApp gateway
 * is enabled for that country. It makes no such claim.
 *
 * NOTE: accepting a foreign calling code widens which numbers the gateways may
 * be asked to deliver to. It does NOT widen the identity model — Aadhaar, the
 * India Post pincode lookup and the state list remain India-only.
 */
export function buildE164(countryCodeRaw: string, nationalRaw: string): string | null {
  const countryCode = normalizeCountryCode(countryCodeRaw);
  if (countryCode === null) return null;
  const dialPlan = findPlan(countryCode);
  if (dialPlan === null) return null;

  // Accept a number the citizen already typed with its country code, but only
  // when it matches the country they selected — never silently re-map.
  let national = nationalRaw.trim().replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(national)) return null;
  if (national.startsWith(countryCode.replace('+', ''))) {
    national = national.slice(countryCode.replace('+', '').length);
  }
  if (dialPlan.allowsTrunkZero) national = national.replace(/^0+/, '');

  const [min, max] = dialPlan.nsnLength;
  if (national.length < min || national.length > max) return null;
  if (dialPlan.mobilePrefixes.length > 0 && !dialPlan.mobilePrefixes.some((p) => national.startsWith(p))) {
    return null;
  }
  return `${countryCode}${national}`;
}

/**
 * Indian states and union territories, for the personal-details state field.
 *
 * This is the AUTHORITATIVE list. The client keeps a copy in
 * src/registration/personal-validation.ts to render its <select>, and a test
 * asserts the two stay identical so the dropdown can never offer a value the
 * server would then reject.
 */
export const INDIAN_STATES: readonly string[] = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
];

/** Exact-match allowlist: a client cannot invent a state. */
export function isIndianState(raw: string): boolean {
  return INDIAN_STATES.includes(raw.trim());
}
