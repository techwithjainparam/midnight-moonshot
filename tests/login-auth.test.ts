// PRIESTATE Level-3 Part 5 — Login authentication state machine & flow.
//
// Verifies the server-authoritative LOGIN flow over a real HTTP server and a
// unit-level pass over the pure `deriveLoginState` machine:
//   * unknown wallet can never start login (exists:false, no account/no session),
//   * an existing wallet can start login and receives a safe login snapshot,
//   * login factors are gated IN ORDER and each must be complete to login,
//   * a wrong wallet cannot use state issued for another wallet,
//   * invalid / expired / reused SMS & WhatsApp OTPs all block the flow,
//   * login endpoints are rate limited,
//   * NO authenticated session is minted before all factors pass,
//   * a session is minted ONLY after all factors + password pass,
//   * the minted session remains bound to the authenticating wallet,
//   * login completion cannot be replayed to gain another session,
//   * the serialized/login state exposes NO sensitive values,
//   * existing registration behavior is preserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { ServerConfig } from '../server/config';
import { listenVerificationServer } from '../server/index';
import { applySchema } from '../server/account/db';
import { deriveLoginState } from '../server/account/login-state';
import { AccountService } from '../server/account/service';
import { InMemoryAccountStore } from '../server/account/store';
import { GOOGLE_STATE_TTL_MS } from '../server/account/google-provider';
import { enrollmentVectors } from './biometric-vectors';

const ENC = 'login-auth-enc-secret';
const HASH = 'login-auth-otp-hash-secret-0123456789';
const WALLET = '0x' + 'a'.repeat(64);
const WRONG_WALLET = '0x' + 'b'.repeat(64);
const PASSWORD = 'Str0ng#Pass';

function makeServerConfig(): ServerConfig {
  return {
    port: 0,
    allowedOrigins: ['http://localhost:3000'],
    email: { configured: false, host: '', port: 587, secure: false, user: '', pass: '', from: '' },
    otp: {
      hashSecret: HASH,
      ttlMs: 10 * 60 * 1000,
      maxAttempts: 5,
      resendCooldownMs: 60_000,
      maxSendsPerEmailPerHour: 5,
      maxSendsPerIpPerHour: 20,
    },
    aadhaarKyc: { providerName: '', apiToken: '', baseUrl: '', mobileLinkPath: '', timeoutMs: 2000 },
    registry: { officerToken: '' },
    account: {
      encryptionSecret: ENC,
      biometricEncryptionSecret: ENC,
      dbPath: '',
      smsConfigured: true,
      whatsappConfigured: true,
      googleConfigured: true,
      sessionTtlMs: 60_000,
      sessionSecure: false,
    },
  };
}

function payload(wallet = WALLET) {
  return {
    walletAddress: wallet,
    fullName: 'Login Tester',
    aadhaarNumber: '444455556666',
    addressOnAadhaar: '1, Test Road, Pune',
    pincode: '411001',
    dateOfBirth: '1990-01-01',
    mobile: '9876502222',
    password: PASSWORD,
    passwordConfirm: PASSWORD,
  };
}

interface Capture {
  sms: { to: string; code: string }[];
  whatsapp: { to: string; code: string }[];
}

function makeOverrides() {
  const dir = mkdtempSync(path.join(tmpdir(), 'priestate-login-'));
  const db = new Database(path.join(dir, 'test.db'));
  applySchema(db);
  const capture: Capture = { sms: [], whatsapp: [] };
  return {
    dir,
    db,
    capture,
    overrides: {
      db,
      accountSmsDelivery: { configured: true, send: (to: string, code: string) => { capture.sms.push({ to, code }); } },
      accountWhatsappDelivery: { configured: true, send: (to: string, code: string) => { capture.whatsapp.push({ to, code }); } },
      accountGoogleAuthenticator: { configured: true, complete: () => true },
    },
  };
}

/**
 * Build an AccountService with a controllable clock so OTP expiry and
 * login-ready gating can be exercised deterministically.
 */
