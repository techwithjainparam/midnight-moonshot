// PRIESTATE — Account / mandatory multi-factor frontend model (Level 3).
//
// Client-side types, validation, and masked-display helpers for the user
// account flow (registration + login). SECURITY NOTE: this client is NOT a
// security boundary — the real password hashing, OTP semantics, PII
// encryption, and factor enforcement all live on the verification server
// (server/account/*). The client only renders honest states and never stores
// PII, passwords, or OTP codes.

/** Which of the five login factors a server reports as configured. */
export interface AccountCapabilities {
  readonly smsConfigured: boolean;
  readonly whatsappConfigured: boolean;
  readonly googleConfigured: boolean;
}

/** Public-safe account view returned by the server (never holds raw PII). */
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
  readonly maskedMobile: string;
  readonly maskedAadhaar: string;
  readonly smsOtpVerified: boolean;
  readonly whatsappOtpVerified: boolean;
  readonly googleLinked: boolean;
  readonly identityVerified: boolean;
  readonly createdAt: number;
}

// ── Client-side validation (mirrors the server, for instant feedback) ──
//
// The server re-validates authoritatively; these helpers just avoid a round
// trip on obvious mistakes and power the Level 3 unit tests.

export const MIN_PASSWORD_LENGTH = 8;

export function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    issues.push(`at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!/[a-z]/.test(password)) issues.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) issues.push('an uppercase letter');
  if (!/[0-9]/.test(password)) issues.push('a number');
  if (!/[^A-Za-z0-9]/.test(password)) issues.push('a symbol');
  return issues;
}

/** Normalize an Indian mobile to E.164 "+91XXXXXXXXXX"; null when invalid. */
export function normalizeIndianMobile(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let digits = trimmed.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}

export function isValidPastDate(iso: string): boolean {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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
  const today = new Date().toISOString().slice(0, 10);
  return today >= iso;
}

export function maskAadhaar(aadhaar: string): string {
  const digits = aadhaar.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `•••• ${digits.slice(-4)}`;
}

export function maskMobile(raw: string): string {
  const e = normalizeIndianMobile(raw) ?? raw;
  const digits = e.replace(/\D/g, '');
  if (digits.length < 6) return '••••';
  return `+${digits.slice(0, -8)}••••${digits.slice(-2)}`;
}

export interface RegistrationFieldErrors {
  fullName?: string;
  aadhaarNumber?: string;
  pincode?: string;
  dateOfBirth?: string;
  mobile?: string;
  password?: string;
  passwordConfirm?: string;
}

/**
 * Validate the registration form. Uses only the values (no querying):
 * returns a map of field → message; empty object means the form is valid.
 * This mirrors but is independent of the server-side validation.
 */
export function validateRegistrationForm(values: {
  fullName: string;
  aadhaarNumber: string;
  pincode: string;
  dateOfBirth: string;
  mobile: string;
  password: string;
  passwordConfirm: string;
}): RegistrationFieldErrors {
  const errors: RegistrationFieldErrors = {};

  const name = values.fullName.trim();
  if (!name) {
    errors.fullName = 'Full name is required.';
  } else if (!/^[A-Za-z][A-Za-z .'-]{1,79}$/u.test(name)) {
    errors.fullName = 'Enter a valid full name (letters, spaces, . \' or -).';
  }

  const aadhaar = values.aadhaarNumber.replace(/\s/g, '');
  if (!aadhaar) {
    errors.aadhaarNumber = 'Aadhaar number is required.';
  } else if (!/^\d{12}$/.test(aadhaar)) {
    errors.aadhaarNumber = 'Aadhaar must be exactly 12 digits.';
  }

  const pincode = values.pincode.trim();
  if (pincode && !/^[1-9]\d{5}$/.test(pincode)) {
    errors.pincode = 'Enter a valid 6-digit pincode.';
  }

  if (!values.dateOfBirth) {
    errors.dateOfBirth = 'Date of birth is required.';
  } else if (!isValidPastDate(values.dateOfBirth)) {
    errors.dateOfBirth = 'Enter a valid past date of birth (1900–today).';
  }

  if (!values.mobile) {
    errors.mobile = 'Mobile number is required.';
  } else if (!normalizeIndianMobile(values.mobile)) {
    errors.mobile = 'Enter a valid Indian mobile number (starts 6–9, 10 digits).';
  }

  const issues = passwordIssues(values.password);
  if (issues.length > 0) {
    errors.password = `Password needs ${issues.join(', ')}.`;
  }

  if (!values.passwordConfirm && !errors.password) {
    errors.passwordConfirm = 'Confirm your password.';
  } else if (values.password !== values.passwordConfirm && !errors.password) {
    errors.passwordConfirm = 'Passwords do not match.';
  }

  return errors;
}

export interface LoginValidation {
  readonly walletAddressSafe: boolean;
  readonly passwordSafe: boolean;
  readonly passwordError?: string;
}

export function isUsableLoginInput(password: string): boolean {
  return password.trim() !== '';
}
