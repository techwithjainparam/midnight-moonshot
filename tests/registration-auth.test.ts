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
import type { GoogleProviderConfig } from '../server/account/google-provider';
import { createGoogleTestKit, type GoogleTestKit } from './helpers/google-oauth-kit';
import type { SmsSendResult, WhatsAppSendResult } from './helpers/provider-types';

const ENC = 'reg-auth-test-enc-secret';
const WALLET = '0x' + 'c'.repeat(64);
const OTHER_WALLET = '0x' + 'd'.repeat(64);

interface Capture { sms: string[]; whatsapp: string[] }

function makeService(over: {
  google?: boolean;            // provider configured?
  googleAccept?: boolean;      // underlying exchange outcome
  now?: () => number;
} = {}): { service: AccountService; capture: Capture; kit: GoogleTestKit } {
  const capture: Capture = { sms: [], whatsapp: [] };
  const kit = createGoogleTestKit({ accept: over.googleAccept ?? true, now: over.now });
  const provider = kit.provider;
  const service = new AccountService({
    store: new InMemoryAccountStore(),
    encryptionSecret: ENC,
    otp: { hashSecret: 'reg-auth-test-otp-secret' },
    smsProvider: {
      name: 'capture',
      configured: true,
      send: async (to, code): Promise<SmsSendResult> => { capture.sms.push(`${to}:${code}`); return { ok: true }; },
    },
    whatsAppProvider: {
      name: 'capture',
      configured: true,
      send: async (to, code): Promise<WhatsAppSendResult> => { capture.whatsapp.push(`${to}:${code}`); return { ok: true }; },
    },
    googleProvider: provider,
  });
  return { service, capture, kit };
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

/**
 * A provider whose verifier can be flipped mid-test, to prove a failed
 * exchange never lets a challenge complete (auth is never fabricated).
 */
function makeFlippableProvider(initialAccept: boolean): {
  provider: GoogleProvider;
  kit: GoogleTestKit;
  setAccept: (accept: boolean) => void;
} {
  const kit = createGoogleTestKit({ accept: initialAccept });
  return { provider: kit.provider, kit, setAccept: kit.setAccept };
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

test('googleComplete succeeds after a verified redirect with the matching nonce', async () => {
  const { service, kit } = makeService();
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const code = kit.devAuthorizationCode(begin.nonce);
  assert.equal((await service.googleOAuthRedirect({ state: begin.state, code })).ok, true);
  const ok = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal((ok as unknown as { view: { googleLinked: boolean } }).view.googleLinked, true);
  assert.equal(service.registrationState(WALLET)?.googleVerified, true);
});

test('complete() never fabricates auth without a verified redirect', async () => {
  const { service, kit } = makeService();
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  // Begin-only (no redirect exchange): the challenge is NOT consumable.
  const soft = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce });
  assert.equal(soft.ok, false);
  if (!soft.ok) assert.equal(soft.reason, 'unauthorized');
  assert.equal(service.registrationState(WALLET)?.googleVerified, false);
  // A garbage code fails the redirect exchange — still nothing to complete.
  const failed = await service.googleOAuthRedirect({ state: begin.state, code: 'bogus-code' });
  assert.equal(failed.ok, false);
  const afterFail = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce });
  assert.equal(afterFail.ok, false);
  assert.equal(service.registrationState(WALLET)?.googleVerified, false);
  void kit;
});

test('googleComplete rejects a wrong state (bad-state)', async () => {
  const { service, kit } = makeService();
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const code = kit.devAuthorizationCode(begin.nonce);
  assert.equal((await service.googleOAuthRedirect({ state: begin.state, code })).ok, true);
  const r = service.googleComplete(WALLET, { state: 'forged-state', nonce: begin.nonce });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'bad-state');
});

test('googleComplete rejects a wrong nonce (bad-state)', async () => {
  const { service, kit } = makeService();
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const code = kit.devAuthorizationCode(begin.nonce);
  assert.equal((await service.googleOAuthRedirect({ state: begin.state, code })).ok, true);
  const r = service.googleComplete(WALLET, { state: begin.state, nonce: 'forged-nonce' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'bad-state');
});

test('a used google challenge cannot be replayed', async () => {
  const { service, kit } = makeService();
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const code = kit.devAuthorizationCode(begin.nonce);
  assert.equal((await service.googleOAuthRedirect({ state: begin.state, code })).ok, true);
  const first = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce });
  assert.equal(first.ok, true);
  // The successful challenge is single-use: replaying it must fail.
  const replay = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce });
  assert.equal(replay.ok, false);
});