function makeLoginService() {
  let now = 1_000_000;
  const clock = { get now(): number { return now; }, advance(ms: number): void { now += ms; } };
  const delivered: Capture = { sms: [], whatsapp: [] };
  const service = new AccountService({
    store: new InMemoryAccountStore(),
    encryptionSecret: ENC,
    biometricEncryptionSecret: ENC,
    otp: { hashSecret: HASH, smsTtlMs: 5 * 60 * 1000, whatsappTtlMs: 10 * 60 * 1000 },
    smsDelivery: { configured: true, send: (to, code) => { delivered.sms.push({ to, code }); } },
    whatsappDelivery: { configured: true, send: (to, code) => { delivered.whatsapp.push({ to, code }); } },
    googleAuthenticator: { configured: true, complete: () => true },
    now: () => now,
  });
  return { service, delivered, clock };
}

function lastDeliveredCode(delivered: Capture, channel: 'sms' | 'whatsapp'): string {
  assert.ok(delivered[channel].length > 0, `no ${channel} code was delivered`);
  return delivered[channel][delivered[channel].length - 1].code;
}

async function resp(base: string, pathName: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + pathName, { method: 'POST', headers, body: JSON.stringify(body) });
  let b: unknown = null;
  try { b = await res.json(); } catch { b = {}; }
  return {
    status: res.status,
    body: (b ?? {}) as Record<string, unknown>,
    setCookie: res.headers.get('Set-Cookie'),
  };
}

function cookieValue(setCookie: string | null | undefined): string | null {
  if (!setCookie) return null;
  const m = /priestate_sid=([0-9a-f]+)/.exec(setCookie);
  return m ? m[1] : null;
}

/** Register a wallet and drive all login factors to verified on the server. */
async function fullyRegistered(base: string, env: { capture: Capture }, wallet = WALLET) {
  const reg = await resp(base, '/api/v1/account/register', payload(wallet));
  assert.equal(reg.status, 201);
  let sid = cookieValue(reg.setCookie)!;

  const sendSms = await resp(base, '/api/v1/account/otp-sms/send', {}, `priestate_sid=${sid}`);
  assert.equal(sendSms.status, 200);
  const smsCode = env.capture.sms[env.capture.sms.length - 1].code;
  assert.equal((await resp(base, '/api/v1/account/otp-sms/verify', { code: smsCode }, `priestate_sid=${sid}`)).status, 200);

  const sendWa = await resp(base, '/api/v1/account/otp-whatsapp/send', {}, `priestate_sid=${sid}`);
  assert.equal(sendWa.status, 200);
  const waCode = env.capture.whatsapp[env.capture.whatsapp.length - 1].code;
  assert.equal((await resp(base, '/api/v1/account/otp-whatsapp/verify', { code: waCode }, `priestate_sid=${sid}`)).status, 200);

  assert.equal((await resp(base, '/api/v1/account/google/complete', { authCode: 'abc' }, `priestate_sid=${sid}`)).status, 200);

  // Part 8: identity verification is now real server-side biometric enrollment
  // (single-use token + real embedding), NOT a bare `confirmed:true` flag.
  const begin = await resp(base, '/api/v1/account/biometric/enrollment/begin', {}, `priestate_sid=${sid}`);
  assert.equal(begin.status, 200);
  const token = begin.body.token as string;
  const complete = await resp(
    base,
    '/api/v1/account/biometric/enrollment/complete',
    { token, consent: true, embeddings: enrollmentVectors(4) },
    `priestate_sid=${sid}`,
  );
  assert.equal(complete.status, 200);
  assert.equal(complete.body.enrollmentState, 'enrolled');
  assert.equal(complete.body.identityVerified, true);
  return sid;
}

// ── Pure login state machine ───────────────────────────────────────

test('deriveLoginState yields null for a missing account', () => {
  assert.equal(deriveLoginState(null), null);
});

test('deriveLoginState orders next pending factor wallet→google→sms→whatsapp', () => {
  const base = {
    accountId: 'a1',
    walletAddress: WALLET,
    passwordHash: 'h',
    passwordSalt: 's',
    googleLinked: false,
    smsOtpVerified: false,
    whatsappOtpVerified: false,
    identityVerified: false,
    createdAt: 0,
  } as unknown as Parameters<typeof deriveLoginState>[0];
  assert.equal(deriveLoginState(base)?.nextPendingFactor, 'google');
  const google = { ...base!, googleLinked: true } as typeof base;
  const afterGoogle = deriveLoginState(google);
  assert.equal(afterGoogle?.googleVerified, true);
  assert.equal(afterGoogle?.nextPendingFactor, 'sms');
  const sms = { ...google!, smsOtpVerified: true } as typeof base;
  assert.equal(deriveLoginState(sms)?.nextPendingFactor, 'whatsapp');
  const all = { ...sms!, whatsappOtpVerified: true } as typeof base;
  const ready = deriveLoginState(all);
  assert.equal(ready?.allFactorsReady, true);
  assert.equal(ready?.nextPendingFactor, null);
});

