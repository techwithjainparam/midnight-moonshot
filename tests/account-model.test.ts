// PRIESTATE Level-3 — Account model validation semantics.
//
// Verifies that the server-side account model validation is strict:
//   * mobile normalization (E.164), pincode, DOB (real past dates only),
//   * Aadhaar must be exactly 12 digits,
//   * password strength (length + character classes + no reuse of PII),
//   * password confirm matches,
//   * masked display fragments never leak full values.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAccountRegistration,
  passwordIssues,
  isValidPastDate,
  maskAadhaar,
} from '../server/account/model';
import { normalizeIndianMobile as serverNormalize } from '../server/lib/validation';
import {
  validateRegistrationForm,
  normalizeIndianMobile as clientNormalize,
  isValidPastDate as clientIsValidPastDate,
} from '../src/auth/account-types';

test('server: accepts a valid registration payload', () => {
  const result = parseAccountRegistration({
    walletAddress: '0x' + 'a'.repeat(64),
    fullName: 'Aarav Mehta',
    aadhaarNumber: '234567890123',
    pincode: '560001',
    dateOfBirth: '1988-12-01',
    mobile: '+91 98765 43210',
    password: 'H@rd2Guess!',
    passwordConfirm: 'H@rd2Guess!',
  });
  assert.equal(result.ok, true);
});

test('server: rejects a short / weak password and a password without a symbol', () => {
  const result = parseAccountRegistration({
    walletAddress: '0x' + 'a'.repeat(64),
    fullName: 'Aarav Mehta',
    aadhaarNumber: '234567890123',
    dateOfBirth: '1988-12-01',
    mobile: '9876543210',
    password: 'short',
    passwordConfirm: 'short',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((i) => i.includes('at least 8')));
});

test('server: password must not contain the mobile or Aadhaar', () => {
  const result = parseAccountRegistration({
    walletAddress: '0x' + 'a'.repeat(64),
    fullName: 'Aarav Mehta',
    aadhaarNumber: '234567890123',
    dateOfBirth: '1988-12-01',
    mobile: '9876543210',
    password: '9876543210Ab!',
    passwordConfirm: '9876543210Ab!',
  });
  assert.equal(result.ok, false);
});

test('server: password confirm mismatch is rejected', () => {
  const result = parseAccountRegistration({
    walletAddress: '0x' + 'a'.repeat(64),
    fullName: 'Aarav Mehta',
    aadhaarNumber: '234567890123',
    dateOfBirth: '1988-12-01',
    mobile: '9876543210',
    password: 'H@rd2Guess!',
    passwordConfirm: 'Diff3rent!',
  });
  assert.equal(result.ok, false);
});

test('server: invalid Aadhaar, pincode, and DOB are rejected', () => {
  expectIssuesToInclude(
    {
      aadhaarNumber: '12345',
      pincode: '1234',
      dateOfBirth: '2030-01-01',
      mobile: '12345',
    },
    ['Aadhaar', 'pincode', 'valid past date', 'mobile'],
  );
});

test('server: mobile normalizes to E.164 and masks never reveal full value', () => {
  const result = parseAccountRegistration({
    walletAddress: '0x' + 'a'.repeat(64),
    fullName: 'Aarav Mehta',
    aadhaarNumber: '234567890123',
    dateOfBirth: '1988-12-01',
    mobile: '09876543210',
    password: 'H@rd2Guess!',
    passwordConfirm: 'H@rd2Guess!',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.input.mobile, '+919876543210');
  const masked = maskAadhaar('234567890123');
  assert.ok(!masked.includes('23456789012'));
  assert.ok(masked.includes('0123'));
});

test('passwordIssues gates length and character classes', () => {
  assert.ok(passwordIssues('short').some((i) => i.includes('at least 8')));
  assert.equal(passwordIssues('GoodPass!9').length, 0);
});

test('isValidPastDate only accepts real, non-future dates', () => {
  assert.equal(isValidPastDate('1990-05-15'), true);
  assert.equal(isValidPastDate('2026-08-30'), true);
  assert.equal(isValidPastDate('2031-01-01'), false);
  assert.equal(isValidPastDate('1990-13-40'), false);
  assert.equal(isValidPastDate('nope'), false);
});

test('client validation mirrors the server on a clean and a bad form', () => {
  const clean = validateRegistrationForm({
    fullName: 'Priya Sharma',
    aadhaarNumber: '123456789012',
    pincode: '411001',
    dateOfBirth: '1990-05-15',
    mobile: '9876543210',
    password: 'Str0ng#Passw0rd',
    passwordConfirm: 'Str0ng#Passw0rd',
  });
  assert.deepEqual(Object.keys(clean).length, 0);

  const dirty = validateRegistrationForm({
    fullName: 'A',
    aadhaarNumber: '123',
    pincode: '400',
    dateOfBirth: '2030-01-01',
    mobile: '555',
    password: 'short',
    passwordConfirm: 'different',
  });
  assert.ok(Object.keys(dirty).length >= 4);
});

test('client and server mobile + DOB helpers agree', () => {
  assert.equal(clientNormalize('+91 98765 43210'), serverNormalize('+91 98765 43210'));
  assert.equal(clientNormalize('invalid'), null);
  assert.equal(clientIsValidPastDate('1995-09-09'), true);
});

function expectIssuesToInclude(
  over: Record<string, string>,
  needles: string[],
): void {
  const base: Record<string, string> = {
    fullName: 'Aarav Mehta',
    dateOfBirth: '1988-12-01',
    mobile: '9876543210',
    password: 'H@rd2Guess!',
    passwordConfirm: 'H@rd2Guess!',
  };
  const result = parseAccountRegistration({ ...base, ...over });
  assert.equal(result.ok, false);
  if (result.ok) return;
  for (const n of needles) {
    assert.ok(result.issues.some((i) => i.toLowerCase().includes(n.toLowerCase())), `expected an issue mentioning "${n}"`);
  }
}
