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
import { enrollmentVectors, sameFaceVector, differentFaceVector } from './biometric-vectors';
import { createGoogleTestKit, type GoogleTestKit } from './helpers/google-oauth-kit';
import type { SmsSendResult, WhatsAppSendResult } from './helpers/provider-types';

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
    aadhaarKyc: { providerName: '', apiToken: '', baseUrl: '', mobileLinkPath: '', authScheme: 'token', timeoutMs: 2000 },
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
  const kit = createGoogleTestKit();
  return {
    dir,
    db,
    capture,
    kit,
    overrides: {
      db,
      accountSmsProvider: {
        name: 'capture',
        configured: true,
        send: async (to: string, code: string): Promise<SmsSendResult> => { capture.sms.push({ to, code }); return { ok: true }; },
      },
      accountWhatsAppProvider: {
        name: 'capture',
        configured: true,
        send: async (to: string, code: string): Promise<WhatsAppSendResult> => { capture.whatsapp.push({ to, code }); return { ok: true }; },
      },
      accountGoogleProvider: kit.provider,
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

/**
 * Real Google flow over HTTP: begin → provider callback (code exchange
 * redirect) → complete with state+nonce. Asserts each hop succeeds.
 */
async function linkGoogleOverHttp(base: string, kit: GoogleTestKit, sid: string): Promise<void> {
  const begin = await resp(base, '/api/v1/account/google/begin', {}, `priestate_sid=${sid}`);
  assert.equal(begin.status, 200);
  const state = begin.body.state as string;
  const nonce = begin.body.nonce as string;
  const code = kit.devAuthorizationCode(nonce);
  const cb = await fetch(
    base + `/api/v1/account/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    { redirect: 'manual' },
  );
  assert.equal(cb.status, 302, 'callback redirects the popup after a verified exchange');
  const complete = await resp(base, '/api/v1/account/google/complete', { state, nonce }, `priestate_sid=${sid}`);
  assert.equal(complete.status, 200, 'google complete should succeed after a verified redirect');
}

/**
 * Part 8: real server-side biometric enrollment over HTTP (single-use token +
 * real embeddings). Replaces the removed bare `identity-verified` trust path.
 */
async function fullyEnrollOverHttp(base: string, sid: string): Promise<void> {
  // Part 9 hard-gate: enrollment requires the server-authoritative
  // registration identity evidence (liveness + live location) to be accepted.
  const evidence = await resp(
    base,
    '/api/v1/account/identity-evidence',
    {
      identityEvidence: {
        context: 'registration',
        livenessPassed: true,
        location: {
          latitude: 19.07,
          longitude: 72.87,
          accuracyMeters: 12,
          timestampMs: Date.now(),
          nonce: 'test-nonce',
        },
      },
    },
    `priestate_sid=${sid}`,
  );
  assert.equal(evidence.status, 200, 'identity evidence must be accepted');

  const begin = await resp(base, '/api/v1/account/biometric/enrollment/begin', {}, `priestate_sid=${sid}`);
  assert.equal(begin.status, 200);
  const token = begin.body.token as string;
  const done = await resp(
    base,
    '/api/v1/account/biometric/enrollment/complete',
    { token, consent: true, embeddings: enrollmentVectors(4) },
    `priestate_sid=${sid}`,
  );
  assert.equal(done.status, 200, 'enrollment should complete over HTTP');
  assert.equal(done.body.enrollmentState, 'enrolled');
  assert.equal(done.body.identityVerified, true);
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

  await linkGoogleOverHttp(base, env.kit, sid);
  await fullyEnrollOverHttp(base, sid);

  // Now login with password.
  const login = await resp(base, '/api/v1/account/login', { walletAddress: WALLET, password: 'Str0ng#Pass' });
  assert.equal(login.status, 200);
  assert.match(login.setCookie ?? '', /HttpOnly/);
  const loginSid = cookieValue(login.setCookie)!;

  // The login session cookie authenticates a protected account endpoint
  // (google-complete requires a valid session and succeeds over HTTP).
  await linkGoogleOverHttp(base, env.kit, loginSid);

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
  await linkGoogleOverHttp(base, env.kit, sid);
  await fullyEnrollOverHttp(base, sid);

  // 5 login attempts, all with wrong password → 401. 6th is rate limited.
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await resp(base, '/api/v1/account/login', { walletAddress: WALLET2, password: i === 0 ? 'Str0ng#Pass' : 'wr0ng-password!' });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [200, 401, 401, 401, 401, 429]);
});

test('Unauthenticated biometric-enrollment-begin and google-complete return 401', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  assert.equal((await resp(base, '/api/v1/account/biometric/enrollment/begin', {})).status, 401);
  assert.equal((await resp(base, '/api/v1/account/google/complete', { state: 's', nonce: 'n' })).status, 401);
  assert.equal((await resp(base, '/api/v1/account/otp-whatsapp/verify', { code: '123456' })).status, 401);
});

/**
 * Part 8 — end-to-end server-authoritative LOGIN FACE MATCHING over HTTP.
 * The reference is enrolled server-side; a live embedding is matched against
 * the stored reference; the server returns the verdict and IGNORES any
 * client-supplied `matched`/`score` claims.
 */
test('Part 8: server-authoritative login face match over HTTP', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  // Fully register + enroll.
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
  await linkGoogleOverHttp(base, env.kit, sid);
  await fullyEnrollOverHttp(base, sid);

  // Begin a verification session — no session cookie required (public-purpose
  // route), body carries the wallet; the returned token is bound to the wallet
  // + current reference version.
  const vb = await resp(base, '/api/v1/account/biometric/verification/begin', { walletAddress: WALLET });
  assert.equal(vb.status, 200);
  const token = vb.body.token as string;
  const refVersion = vb.body.referenceVersion as number;
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 0);
  assert.equal(typeof refVersion, 'number');

  // Same-face live embedding → server returns matched. Attach a bogus client
  // claim (matched:false, score:0) to prove the server IGNORES it.
  const okRes = await resp(base, '/api/v1/account/biometric/verification/complete', {
    verificationToken: token,
    liveEmbedding: sameFaceVector,
    matched: false,
    score: 0,
  }, `priestate_sid=${sid}`);
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.ok, true);
  assert.equal(okRes.body.verdict, 'matched');

  // Different-face live embedding → mismatch (server done).
  const vb2 = await resp(base, '/api/v1/account/biometric/verification/begin', { walletAddress: WALLET });
  assert.equal(vb2.status, 200);
  const mm = await resp(base, '/api/v1/account/biometric/verification/complete', {
    verificationToken: vb2.body.token as string,
    liveEmbedding: differentFaceVector,
    matched: true,
    score: 1,
  }, `priestate_sid=${sid}`);
  assert.equal(mm.status, 200);
  // A mismatch still resolves a verdict (ok:true, verdict:'mismatch').
  assert.equal(mm.body.ok, true);
  assert.equal(mm.body.verdict, 'mismatch');

  // Replay of a consumed token is rejected (fail-closed), even with the same face.
  const replay = await resp(base, '/api/v1/account/biometric/verification/complete', {
    verificationToken: token,
    liveEmbedding: sameFaceVector,
  }, `priestate_sid=${sid}`);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.ok, false);
  assert.notEqual(replay.body.verdict, 'matched');
});