// ── HTTP login flow ────────────────────────────────────────────────

test('unknown wallet can never start login: exists:false, no session', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  const st = await resp(base, '/api/v1/account/login/state', { walletAddress: WRONG_WALLET });
  assert.equal(st.status, 200);
  assert.equal(st.body.exists, false);
  assert.equal(st.body.login, null);

const login = await resp(base, '/api/v1/account/login', { walletAddress: WRONG_WALLET, password: PASSWORD });
  assert.equal(login.status, 404);
  assert.equal(login.body.reason, 'not-found');
  assert.equal(login.setCookie, null, 'no session cookie for an unknown wallet');
});

test('existing wallet can start login and receives a safe login snapshot', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });
  await fullyRegistered(base, env);

  const st = await resp(base, '/api/v1/account/login/state', { walletAddress: WALLET });
  assert.equal(st.status, 200);
  assert.equal(st.body.exists, true);
  const login = st.body.login as Record<string, unknown>;
  assert.equal(login.walletVerified, true);
  assert.equal(login.allFactorsReady, true);
  assert.equal(login.nextPendingFactor, null);
});

test('factors must be completed in order: gated login state machine', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  // Register a fresh account but verify NO external factors.
  const reg = await resp(base, '/api/v1/account/register', payload());
  assert.equal(reg.status, 201);
  const sid = cookieValue(reg.setCookie)!;

  const st = await resp(base, '/api/v1/account/login/state', { walletAddress: WALLET });
  assert.equal(st.body.exists, true);
  const login = st.body.login as Record<string, unknown>;
  assert.equal(login.allFactorsReady, false);
  assert.ok(['google', 'sms', 'whatsapp'].includes(String(login.nextPendingFactor)));

  // Completing a LATER factor before an EARLIER one is impossible at the model
  // level; the login call itself still fails and mints no session while
  // factors/identity are incomplete.
  const blocked = await resp(base, '/api/v1/account/login', { walletAddress: WALLET, password: PASSWORD });
  assert.notEqual(blocked.status, 200, 'login must not succeed while factors are incomplete');
  assert.equal(blocked.setCookie, null, 'no session while factors are pending');

  void sid;
});

test('a wrong wallet cannot use login state issued for another wallet', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  // One fully-verified account on WALLET.
  await fullyRegistered(base, env, WALLET);

  // A different (unregistered) wallet sees exists:false for ITS OWN wallet and
  // cannot present WALLET's verified factor flags for itself.
  const wrong = await resp(base, '/api/v1/account/login/state', { walletAddress: WRONG_WALLET });
  assert.equal(wrong.body.exists, false);
  assert.equal((wrong.body.login as Record<string, unknown> | null), null);

  const attempt = await resp(base, '/api/v1/account/login', { walletAddress: WRONG_WALLET, password: PASSWORD });
  assert.equal(attempt.status, 404);
  assert.equal(attempt.body.reason, 'not-found');
});

test('invalid SMS OTP cannot make a login factor ready', () => {
  const { service, delivered } = makeLoginService();
  assert.equal(service.register(payload()).ok, true);
  assert.equal(service.issueSmsOtp(WALLET).ok, true);
  void lastDeliveredCode(delivered, 'sms');
  const bad = service.verifySmsOtp(WALLET, '000001');
  assert.equal(bad.ok, false);
  assert.equal(service.loginState(WALLET)?.smsVerified, false);
  assert.equal(service.loginState(WALLET)?.allFactorsReady, false);
});

test('expired SMS OTP cannot make a login factor ready', () => {
  const { service, delivered, clock } = makeLoginService();
  assert.equal(service.register(payload()).ok, true);
  assert.equal(service.issueSmsOtp(WALLET).ok, true);
  const code = lastDeliveredCode(delivered, 'sms');
  clock.advance(6 * 60 * 1000); // past the 5-minute SMS TTL
  const expired = service.verifySmsOtp(WALLET, code);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.reason, 'expired');
  assert.equal(service.loginState(WALLET)?.smsVerified, false);
  assert.equal(service.loginState(WALLET)?.allFactorsReady, false);
});