test('a failed exchange never fabricates success, even if it later succeeds', async () => {
  const { provider, kit, setAccept } = makeFlippableProvider(false);
  const capture: Capture = { sms: [], whatsapp: [] };
  const service = new AccountService({
    store: new InMemoryAccountStore(),
    encryptionSecret: ENC,
    otp: { hashSecret: 'reg-auth-test-otp-secret' },
    smsProvider: {
      name: 'capture',
      configured: true,
      send: async (to, code): Promise<SmsSendResult> => { capture.sms.push(`${to}:${code}`); return { ok: true }; },
    },
    whatsAppProvider: {
      name: 'capture',
      configured: true,
      send: async (to, code): Promise<WhatsAppSendResult> => { capture.whatsapp.push(`${to}:${code}`); return { ok: true }; },
    },
    googleProvider: provider,
  });
  register(service);

  // Verifier rejects (e.g. wrong audience) → redirect fails.
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const failed = await service.googleOAuthRedirect({ state: begin.state, code: kit.devAuthorizationCode(begin.nonce) });
  assert.equal(failed.ok, false);
  // complete() is impossible even with the right nonce — nothing was verified.
  const soft = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce });
  assert.equal(soft.ok, false);
  if (!soft.ok) assert.equal(soft.reason, 'unauthorized');
  assert.equal(service.registrationState(WALLET)?.googleVerified, false);

  // Verifier now accepts. The SAME state's one-shot authorization code was
  // already redeemed by the failed attempt, so a fresh challenge + code is
  // required — never a silent retry of the failed one.
  setAccept(true);
  const second = service.googleBegin(WALLET);
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal((await service.googleOAuthRedirect({ state: second.state, code: kit.devAuthorizationCode(second.nonce) })).ok, true);
  assert.equal(service.googleComplete(WALLET, { state: second.state, nonce: second.nonce }).ok, true);
  assert.equal(service.registrationState(WALLET)?.googleVerified, true);
});

test('google challenge expires after the TTL', async () => {
  let now = 1_000_000;
  const { service, kit } = makeService({ now: () => now });
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const code = kit.devAuthorizationCode(begin.nonce);
  assert.equal((await service.googleOAuthRedirect({ state: begin.state, code })).ok, true);
  now += GOOGLE_STATE_TTL_MS + 1;
  const r = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'expired');
});

test('google challenge is bound to the initiating wallet only', async () => {
  const { service, kit } = makeService();
  register(service);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const code = kit.devAuthorizationCode(begin.nonce);
  assert.equal((await service.googleOAuthRedirect({ state: begin.state, code })).ok, true);
  const r = service.googleComplete(OTHER_WALLET, { state: begin.state, nonce: begin.nonce });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'bad-state');
});

test('google provider is fail-closed when unconfigured', () => {
  // Build the service directly with an unconfigured Google provider.
  const capture: Capture = { sms: [], whatsapp: [] };
  const provider = new GoogleProvider(makeUnconfiguredConfig());
  const service = new AccountService({
    store: new InMemoryAccountStore(),
    encryptionSecret: ENC,
    otp: { hashSecret: 'reg-auth-test-otp-secret' },
    smsProvider: {
      name: 'capture',
      configured: true,
      send: async (to, code): Promise<SmsSendResult> => { capture.sms.push(`${to}:${code}`); return { ok: true }; },
    },
    whatsAppProvider: {
      name: 'capture',
      configured: true,
      send: async (to, code): Promise<WhatsAppSendResult> => { capture.whatsapp.push(`${to}:${code}`); return { ok: true }; },
    },
    googleProvider: provider,
  });
  // Registration itself fails closed when Google is unconfigured (no point
  // creating an account whose required factor can never pass).
  const reg = service.register(payload());
  assert.equal(reg.ok, false);
  if (!reg.ok) assert.equal(reg.reason, 'unavailable');
  // googleBegin reports unavailable without ever issuing a challenge.
  const begin = service.googleBegin(WALLET);
  assert.equal(begin.ok, false);
  if (!begin.ok) assert.equal(begin.reason, 'unavailable');
  // googleComplete reports unavailable, never acknowledging a challenge.
  const r = service.googleComplete(WALLET, { state: 's', nonce: 'n' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'unavailable');
});

function makeUnconfiguredConfig(): GoogleProviderConfig {
  return {
    configured: false,
    authorizeEndpoint: '',
    tokenEndpoint: '',
    userinfoEndpoint: '',
    clientId: '',
    clientSecret: '',
    redirectUri: '',
    tokenVerifier: null,
    now: () => 1_000_000,
  };
}

// ── SMS / WhatsApp OTP factors ─────────────────────────────────────

test('SMS OTP verifies the SMS factor', async () => {
  const { service, capture } = makeService();
  register(service);
  const issue = await service.issueSmsOtp(WALLET);
  assert.equal(issue.ok, true);
  const code = lastCode(capture, 'sms');
  assert.equal(service.verifySmsOtp(WALLET, code).ok, true);
  assert.equal(service.registrationState(WALLET)?.smsVerified, true);
});

test('WhatsApp OTP verifies the WhatsApp factor', async () => {
  const { service, capture } = makeService();
  register(service);
  const issue = await service.issueWhatsappOtp(WALLET);
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
  assert.equal(state.nextPendingFactor, 'sms');
});

test('registration state machine reaches `complete` only after every factor', async () => {
  const { service, capture, kit } = makeService();
  register(service);

  // Wallet only → pending google.
  assert.equal(service.registrationState(WALLET)?.complete, false);

  // Google.
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (begin.ok) {
    assert.equal((await service.googleOAuthRedirect({ state: begin.state, code: kit.devAuthorizationCode(begin.nonce) })).ok, true);
    assert.equal(service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce }).ok, true);
  }
  assert.equal(service.registrationState(WALLET)?.nextPendingFactor, 'sms');

  // SMS.
  assert.equal((await service.issueSmsOtp(WALLET)).ok, true);
  assert.equal(service.verifySmsOtp(WALLET, lastCode(capture, 'sms')).ok, true);
  assert.equal(service.registrationState(WALLET)?.nextPendingFactor, 'whatsapp');

  // WhatsApp.
  assert.equal((await service.issueWhatsappOtp(WALLET)).ok, true);
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
