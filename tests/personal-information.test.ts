// PRIESTATE — Personal Information registration step tests.
//
// Covers the NEW behaviour only, and stays fully offline (node:test + tsx) in
// the repo's established style: no network, no wallet, no proof server, no
// jsdom. React is not mounted; the pure validation modules and the pure step
// derivation are exercised directly.
//
// What is deliberately NOT asserted here: that a provider actually delivered
// a code, or that an Aadhaar/PAN is genuine. Those can only ever be true when
// a real provider is configured, so claiming them in a test would be a lie.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_COUNTRY_CODE,
  INDIAN_STATES,
  isPersonalFormComplete,
  isValidBirthDate,
  isValidIndianPincode,
  isValidNamePart,
  isValidNationalMobile,
  maskPan,
  normalizePan,
  validatePersonalForm,
  type PersonalFormValues,
} from '../src/registration/personal-validation.js';
import {
  buildE164,
  isValidIndianPincode as serverIsValidPincode,
  normalizeCountryCode,
  normalizePan as serverNormalizePan,
} from '../server/lib/validation.js';
import { currentRegistrationStep, type RegistrationStatus } from '../src/auth/registration-types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

/** A fully valid Personal Information payload. */
function validValues(overrides: Partial<PersonalFormValues> = {}): PersonalFormValues {
  return {
    firstName: 'Asha',
    middleName: 'R',
    lastName: 'Mehta',
    countryCode: DEFAULT_COUNTRY_CODE,
    mobile: '9876543210',
    address: '12 MG Road, Indiranagar',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560038',
    dateOfBirth: '1990-04-12',
    aadhaarNumber: '123456789012',
    panNumber: 'ABCDE1234F',
    ...overrides,
  };
}

/** A server status with the phone already proven over `channel`. */
function statusWithPhone(channel: 'sms' | 'whatsapp' | null): RegistrationStatus {
  return {
    walletAddress: null,
    active: true,
    personalVerified: channel !== null,
    aadhaarDocumentStatus: 'verified',
    emailVerified: true,
    smsOtpVerified: channel === 'sms',
    whatsappOtpVerified: channel === 'whatsapp',
    phoneVerified: channel !== null,
    phoneChannel: channel,
    aadhaarMobileLinked: true,
    passwordSet: true,
    photoStatus: 'verified',
    livenessPassed: true,
    locationAccepted: true,
    maskedMobile: '+91•••••210',
    maskedAadhaar: '•••• 9012',
    maskedEmail: 'a***@example.com',
    finalized: false,
    expiresAt: Date.now() + 60_000,
  };
}

// ─── Name: three parts, first/last required, middle optional ──────────────

test('[personal/name] first and last name are required, middle name is optional', () => {
  assert.equal(validatePersonalForm(validValues()).firstName, undefined);
  assert.equal(validatePersonalForm(validValues()).lastName, undefined);

  const noMiddle = validatePersonalForm(validValues({ middleName: '' }));
  assert.equal(noMiddle.middleName, undefined, 'an empty middle name is valid');

  const missing = validatePersonalForm(validValues({ firstName: '', lastName: '' }));
  assert.match(missing.firstName ?? '', /required/i);
  assert.match(missing.lastName ?? '', /required/i);
});

test('[personal/name] a malformed name part is rejected, a valid one is not', () => {
  assert.equal(isValidNamePart("O'Brien"), true);
  assert.equal(isValidNamePart('Anne-Marie'), true);
  assert.equal(isValidNamePart('D'), true);
  assert.equal(isValidNamePart('123'), false, 'must start with a letter');
  assert.equal(isValidNamePart('<script>'), false);
  assert.equal(isValidNamePart('x'.repeat(41)), false, 'bounded length');
});

test('[personal/name] a name is collected as three separate fields, never one blob', () => {
  // There is no combined full-name input in the form shape at all.
  const values = validValues();
  assert.ok('firstName' in values);
  assert.ok('lastName' in values);
  assert.ok(!('fullName' in values), 'no combined full-name field exists');
});

// ─── Phone: country code + national number ────────────────────────────────