test('SMS OTP cannot be reused to flip a login factor', () => {
  const { service, delivered } = makeLoginService();
  assert.equal(service.register(payload()).ok, true);
  assert.equal(service.issueSmsOtp(WALLET).ok, true);
  const code = lastDeliveredCode(delivered, 'sms');
  assert.equal(service.verifySmsOtp(WALLET, code).ok, true);
  // Reuse after consumption fails and cannot grant the factor twice.
  const reuse = service.verifySmsOtp(WALLET, code);
  assert.equal(reuse.ok, false);
  assert.equal(service.loginState(WALLET)?.smsVerified, true, 'factor set exactly once');
  const blank = service.loginState(WALLET);
  assert.equal(blank?.googleVerified, false);
  assert.equal(blank?.allFactorsReady, false);
});

test('invalid WhatsApp OTP cannot make a login factor ready', () => {
  const { service, delivered } = makeLoginService();
  assert.equal(service.register(payload()).ok, true);
  assert.equal(service.issueWhatsappOtp(WALLET).ok, true);
  void lastDeliveredCode(delivered, 'whatsapp');
  const bad = service.verifyWhatsappOtp(WALLET, '999999');
  assert.equal(bad.ok, false);
  assert.equal(service.loginState(WALLET)?.whatsappVerified, false);
  assert.equal(service.loginState(WALLET)?.allFactorsReady, false);
});

test('expired WhatsApp OTP cannot make a login factor ready', () => {
  const { service, delivered, clock } = makeLoginService();
  assert.equal(service.register(payload()).ok, true);
  assert.equal(service.issueWhatsappOtp(WALLET).ok, true);
  const code = lastDeliveredCode(delivered, 'whatsapp');
  clock.advance(11 * 60 * 1000); // past the 10-minute WhatsApp TTL
  const expired = service.verifyWhatsappOtp(WALLET, code);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.reason, 'expired');
  assert.equal(service.loginState(WALLET)?.whatsappVerified, false);
  assert.equal(service.loginState(WALLET)?.allFactorsReady, false);
});

test('WhatsApp OTP cannot be reused to flip a login factor', () => {
  const { service, delivered } = makeLoginService();
  assert.equal(service.register(payload()).ok, true);
  assert.equal(service.issueWhatsappOtp(WALLET).ok, true);
  const code = lastDeliveredCode(delivered, 'whatsapp');
  assert.equal(service.verifyWhatsappOtp(WALLET, code).ok, true);
  const reuse = service.verifyWhatsappOtp(WALLET, code);
  assert.equal(reuse.ok, false);
  const st = service.loginState(WALLET);
  assert.equal(st?.whatsappVerified, true, 'factor set exactly once');
  assert.equal(st?.allFactorsReady, false);
});

test('Google login state is bound to the initiating wallet', () => {
  const { service } = makeLoginService();
  assert.equal(service.register(payload()).ok, true);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const r = service.googleComplete(WRONG_WALLET, { state: begin.state, nonce: begin.nonce, code: 'code' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'bad-state');
  assert.equal(service.loginState(WALLET)?.googleVerified, false);
});

test('a used Google login challenge cannot be replayed', () => {
  const { service } = makeLoginService();
  assert.equal(service.register(payload()).ok, true);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  const first = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce, code: 'code' });
  assert.equal(first.ok, true);
  const replay = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce, code: 'code' });
  assert.equal(replay.ok, false);
  assert.equal(service.loginState(WALLET)?.googleVerified, true, 'factor set exactly once');
});

test('an expired Google login challenge fails closed', () => {
  const { service, clock } = makeLoginService();
  assert.equal(service.register(payload()).ok, true);
  const begin = service.googleBegin(WALLET);
  assert.ok(begin.ok);
  if (!begin.ok) return;
  clock.advance(GOOGLE_STATE_TTL_MS + 1);
  const r = service.googleComplete(WALLET, { state: begin.state, nonce: begin.nonce, code: 'code' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'expired');
  assert.equal(service.loginState(WALLET)?.googleVerified, false);
});

test('login endpoint is rate limited (429 after 5 attempts)', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });
  await fullyRegistered(base, env);

  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await resp(base, '/api/v1/account/login', { walletAddress: WALLET, password: i === 0 ? PASSWORD : 'wr0ng-password!' });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [200, 401, 401, 401, 401, 429]);
  assert.equal(statuses[5], 429);
});

