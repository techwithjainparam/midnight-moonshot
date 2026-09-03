// PRIESTATE Level-3 Part 2 — HTTP wiring: auth-gated account endpoints,
// server-side session cookies, and rate limiting on sensitive routes.
//
// Verifies over a real HTTP server:
//   * account OTP-send requires a session cookie (401 without one),
//   * login sets an HttpOnly session cookie,
//   * the cookie authenticates subsequent requests and is revoked on logout,
//   * registration rate limit (429) kicks in after N attempts,
//   * login rate limit (429) kicks in after N attempts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { ServerConfig } from '../server/config';
import { listenVerificationServer } from '../server/index';
import { applySchema } from '../server/account/db';

const ENC = 'srv-level3-enc-secret';
const HASH = 'srv-test-otp-hash-secret-0123456789';
const WALLET = '0x' + 'c'.repeat(64);
const WALLET2 = '0x' + 'd'.repeat(64);

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
    fullName: 'Rahul Mehta',
    aadhaarNumber: '222233334444',
    addressOnAadhaar: '7, MG Road, Delhi',
    pincode: '110001',
    dateOfBirth: '1990-07-15',
    mobile: '9876501111',
    password: 'Str0ng#Pass',
    passwordConfirm: 'Str0ng#Pass',
  };
}

interface Capture {
  sms: { to: string; code: string }[];
  whatsapp: { to: string; code: string }[];
}

function makeOverrides() {
  const dir = mkdtempSync(path.join(tmpdir(), 'priestate-srv-'));
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

test('OTP-send requires a session: 401 without cookie', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  const reg = await resp(base, '/api/v1/account/register', payload());
  assert.equal(reg.status, 201);

  // Without the session cookie, OTP send is refused.
  const unauth = await resp(base, '/api/v1/account/otp-sms/send', {});
  assert.equal(unauth.status, 401);

  // Registration issued a session cookie — reuse it to send.
  const sid = cookieValue(reg.setCookie);
  assert.ok(sid);
  const withCookie = await resp(base, '/api/v1/account/otp-sms/send', {}, `priestate_sid=${sid}`);
  assert.equal(withCookie.status, 200);
});

test('Login sets HttpOnly session cookie that later authenticates; logout revokes', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  // Register + finish ALL factors so login becomes possible.
  const reg = await resp(base, '/api/v1/account/register', payload());
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
  assert.equal((await resp(base, '/api/v1/account/identity-verified', { confirmed: true }, `priestate_sid=${sid}`)).status, 200);

  // Now login with password.
  const login = await resp(base, '/api/v1/account/login', { walletAddress: WALLET, password: 'Str0ng#Pass' });
  assert.equal(login.status, 200);
  assert.match(login.setCookie ?? '', /HttpOnly/);
  const loginSid = cookieValue(login.setCookie)!;

  // The login session cookie authenticates a protected account endpoint
  // (google-complete requires a valid session and returns 200 when the
  // boundary accepts the code).
  const authed = await resp(base, '/api/v1/account/google/complete', { authCode: 'fresh' }, `priestate_sid=${loginSid}`);
  assert.equal(authed.status, 200);

  // Logout invalidates the session → same cookie now rejected.
  const logout = await fetch(base + '/api/v1/account/logout', { method: 'POST', headers: { Cookie: `priestate_sid=${loginSid}` } });
  assert.equal(logout.status, 200);
  const after = await resp(base, '/api/v1/account/otp-sms/send', {}, `priestate_sid=${loginSid}`);
  assert.equal(after.status, 401);
});

test('Registration endpoint is rate limited (429 after 3 attempts)', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  // 3 registrations pass (different wallets), 4th is limited.
  const results = [];
  for (let i = 0; i < 4; i++) {
    const p = payload('0x' + i.toString(16).padStart(64, '0'));
    results.push(await resp(base, '/api/v1/account/register', p));
  }
  assert.deepEqual(results.map((r) => r.status), [201, 201, 201, 429]);
  assert.equal(results[3].body.reason, 'rate-limited');
});

test('Login endpoint is rate limited (429 after 5 attempts)', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  // Register a valid account.
  const reg = await resp(base, '/api/v1/account/register', payload(WALLET2));
  assert.equal(reg.status, 201);
  let sid = cookieValue(reg.setCookie)!;

  // Finish all factors for WALLET2.
  const sendSms = await resp(base, '/api/v1/account/otp-sms/send', {}, `priestate_sid=${sid}`);
  assert.equal(sendSms.status, 200);
  const smsCode = env.capture.sms[env.capture.sms.length - 1].code;
  assert.equal((await resp(base, '/api/v1/account/otp-sms/verify', { code: smsCode }, `priestate_sid=${sid}`)).status, 200);
  const sendWa = await resp(base, '/api/v1/account/otp-whatsapp/send', {}, `priestate_sid=${sid}`);
  assert.equal(sendWa.status, 200);
  const waCode = env.capture.whatsapp[env.capture.whatsapp.length - 1].code;
  assert.equal((await resp(base, '/api/v1/account/otp-whatsapp/verify', { code: waCode }, `priestate_sid=${sid}`)).status, 200);
  assert.equal((await resp(base, '/api/v1/account/google/complete', { authCode: 'x' }, `priestate_sid=${sid}`)).status, 200);
  assert.equal((await resp(base, '/api/v1/account/identity-verified', { confirmed: true }, `priestate_sid=${sid}`)).status, 200);

  // 5 login attempts, all with wrong password → 401. 6th is rate limited.
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await resp(base, '/api/v1/account/login', { walletAddress: WALLET2, password: i === 0 ? 'Str0ng#Pass' : 'wr0ng-password!' });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [200, 401, 401, 401, 401, 429]);
});

test('Unauthenticated identity-verified and google-complete return 401', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  assert.equal((await resp(base, '/api/v1/account/identity-verified', { confirmed: true })).status, 401);
  assert.equal((await resp(base, '/api/v1/account/google/complete', { authCode: 'x' })).status, 401);
  assert.equal((await resp(base, '/api/v1/account/otp-whatsapp/verify', { code: '123456' })).status, 401);
});