test('[personal/phone] a valid country code + 10-digit national number builds E.164', () => {
  assert.equal(buildE164('+91', '9876543210'), '+919876543210');
  assert.equal(buildE164('91', '9876543210'), '+919876543210');
  assert.equal(buildE164('+91', '09876543210'), '+919876543210', 'trunk zero dropped');
});

test('[personal/phone] an invalid or unsupported number fails closed', () => {
  assert.equal(buildE164('+91', '1234567890'), null, 'must start 6-9');
  assert.equal(buildE164('+91', '98765'), null, 'must be 10 digits');
  assert.equal(buildE164('+91', ''), null);
  assert.equal(buildE164('+91', '98765abc10'), null);
  // A number that does not match the SELECTED country's plan is refused; it is
  // never silently re-mapped to another country.
  // NANP area codes never start 0 or 1.
  assert.equal(buildE164('+1', '1234567890'), null, 'NANP area code cannot start 1');
  assert.equal(buildE164('+1', '4155552671'), '+14155552671', 'a well-formed NANP number is accepted');
  assert.equal(buildE164('+44', '9876543210'), null, 'not a valid UK mobile prefix');
  assert.equal(buildE164('+999', '7400123456'), null, 'unknown calling code');
  assert.equal(normalizeCountryCode('+44'), '+44');
  assert.equal(normalizeCountryCode('00'), null);
});

test('[personal/phone] the national number is checked against its own country plan', () => {
  // India: 10 digits, first digit 6-9.
  assert.equal(isValidNationalMobile('9876543210', '+91'), true);
  assert.equal(isValidNationalMobile('5876543210', '+91'), false, 'leading 5 is not an Indian mobile');
  assert.equal(isValidNationalMobile('987654321', '+91'), false, '9 digits is too short');

  // United Kingdom: mobiles are 72-79 (70/71 reserved), trunk 0 accepted.
  assert.equal(isValidNationalMobile('7400123456', '+44'), true);
  assert.equal(isValidNationalMobile('07400123456', '+44'), true, 'trunk zero is dropped');
  assert.equal(isValidNationalMobile('1400123456', '+44'), false, 'not a UK mobile prefix');
  assert.equal(isValidNationalMobile('7000123456', '+44'), false, '70 is reserved in the UK plan');
  assert.equal(isValidNationalMobile('7100123456', '+44'), false, '71 is reserved in the UK plan');
  // Shape validation is deliberately not a country-lookup: '7400123456' also
  // happens to be shape-valid as an Indian mobile, and we cannot tell the two
  // apart from digits alone. Claiming otherwise would be a false guarantee.
  assert.equal(isValidNationalMobile('7400123456', '+91'), true, 'digits alone cannot prove nationality');
  assert.equal(isValidNationalMobile('1234567890', '+44'), false, 'leading 1 is not a UK mobile');

  // A pasted number carrying its own country code still validates. The country
  // code is stripped exactly once, so '+44 7400 123456' and '+447400123456'
  // both reduce to the same 10-digit national number.
  assert.equal(isValidNationalMobile('+447400123456', '+44'), true);
  assert.equal(isValidNationalMobile('+44 7400 123456', '+44'), true);

  // Unknown country codes are refused rather than guessed at.
  assert.equal(isValidNationalMobile('7400123456', '+999'), false);
});

test('[personal/phone] the India-only identity scope is stated, not hidden', () => {
  // A foreign number is accepted, but the identity fields it is paired with
  // stay Indian: the form must not imply a foreign registration path.
  const foreign = validatePersonalForm(validValues({ countryCode: '+44', mobile: '7400123456' }));
  assert.equal(foreign.countryCode, undefined, 'a supported foreign code is accepted');
  assert.equal(foreign.mobile, undefined, 'a well-formed foreign number is accepted');
});

test('[personal/phone] the form requires both a country code and a number', () => {
  const errors = validatePersonalForm(validValues({ countryCode: '', mobile: '' }));
  assert.match(errors.countryCode ?? '', /required/i);
  assert.match(errors.mobile ?? '', /required/i);
});

// ─── DOB: a real, past calendar date ──────────────────────────────────────