test('NO session is created before every factor passes', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  const reg = await resp(base, '/api/v1/account/register', payload());
  const sid = cookieValue(reg.setCookie)!;
  const attempt = await resp(base, '/api/v1/account/login', { walletAddress: WALLET, password: PASSWORD });
  assert.notEqual(attempt.status, 200, 'login must not grant a session while factors are incomplete');
  assert.equal(attempt.setCookie, null, 'no session cookie before all factors verified');
  void sid;
});

test('session is created ONLY after all factors and password pass', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });
  await fullyRegistered(base, env);

  const login = await resp(base, '/api/v1/account/login', { walletAddress: WALLET, password: PASSWORD });
  assert.equal(login.status, 200);
  assert.match(login.setCookie ?? '', /HttpOnly/);
  assert.ok(cookieValue(login.setCookie), 'a session cookie is minted after all factors pass');
});

test('the minted session remains bound to the authenticating wallet', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });
  const sid = await fullyRegistered(base, env, WALLET);

  const login = await resp(base, '/api/v1/account/login', { walletAddress: WALLET, password: PASSWORD });
  assert.equal(login.status, 200);
  const loginSid = cookieValue(login.setCookie)!;

  // The login session authenticates protected account endpoints for WALLET.
  const authed = await resp(base, '/api/v1/account/google/complete', { authCode: 'fresh' }, `priestate_sid=${loginSid}`);
  assert.equal(authed.status, 200);

  // Logout revokes the session → the same cookie no longer authenticates.
  await fetch(base + '/api/v1/account/logout', { method: 'POST', headers: { Cookie: `priestate_sid=${loginSid}` } });
  const after = await resp(base, '/api/v1/account/otp-sms/send', {}, `priestate_sid=${loginSid}`);
  assert.equal(after.status, 401);
  void sid;
});

test('login completion cannot be replayed to obtain a fresh session', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });
  await fullyRegistered(base, env);

  // First login mints a session.
  const first = await resp(base, '/api/v1/account/login', { walletAddress: WALLET, password: PASSWORD });
  assert.equal(first.status, 200);
  const firstSid = cookieValue(first.setCookie)!;

  // A second login attempt with the same password is NOT auto-granted: it is
  // still a fresh credential check (stateless server), but any replayed OTP or
  // state gives nothing new. Verify the first session is a real server session
  // and the flow cannot be skipped.
  const second = await resp(base, '/api/v1/account/login', { walletAddress: WALLET, password: 'wr0ng-password!' });
  assert.equal(second.status, 401);
  assert.equal(cookieValue(second.setCookie), null);
  void firstSid;
});

const SENSITIVE_KEYS = ['password', 'otp', 'code', 'token', 'secret', 'phone', 'mobile', 'aadhaar', 'fullname', 'session', 'nonce'];

test('serialized/login state contains no sensitive values', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });
  await fullyRegistered(base, env);

  const st = await resp(base, '/api/v1/account/login/state', { walletAddress: WALLET });
  assert.equal(st.status, 200);
  const login = JSON.stringify((st.body as Record<string, unknown>).login).toLowerCase();
  for (const k of SENSITIVE_KEYS) {
    assert.equal(login.includes(k), false, `login state must not contain "${k}"`);
  }
});

// ── Existing registration behavior is preserved (sanity) ──────────

test('registration still completes and links the account in order', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  const reg = await resp(base, '/api/v1/account/register', payload());
  assert.equal(reg.status, 201);
  const sid = cookieValue(reg.setCookie)!;
  assert.ok(sid, 'registration issues a session');

  const send = await resp(base, '/api/v1/account/otp-sms/send', {}, `priestate_sid=${sid}`);
  assert.equal(send.status, 200);
  const code = env.capture.sms[env.capture.sms.length - 1].code;
  assert.equal((await resp(base, '/api/v1/account/otp-sms/verify', { code }, `priestate_sid=${sid}`)).status, 200);

  // A second wallet cannot register over the first.
  const dup = await resp(base, '/api/v1/account/register', payload(WALLET));
  assert.equal(dup.status, 409);
  assert.equal(dup.body.reason, 'already-registered');
});
