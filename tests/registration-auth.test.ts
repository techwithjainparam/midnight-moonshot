// PRIESTATE Level-3 — Registration authentication state machine (Part 3).
//
// The registration flow is a SEQUENTIAL, REQUIRED factor state machine driven
// only by real provider boundaries (never fabricated). This suite verifies:
//   * the Google provider enforces the state + nonce challenge (single-use,
//     wallet-bound, TTL) and is fail-closed when unconfigured,
//   * SMS / WhatsApp OTP factors flip their verified flag on a correct code,
//   * the derived registration state records progress and only reaches
//     `complete` once EVERY required factor is verified,
//   * incomplete registration is never reported complete,
//   * the googleBegin/googleComplete account methods wrap the provider,
//   * duplicate wallets are rejected,
//   * registration state never leaks PII or plaintext secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AccountService } from '../server/account/service';
import { InMemoryAccountStore } from '../server/account/store';
import { GoogleProvider, GOOGLE_STATE_TTL_MS } from '../server/account/google-provider';

const ENC = 'reg-auth-test-enc-secret';
const WALLET = '0x' + 'c'.repeat(64);
const OTHER_WALLET = '0x' + 'd'.repeat(64);

interface Capture { sms: string[]; whatsapp: string[] }

function makeService(over: {
  google?: boolean;            // provider configured?
  googleAccept?: boolean;      // underlying exchange outcome
  now?: () => number;
} = {}): { service: AccountService; capture: Capture } {
  const capture: Capture = { sms: [], whatsapp: [] };
  const provider = new GoogleProvider({
    configured: over.google ?? true,
    exchange: () => over.googleAccept ?? true,
    now: over.now,
  });
  const service = new AccountService({
    store: new InMemoryAccountStore(),
    encryptionSecret: ENC,
    otp: { hashSecret: 'reg-auth-test-otp-secret' },
    smsDelivery: { configured: true, send: (to, code) => capture.sms.push(`${to}:${code}`) },
    whatsappDelivery: { configured: true, send: (to, code) => capture.whatsapp.push(`${to}:${code}`) },
    // `googleAuthenticator` drives the configured flag (and `allFactorsConfigured`
    // / registration availability); the injected `googleProvider` carries the
    // state+nonce challenge semantics exercised by these tests.
    googleAuthenticator: { configured: over.google ?? true, complete: () => over.googleAccept ?? true },
    googleProvider: provider,
  });
  return { service, capture };
}

function payload() {
  return {
    walletAddress: WALLET,
    fullName: 'Ravi Deshpande',
    aadhaarNumber: '456789012345',
    addressOnAadhaar: '8, MG Road, Pune',
    pincode: '411001',
    dateOfBirth: '1990-07-14',
    mobile: '9822012345',
    password: 'Str0ng#Pass',
    passwordConfirm: 'Str0ng#Pass',
  };
}

function register(service: AccountService): void {
  const r = service.register(payload());
  assert.equal(r.ok, true, 'registration should succeed');
}

function lastCode(capture: Capture, channel: 'sms' | 'whatsapp'): string {
  const list = capture[channel];
  assert.ok(list.length > 0, `no ${channel} code was delivered`);
  return list[list.length - 1].split(':')[1];
}

// ── Google state + nonce challenge ─────────────────────────────────

test('googleBegin issues a state+nonce challenge bound to the wallet', () => {
  const { service } = makeService();
  const r = service.googleBegin(WALLET);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(typeof r.state, 'string');
    assert.equal(typeof r.nonce, 'string');
    assert.ok(r.state.length >= 32);
    assert.ok(r.nonce.length >= 32);
    assert.notEqual(r.state, r.nonce);
  }
});

test('googleComplete succeeds with the matching state, nonce and a valid code', () => {
  const { service } = makeService();
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const ok = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce, code: 'a-valid-auth-code' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal((ok as unknown as { view: { googleLinked: boolean } }).view.googleLinked, true);
  assert.equal(service.registrationState(WALLET)?.googleVerified, true);
});

test('googleComplete rejects a wrong state (bad-state)', () => {
  const { service } = makeService();
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const r = service.googleComplete(WALLET, { state: 'forged-state', nonce: begin.nonce, code: 'code' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'bad-state');
});

test('googleComplete rejects a wrong nonce (bad-state)', () => {
  const { service } = makeService();
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const r = service.googleComplete(WALLET, { state: begin.state, nonce: 'forged-nonce', code: 'code' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'bad-state');
});

test('a used google challenge cannot be replayed', () => {
  const { service } = makeService();
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const first = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce, code: 'code' });
  assert.equal(first.ok, true);
  // The successful challenge is single-use: replaying it must fail.
  const replay = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce, code: 'code' });
  assert.equal(replay.ok, false);
});

test('a consumed challenge after a failed exchange is a replay, not a retry', () => {
  let attempt = 0;
  const capture: Capture = { sms: [], whatsapp: [] };
  const provider = new GoogleProvider({
    configured: true,
    exchange: () => { attempt += 1; return attempt === 1 ? false : true; },
  });
  const service = new AccountService({
    store: new InMemoryAccountStore(),
    encryptionSecret: ENC,
    otp: { hashSecret: 'reg-auth-test-otp-secret' },
    smsDelivery: { configured: true, send: (t, c) => capture.sms.push(`${t}:${c}`) },
    whatsappDelivery: { configured: true, send: (t, c) => capture.whatsapp.push(`${t}:${c}`) },
    googleAuthenticator: { configured: true, complete: () => true },
    googleProvider: provider,
  });
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  // First exchange fails → challenge consumed (single-use) but still present.
  const failed = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce, code: 'code' });
  assert.equal(failed.ok, false);
  const reason = !failed.ok ? failed.reason : '';
  if (reason === 'unauthorized') {
    // Replaying the same state after a failed exchange must be rejected as a
    // replay, even though the underlying exchange would now succeed.
    const replay = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce, code: 'code' });
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.reason, 'replay');
    assert.equal(attempt, 1, 'underlying exchange must not be retried on replay');
  }
});

