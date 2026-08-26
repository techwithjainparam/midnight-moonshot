// PRIESTATE — Server-side contact/identity validation helpers.
//
// Shared by API routes and automated tests. Mirrors the frontend
// validation in src/profile/contact-verification.ts but is independent
// so the server never trusts client-side checks.

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
