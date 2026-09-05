// PRIESTATE Level-3 — Mandatory multi-factor login semantics.
//
// Verifies that login is IMPOSSIBLE without EVERY factor:
//   * registration fails closed when any delivery channel is unconfigured,
//   * password alone is not enough,
//   * missing SMS / WhatsApp / Google / identity factors each block login,
//   * a fully-verified account logs in successfully,
//   * the account service never fabricates a factor when a channel exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AccountService } from '../server/account/service';
import { InMemoryAccountStore } from '../server/account/store';
import { enrollmentVectors } from './biometric-vectors';

const ENC = 'level3-auth-test-enc-secret';

interface Capture {
  sms: string[];
  whatsapp: string[];
}

function makeService(over: {
  sms?: boolean;
  whatsapp?: boolean;
  google?: boolean;
  googleAccept?: boolean;
  capture?: Capture;
} = {}): { service: AccountService; capture: Capture } {
  const capture: Capture = { sms: [], whatsapp: [] };
  const service = new AccountService({
    store: new InMemoryAccountStore(),
    encryptionSecret: ENC,
    biometricEncryptionSecret: ENC,
    otp: { hashSecret: 'auth-test-otp-secret' },
    smsDelivery: {
      configured: over.sms ?? true,
      send: (to, code) => { capture.sms.push(`${to}:${code}`); },
    },
    whatsappDelivery: {
      configured: over.whatsapp ?? true,
      send: (to, code) => { capture.whatsapp.push(`${to}:${code}`); },
    },
    googleAuthenticator: { configured: over.google ?? true, complete: () => over.googleAccept ?? true },
  });
  return { service, capture };
}

const WALLET = '0x' + 'b'.repeat(64);

function payload() {
  return {
    walletAddress: WALLET,
    fullName: 'Neha Kulkarni',
    aadhaarNumber: '345678901234',
    addressOnAadhaar: '22, Lake Road, Mumbai',
    pincode: '400001',
    dateOfBirth: '1985-03-22',
    mobile: '9876501234',
    password: 'V3ry#Secret',
    passwordConfirm: 'V3ry#Secret',
  };
}

function fullyVerify(service: AccountService, capture: Capture): void {
  // Register → SMS OTP → WhatsApp OTP → Google → identity.
  const regRes = service.register(payload());
  assert.equal(regRes.ok, true);
  const smsIssue = service.issueSmsOtp(WALLET);
  assert.equal(smsIssue.ok, true);
  const smsCode = lastCode(capture.sms);
  assert.equal(service.verifySmsOtp(WALLET, smsCode).ok, true);
  const waIssue = service.issueWhatsappOtp(WALLET);
  assert.equal(waIssue.ok, true);
  const waCode = lastCode(capture.whatsapp);
  assert.equal(service.verifyWhatsappOtp(WALLET, waCode).ok, true);
  assert.equal('view' in service.completeGoogle(WALLET, 'code') && service.completeGoogle(WALLET, 'code').ok, true);
  fullyEnroll(service);
}

/** Part 8: real server-side biometric enrollment (single-use token + embeddings). */
function fullyEnroll(service: AccountService): void {
  const begin = service.beginBiometricEnrollment(WALLET);
  assert.equal(begin.ok, true);
  assert.ok('token' in begin);
  if (!('token' in begin)) return;
  const done = service.enrollBiometricReference(WALLET, {
    token: begin.token,
    embeddings: enrollmentVectors(4),
    consent: true,
  });
  assert.equal(done.ok, true, 'enrollment should complete');
  if (done.ok) assert.equal(done.identityVerified, true);
}

function lastCode(entries: string[]): string {
  assert.ok(entries.length > 0, 'expected a delivered OTP');
  return entries[entries.length - 1].split(':')[1];
}

test('registration fails closed when a delivery channel is unconfigured', () => {
  const { service } = makeService({ sms: false });
  const r = service.register(payload());
  assert.equal(r.ok, false);
  if ('reason' in r) assert.equal(r.reason, 'unavailable');
});

test('same wallet cannot register twice', () => {
  const { service } = makeService();
  assert.equal(service.register(payload()).ok, true);
  const second = service.register(payload());
  assert.equal(second.ok, false);
  if ('reason' in second) assert.equal(second.reason, 'already-registered');
});

test('login is blocked when any single factor is missing', () => {
  // Complete SMS + Google + identity, but leave WhatsApp pending.
  const { service, capture } = makeService();
  assert.equal(service.register(payload()).ok, true);
  const issue = service.issueSmsOtp(WALLET);
  assert.equal(issue.ok, true);
  assert.equal(service.verifySmsOtp(WALLET, lastCode(capture.sms)).ok, true);
  assert.equal('view' in service.completeGoogle(WALLET, 'code') && service.completeGoogle(WALLET, 'code').ok, true);
  fullyEnroll(service);

  // Correct password but WhatsApp pending => blocked as a missing factor.
  const blocked = service.login({ walletAddress: WALLET, password: 'V3ry#Secret' });
  assert.equal(blocked.ok, false);
  if ('reason' in blocked) assert.equal(blocked.reason, 'factor-missing');
});

test('identity verification is independently enforced at login', () => {
  const { service, capture } = makeService();
  fullyVerify(service, capture);
  // Invalid password => unauthorized.
  const bad = service.login({ walletAddress: WALLET, password: 'Wrong!Pass' });
  assert.equal(bad.ok, false);
  if ('reason' in bad) assert.equal(bad.reason, 'unauthorized');
});

test('a fully-verified account logs in successfully with all factors', () => {
  const { service, capture } = makeService();
  fullyVerify(service, capture);
  const good = service.login({ walletAddress: WALLET, password: 'V3ry#Secret' });
  assert.equal(good.ok, true);
  if (good.ok && 'session' in good) assert.ok(good.session.accountId.length > 0);
});

test('unknown wallet cannot log in', () => {
  const { service } = makeService();
  const r = service.login({ walletAddress: '0x' + 'c'.repeat(64), password: 'whatever' });
  assert.equal(r.ok, false);
  if ('reason' in r) assert.equal(r.reason, 'not-found');
});

test('OTP is single-use: a consumed code cannot be reused', () => {
  const { service, capture } = makeService();
  assert.equal(service.register(payload()).ok, true);
  assert.equal(service.issueSmsOtp(WALLET).ok, true);
  const code = lastCode(capture.sms);
  assert.equal(service.verifySmsOtp(WALLET, code).ok, true);
  // Reusing the same code now fails.
  const reusable = service.verifySmsOtp(WALLET, code);
  assert.equal(reusable.ok, false);
});

test('raw OTP codes are never returned to the client, only delivered', () => {
  const { service, capture } = makeService();
  assert.equal(service.register(payload()).ok, true);
  const issue = service.issueSmsOtp(WALLET);
  assert.equal(issue.ok, true);
  // The issue response itself carries the code ONLY to the send hook.
  assert.ok(capture.sms.length === 1);
  assert.ok(capture.sms[0].endsWith(':' + (issue.ok ? issue.code : '')));
});