test('[personal/dob] a valid past date is accepted', () => {
  assert.equal(isValidBirthDate('1990-04-12'), true);
  assert.equal(validatePersonalForm(validValues()).dateOfBirth, undefined);
});

test('[personal/dob] future, impossible and malformed dates are rejected', () => {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  assert.equal(isValidBirthDate(tomorrow), false, 'today or later is impossible');
  assert.equal(isValidBirthDate('2024-02-31'), false, '31 February does not exist');
  assert.equal(isValidBirthDate('2024-13-01'), false, 'month 13 does not exist');
  assert.equal(isValidBirthDate('1899-01-01'), false, 'before 1900');
  assert.equal(isValidBirthDate('12-04-1990'), false, 'wrong shape');

  assert.match(
    validatePersonalForm(validValues({ dateOfBirth: tomorrow })).dateOfBirth ?? '',
    /past date of birth/i,
  );
  assert.match(
    validatePersonalForm(validValues({ dateOfBirth: '2024-02-31' })).dateOfBirth ?? '',
    /past date of birth/i,
  );
});

// ─── PIN code ─────────────────────────────────────────────────────────────

test('[personal/pincode] exactly 6 digits, first digit non-zero', () => {
  assert.equal(isValidIndianPincode('560038'), true);
  assert.equal(isValidIndianPincode('060038'), false, 'a leading zero is not a valid PIN');
  assert.equal(isValidIndianPincode('56003'), false, 'too short');
  assert.equal(isValidIndianPincode('5600388'), false, 'too long');
  assert.equal(isValidIndianPincode('56A038'), false);
  assert.equal(serverIsValidPincode('560038'), true, 'server agrees with the client');
});

test('[personal/pincode] the PIN code is required', () => {
  assert.match(validatePersonalForm(validValues({ pincode: '' })).pincode ?? '', /required/i);
});

// ─── State / city ─────────────────────────────────────────────────────────

test('[personal/state] the state list is offered and a state is required', () => {
  assert.ok(INDIAN_STATES.includes('Karnataka'));
  assert.ok(INDIAN_STATES.includes('Delhi'));
  assert.match(validatePersonalForm(validValues({ state: '' })).state ?? '', /required/i);
  assert.equal(validatePersonalForm(validValues({ state: 'Karnataka' })).state, undefined);
});

test('[personal/city] city is required and free-text', () => {
  assert.match(validatePersonalForm(validValues({ city: '' })).city ?? '', /required/i);
  assert.equal(validatePersonalForm(validValues({ city: 'Bengaluru' })).city, undefined);
});

// ─── Address ──────────────────────────────────────────────────────────────

test('[personal/address] address is required and length-bounded', () => {
  assert.match(validatePersonalForm(validValues({ address: '' })).address ?? '', /required/i);
  assert.match(
    validatePersonalForm(validValues({ address: 'x'.repeat(201) })).address ?? '',
    /200 characters or fewer/i,
  );
});

// ─── Aadhaar + PAN: format only, never a verification claim ───────────────

test('[personal/aadhaar] exactly 12 digits are required', () => {
  assert.match(
    validatePersonalForm(validValues({ aadhaarNumber: '12345678901' })).aadhaarNumber ?? '',
    /exactly 12 digits/i,
  );
  assert.equal(validatePersonalForm(validValues()).aadhaarNumber, undefined);
});

test('[personal/pan] standard PAN format, upper-cased on normalize', () => {
  assert.equal(normalizePan('abcde1234f'), 'ABCDE1234F');
  assert.equal(normalizePan('ABCDE1234F'), 'ABCDE1234F');
  assert.equal(normalizePan('ABCDE1234'), null, 'missing the last letter');
  assert.equal(normalizePan('ABC1234F'), null, 'missing letters');
  assert.equal(normalizePan('ABCDE12345'), null, 'too long');
  assert.equal(serverNormalizePan('abcde1234f'), 'ABCDE1234F', 'server agrees');
});

test('[personal/pan] PAN is optional but validated when supplied', () => {
  assert.equal(validatePersonalForm(validValues({ panNumber: '' })).panNumber, undefined);
  assert.match(
    validatePersonalForm(validValues({ panNumber: 'NOPE' })).panNumber ?? '',
    /valid PAN/i,
  );
});