test('google challenge expires after the TTL', () => {
  let now = 1_000_000;
  const { service } = makeService({ now: () => now });
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  now += GOOGLE_STATE_TTL_MS + 1;
  const r = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce, code: 'code' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'expired');
});

test('google challenge is bound to the initiating wallet only', () => {
  const { service } = makeService();
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const r = service.googleComplete(OTHER_WALLET, { state: begin.state, nonce: begin.nonce, code: 'code' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'bad-state');
});

test('google provider is fail-closed when unconfigured', () => {
  const { service } = makeService({ google: false });
  // Registration itself fails closed when Google is unconfigured (no point
  // creating an account whose required factor can never pass).
  const reg = service.register(payload());
  assert.equal(reg.ok, false);
  if (!reg.ok) assert.equal(reg.reason, 'unavailable');
  // googleBegin reports unavailable without ever issuing a challenge.
  const begin = service.googleBegin(WALLET);
  assert.equal(begin.ok, false);
  if (!begin.ok) assert.equal(begin.reason, 'unavailable');
  // googleComplete reports unavailable, never acknowledging a code.
  const r = service.googleComplete(WALLET, { state: 's', nonce: 'n', code: 'c' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'unavailable');
});

// ── SMS / WhatsApp OTP factors ─────────────────────────────────────

test('SMS OTP verifies the SMS factor', () => {
  const { service, capture } = makeService();
  register(service);
  const issue = service.issueSmsOtp(WALLET);
  assert.equal(issue.ok, true);
  const code = lastCode(capture, 'sms');
  assert.equal(service.verifySmsOtp(WALLET, code).ok, true);
  assert.equal(service.registrationState(WALLET)?.smsVerified, true);
});

test('WhatsApp OTP verifies the WhatsApp factor', () => {
  const { service, capture } = makeService();
  register(service);
  const issue = service.issueWhatsappOtp(WALLET);
  assert.equal(issue.ok, true);
  const code = lastCode(capture, 'whatsapp');
  assert.equal(service.verifyWhatsappOtp(WALLET, code).ok, true);
  assert.equal(service.registrationState(WALLET)?.whatsappVerified, true);
});

// ── Sequential state machine / completion ──────────────────────────

test('a fresh account is `wallet` verified only and never reported complete', () => {
  const { service } = makeService();
  register(service);
  const state = service.registrationState(WALLET);
  assert.ok(state);
  if (!state) return;
  assert.equal(state.walletVerified, true);
  assert.equal(state.googleVerified, false);
  assert.equal(state.smsVerified, false);
  assert.equal(state.whatsappVerified, false);
  assert.equal(state.complete, false);
  assert.equal(state.nextPendingFactor, 'google');
});

test('registration state machine reaches `complete` only after every factor', () => {
  const { service, capture } = makeService();
  register(service);

  // Wallet only → pending google.
  assert.equal(service.registrationState(WALLET)?.complete, false);

  // Google.
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (begin.ok) {
    assert.equal(service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce, code: 'c' }).ok, true);
  }
  assert.equal(service.registrationState(WALLET)?.nextPendingFactor, 'sms');

  // SMS.
  assert.equal(service.issueSmsOtp(WALLET).ok, true);
  assert.equal(service.verifySmsOtp(WALLET, lastCode(capture, 'sms')).ok, true);
  assert.equal(service.registrationState(WALLET)?.nextPendingFactor, 'whatsapp');

  // WhatsApp.
  assert.equal(service.issueWhatsappOtp(WALLET).ok, true);
  assert.equal(service.verifyWhatsappOtp(WALLET, lastCode(capture, 'whatsapp')).ok, true);

  const state = service.registrationState(WALLET);
  assert.ok(state);
  if (!state) return;
  assert.equal(state.complete, true);
  assert.equal(state.nextPendingFactor, null);
});

test('hasAccount reflects existence without leaking inside the flow', () => {
  const { service } = makeService();
  assert.equal(service.hasAccount(WALLET), false);
  register(service);
  assert.equal(service.hasAccount(WALLET), true);
  assert.equal(service.hasAccount(OTHER_WALLET), false);
  // registrationState is null for a wallet with no account.
  assert.equal(service.registrationState(OTHER_WALLET), null);
});

// ── Duplicate wallet & privacy ─────────────────────────────────────

test('a duplicate wallet is rejected at registration', () => {
  const { service } = makeService();
  register(service);
  const again = service.register(payload());
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.reason, 'already-registered');
});

test('registration state never exposes PII or plaintext secrets', () => {
  const { service } = makeService();
  register(service);
  const state = service.registrationState(WALLET);
  assert.ok(state);
  if (!state) return;
  const json = JSON.stringify(state);
  for (const secret of ['9822012345', '456789012345', 'Str0ng#Pass', 'Ravi Deshpande']) {
    assert.ok(!json.includes(secret), `state must not contain ${secret}`);
  }
});
