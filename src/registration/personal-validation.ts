// PRIESTATE — Personal Information step: client-side validation.
//
// This is presentation-layer validation only. It exists so the citizen gets
// immediate inline feedback and so the Continue button can reflect what the
// SERVER will decide. It is deliberately NOT a security boundary and never
// claims authenticity: a well-formed Aadhaar or PAN is not a "verified"
// Aadhaar or PAN. Only a real, configured provider can assert that, and until
// one is wired the UI says so plainly.
//
// The server re-validates every field independently (see
// server/registration/service.ts → personal()); these rules mirror it so the
// two never disagree about what is acceptable.

/** One name part: letters plus the separators real names legitimately use. */
const NAME_PART_RE = /^[A-Za-z][A-Za-z .'-]{0,39}$/u;

/** PAN = 5 letters, 4 digits, 1 letter. */
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/u;

/** Indian 6-digit PIN code: first digit 1–9. */
const PINCODE_RE = /^[1-9]\d{5}$/u;

/** Aadhaar = exactly 12 digits. */
const AADHAAR_RE = /^\d{12}$/u;

import { findPlan, DEFAULT_CALLING_CODE, DIALLING_PLANS } from '../../server/lib/dialling-plans';

export type { DiallingPlan } from '../../server/lib/dialling-plans';

export const DEFAULT_COUNTRY_CODE = DEFAULT_CALLING_CODE;
export { DIALLING_PLANS };

/**
 * Format-check a national number against the selected country's dialling plan.
 *
 * Mirrors the server's buildE164() so the inline message matches what the
 * server will decide. This is formatting only — a well-formed number is not a
 * reachable one, and nothing here claims a gateway is enabled for the country.
 */
export function isValidNationalMobile(national: string, callingCode: string): boolean {
  const plan = findPlan(callingCode);
  if (plan === null) return false;
  let digits = national.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  const bare = callingCode.replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return false;
  if (digits.startsWith(bare) && digits.length > bare.length) digits = digits.slice(bare.length);
  if (plan.allowsTrunkZero) digits = digits.replace(/^0+/, '');
  const [min, max] = plan.nsnLength;
  if (digits.length < min || digits.length > max) return false;
  if (plan.mobilePrefixes.length > 0 && !plan.mobilePrefixes.some((p) => digits.startsWith(p))) return false;
  return true;
}

/** Indian states + union territories, for the state selector. */
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

/** The date-picker ceiling: a birth date can never be today or later. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The date-picker floor: 1900 matches the server's accepted range. */
export const EARLIEST_BIRTH_DATE = '1900-01-01';

export function isValidNamePart(raw: string): boolean {
  return NAME_PART_RE.test(raw.trim());
}

/** Upper-case, strip spaces, and reject anything that is not PAN-shaped. */
export function normalizePan(raw: string): string | null {
  const value = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return PAN_RE.test(value) ? value : null;
}

export function isValidAadhaar(raw: string): boolean {
  return AADHAAR_RE.test(raw.replace(/\D/g, ''));
}

export function isValidIndianPincode(raw: string): boolean {
  return PINCODE_RE.test(raw.trim());
}

/**
 * Mask a PAN for display, keeping the recognisable shape (AAAAA0000A → the
 * last two characters stay visible so the citizen can tell which card it is)
 * without exposing the full identifier.
 */
export function maskPan(raw: string): string {
  const pan = normalizePan(raw);
  if (!pan) return '';
  return `${pan.slice(0, 5)}•••••${pan.slice(-1)}`;
}

/** The values the Personal Information form collects. */
export interface PersonalFormValues {
  readonly firstName: string;
  readonly middleName: string;
  readonly lastName: string;
  readonly countryCode: string;
  readonly mobile: string;
  readonly address: string;
  readonly city: string;
  readonly state: string;
  readonly pincode: string;
  readonly dateOfBirth: string;
  readonly aadhaarNumber: string;
  readonly panNumber: string;
}

export type PersonalFieldName = keyof PersonalFormValues;

export type PersonalFieldErrors = Partial<Record<PersonalFieldName, string>>;

/** Fields that must be present and well-formed before the step can advance. */
const REQUIRED_FIELDS: readonly PersonalFieldName[] = [
  'firstName',
  'lastName',
  'countryCode',
  'mobile',
  'address',
  'city',
  'state',
  'pincode',
  'dateOfBirth',
  'aadhaarNumber',
];

/**
 * Validate the whole Personal Information form.
 *
 * An empty object means every required field is well-formed. Note that this
 * says nothing about whether the phone number has been *verified* — that is a
 * separate, server-authoritative fact tracked by the OTP flow.
 */
export function validatePersonalForm(values: PersonalFormValues): PersonalFieldErrors {
  const errors: PersonalFieldErrors = {};

  const firstName = values.firstName.trim();
  if (!firstName) errors.firstName = 'First name is required.';
  else if (!isValidNamePart(firstName)) errors.firstName = 'Enter a valid first name.';

  // Middle name is OPTIONAL — only validated when something was typed.
  const middleName = values.middleName.trim();
  if (middleName && !isValidNamePart(middleName)) {
    errors.middleName = 'Enter a valid middle name.';
  }

  const lastName = values.lastName.trim();
  if (!lastName) errors.lastName = 'Last name is required.';
  else if (!isValidNamePart(lastName)) errors.lastName = 'Enter a valid last name.';

  if (!values.countryCode) {
    errors.countryCode = 'Country code is required.';
  } else if (findPlan(values.countryCode) === null) {
    errors.countryCode = 'That country code is not supported.';
  }

  const mobile = values.mobile.replace(/\D/g, '');
  if (!mobile) errors.mobile = 'Phone number is required.';
  else if (!isValidNationalMobile(mobile, values.countryCode)) {
    errors.mobile = `Enter a valid ${values.countryCode} phone number.`;
  }

  if (!values.address.trim()) {
    errors.address = 'Address is required.';
  } else if (values.address.trim().length > 200) {
    errors.address = 'Address must be 200 characters or fewer.';
  }

  if (!values.city.trim()) {
    errors.city = 'City is required.';
  } else if (values.city.trim().length > 80) {
    errors.city = 'City must be 80 characters or fewer.';
  }

  if (!values.state.trim()) {
    errors.state = 'State is required.';
  } else if (!INDIAN_STATES.includes(values.state.trim())) {
    // Mirrors the server allowlist exactly, so the <select> can never offer a
    // value the server would then reject.
    errors.state = 'Select a valid Indian state or union territory.';
  }

  const pincode = values.pincode.trim();
  if (!pincode) errors.pincode = 'PIN code is required.';
  else if (!isValidIndianPincode(pincode)) errors.pincode = 'Enter a valid 6-digit PIN code.';

  if (!values.dateOfBirth) {
    errors.dateOfBirth = 'Date of birth is required.';
  } else if (!isValidBirthDate(values.dateOfBirth)) {
    errors.dateOfBirth = 'Enter a valid past date of birth (1900–today).';
  }

  const aadhaar = values.aadhaarNumber.replace(/\D/g, '');
  if (!aadhaar) errors.aadhaarNumber = 'Aadhaar number is required.';
  else if (!isValidAadhaar(aadhaar)) errors.aadhaarNumber = 'Aadhaar must be exactly 12 digits.';

  // PAN is optional; validated only when the citizen supplied one.
  const pan = values.panNumber.trim();
  if (pan && !normalizePan(pan)) {
    errors.panNumber = 'Enter a valid PAN (e.g. ABCDE1234F).';
  }

  return errors;
}

/** True when every REQUIRED field passes — the gate for enabling Continue. */
export function isPersonalFormComplete(values: PersonalFormValues): boolean {
  const errors = validatePersonalForm(values);
  return REQUIRED_FIELDS.every((f) => errors[f] === undefined);
}

/**
 * A real calendar date, not today, and not before 1900.
 *
 * `<input type="date">` already blocks most nonsense, but a value can still
 * arrive from an autofill or a hand-typed string, so the calendar is verified
 * rather than trusted.
 */
export function isValidBirthDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Rejects 31 April and friends: the round-trip must be identical.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return false;
  }
  return iso < todayIso();
}