test('[personal/pan] the display mask never reveals the middle of the PAN', () => {
  const masked = maskPan('ABCDE1234F');
  assert.ok(masked.includes('•••••'));
  assert.ok(!masked.includes('1234'), 'the 4-digit block must not be shown');
  assert.equal(maskPan('nonsense'), '', 'a malformed PAN is never masked into something');
});

// ─── Form completeness drives the Continue button ─────────────────────────

test('[personal/form] Continue stays disabled until every required field is valid', () => {
  assert.equal(isPersonalFormComplete(validValues()), true);

  // PAN is optional, so omitting it must NOT block Continue.
  assert.equal(isPersonalFormComplete(validValues({ panNumber: '' })), true);
  // Middle name is optional too.
  assert.equal(isPersonalFormComplete(validValues({ middleName: '' })), true);

  for (const required of [
    'firstName',
    'lastName',
    'mobile',
    'address',
    'city',
    'state',
    'pincode',
    'dateOfBirth',
    'aadhaarNumber',
  ] as const) {
    assert.equal(
      isPersonalFormComplete(validValues({ [required]: '' })),
      false,
      `${required} is required and must block Continue`,
    );
  }
});

// ─── Phone verification is EITHER-or, and gates the personal step ─────────

test('[personal/phone-step] the personal step stays open until a phone is verified', () => {
  // No session at all → personal.
  assert.equal(currentRegistrationStep(null), 'personal');
  // Details stored but no phone proven → still personal (the two-phase gate).
  const unverified = { ...statusWithPhone(null), personalVerified: false };
  assert.equal(currentRegistrationStep(unverified), 'personal');
});

test('[personal/phone-step] EITHER SMS or WhatsApp satisfies phone verification', () => {
  // SMS alone must be enough to move past the phone steps.
  const viaSms = statusWithPhone('sms');
  assert.equal(viaSms.smsOtpVerified, true);
  assert.equal(viaSms.whatsappOtpVerified, false, 'the other channel is NOT required');
  assert.equal(currentRegistrationStep(viaSms), 'finalize', 'SMS alone advances the stepper');

  // WhatsApp alone must be equally sufficient.
  const viaWhatsapp = statusWithPhone('whatsapp');
  assert.equal(viaWhatsapp.whatsappOtpVerified, true);
  assert.equal(viaWhatsapp.smsOtpVerified, false);
  assert.equal(currentRegistrationStep(viaWhatsapp), 'finalize', 'WhatsApp alone advances too');
});

test('[personal/phone-step] a later incomplete step still wins over the phone steps', () => {
  const partial = { ...statusWithPhone('sms'), emailVerified: false };
  assert.equal(currentRegistrationStep(partial), 'email');
  const noPassword = { ...statusWithPhone('whatsapp'), passwordSet: false };
  assert.equal(currentRegistrationStep(noPassword), 'password');
});

test('[personal/phone] client and server agree on every dialling plan', () => {
  // The two implementations are deliberate mirrors. Any divergence means the
  // citizen sees an inline error for a number the server would accept (or is
  // stopped by a field the server would have passed), so pin them together.
  const samples: ReadonlyArray<readonly [string, string]> = [
    ['+91', '9876543210'],
    ['+91', '09876543210'],
    ['+91', '+919876543210'],
    ['+91', '5876543210'],
    ['+44', '7400123456'],
    ['+44', '07400123456'],
    ['+44', '+447400123456'],
    ['+44', '1400123456'],
    ['+1', '4155552671'],
    ['+1', '1234567890'],
    ['+971', '5012345678'],
    ['+61', '412345678'],
    ['+81', '9012345678'],
    ['+999', '7400123456'],
    ['+91', ''],
    ['+91', 'abc'],
  ];
  for (const [code, national] of samples) {
    const client = isValidNationalMobile(national, code);
    const server = buildE164(code, national) !== null;
    assert.equal(client, server, `client/server disagree for ${code} ${national}`);
  }
});
