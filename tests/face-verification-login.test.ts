// PRIESTATE Level-3 Part 6 — Login face verification + liveness.
//
// Verifies the LOGIN FACE-VERIFICATION stage is an explicit, honest, FAIL-CLOSED
// identity-verification step SUBSEQUENT to the five-factor login:
//   * the pure `transitionLoginFace` machine — the ONLY path to
//     `identity_verified` is a real `verification_result` verdict of `matched`;
//     there is no event that sets "matched = true" directly,
//   * capability discovery is honest: no bundled provider advertises face
//     capability and none stores a reference, so `discoverFaceCapability`
//     reports `not_capable` and the stage fails closed to
//     `verification_unavailable`,
//   * provider unavailable / no reference / insufficient quality / no face /
//     multiple faces / mismatch / camera denied / camera unavailable / timeout /
//     cancel all block success,
//   * server: `capabilities()` exposes `faceVerificationConfigured:false`; the
//     `/login/face-verification` endpoint returns a fail-closed boolean snapshot
//     and NEVER accepts a self-affirmed "matched" assertion; no session can be
//     minted from a client claim,
//   * `AccountRecord` gained NO biometric/face-reference fields,
//   * privacy: no face image, embedding, biometric, or Aadhaar material is ever
//     serialized into login/account state or any test URL/log/localStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { ServerConfig } from '../server/config';
import { listenVerificationServer } from '../server/index';
import { applySchema } from '../server/account/db';
import { AccountService } from '../server/account/service';
import type { VerificationServerOverrides } from '../server/index';
import { configuredProviders } from './helpers/account-service-testing';
import { createGoogleTestKit, type GoogleTestKit } from './helpers/google-oauth-kit';
import type { SmsSendResult, WhatsAppSendResult } from './helpers/provider-types';
import { InMemoryAccountStore } from '../server/account/store';
import { hashPassword } from '../server/account/security';
import { type AccountRecord } from '../server/account/model';

import {
  IN_MEMORY_FACE_PROVIDER,
  discoverFaceCapability,
  type FaceVerificationCapability,
} from '../src/liveness/face-verification';
import {
  createLoginFaceSession,
  transitionLoginFace,
  type LoginFaceSession,
} from '../src/liveness/login-face-machine';

// ── Fixtures / helpers ───────────────────────────────────────────────

const WALLET = '0x' + 'c'.repeat(64);

function makeServerConfig(): ServerConfig {
  return {
    port: 0,
    allowedOrigins: ['http://localhost:3000'],
    email: { configured: false, host: '', port: 587, secure: false, user: '', pass: '', from: '' },
    otp: {
      hashSecret: 'face-otp-hash-secret',
      ttlMs: 10 * 60 * 1000,
      maxAttempts: 5,
      resendCooldownMs: 60_000,
      maxSendsPerEmailPerHour: 5,
      maxSendsPerIpPerHour: 20,
    },
    aadhaarKyc: { providerName: '', apiToken: '', baseUrl: '', mobileLinkPath: '', timeoutMs: 2000 },
    registry: { officerToken: '' },
    account: {
      encryptionSecret: 'face-account-enc-secret',
      biometricEncryptionSecret: '',
      dbPath: '',
      smsConfigured: true,
      whatsappConfigured: true,
      googleConfigured: true,
      sessionTtlMs: 60_000,
      sessionSecure: false,
    },
  };
}

function baseRecord(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    accountId: 'acc_1',
    walletAddress: WALLET,
    passwordHash: 'hash',
    passwordSalt: 'salt',
    piiCipherText: 'cipher',
    maskedMobile: '+91 98••••••10',
    maskedAadhaar: '•••• 4321',
    smsOtpVerified: true,
    whatsappOtpVerified: true,
    googleLinked: true,
    identityVerified: true,
    createdAt: 1_700_000_000_000,
    biometricReferenceCipherText: null,
    biometricReferenceVersion: null,
    biometricEnrolledAt: null,
    biometricConsentAt: null,
    biometricRevokedAt: null,
    ...overrides,
  };
}

/** A configured AccountService for unit-level server assertions. */
function makeService(store: InMemoryAccountStore): AccountService {
  return new AccountService({
    store,
    otp: { hashSecret: 'face-test-otp-hash-secret' },
    encryptionSecret: 'face-test-enc-secret-secret',
    ...configuredProviders(),
  });
}

// ── A. State machine ─────────────────────────────────────────────────

test('A1: fresh session starts idle with no biometric material', () => {
  const s = createLoginFaceSession();
  assert.equal(s.state, 'idle');
  assert.equal(s.hadCamera, false);
  assert.equal(s.passedAt, null);
  assert.equal(s.finalOutcome, null);
  // Serialized state holds only state/enumerated values.
  const keys = Object.keys(s).sort();
  assert.deepEqual(keys, ['finalOutcome', 'hadCamera', 'lastVerdict', 'passedAt', 'state']);
  assert.equal(s.state.includes('face') || s.state.includes('image'), false);
});

test('A2: start and camera_ready advance through the stage', () => {
  let s = createLoginFaceSession();
  s = transitionLoginFace(s, { type: 'start' }, 0);
  assert.equal(s.state, 'requesting_camera');
  s = transitionLoginFace(s, { type: 'camera_ready' }, 0);
  assert.equal(s.state, 'capability_check');
  assert.equal(s.hadCamera, true);
});

test('A3: capability unavailable fails closed to verification_unavailable', () => {
  let s = createLoginFaceSession();
  s = transitionLoginFace(s, { type: 'start' }, 0);
  s = transitionLoginFace(s, { type: 'camera_ready' }, 0);
  s = transitionLoginFace(s, { type: 'capabilities', capable: false, hasReference: false }, 0);
  assert.equal(s.state, 'verification_unavailable');
  assert.deepEqual(s.finalOutcome, { status: 'fail', reason: 'verification_unavailable' });
});

test('A4: capable but no reference → verification_unavailable', () => {
  let s = createLoginFaceSession();
  s = transitionLoginFace(s, { type: 'start' }, 0);
  s = transitionLoginFace(s, { type: 'camera_ready' }, 0);
  s = transitionLoginFace(s, { type: 'capabilities', capable: true, hasReference: false }, 0);
  assert.equal(s.state, 'verification_unavailable');
});

test('A5: capable + reference proceeds to verification_in_progress', () => {
  let s = createLoginFaceSession();
  s = transitionLoginFace(s, { type: 'start' }, 0);
  s = transitionLoginFace(s, { type: 'camera_ready' }, 0);
  s = transitionLoginFace(s, { type: 'capabilities', capable: true, hasReference: true }, 0);
  assert.equal(s.state, 'face_verification_in_progress');
});

test('A6: matched → identity_verified (only path to success)', () => {
  let s = createLoginFaceSession();
  s = transitionLoginFace(s, { type: 'start' }, 0);
  s = transitionLoginFace(s, { type: 'camera_ready' }, 0);
  s = transitionLoginFace(s, { type: 'capabilities', capable: true, hasReference: true }, 0);
  s = transitionLoginFace(s, { type: 'verification_result', verdict: 'matched' }, 1234);
  assert.equal(s.state, 'identity_verified');
  assert.equal(s.passedAt, 1234);
  assert.deepEqual(s.finalOutcome, { status: 'passed' });
});

test('A7: every failure verdict blocks success', () => {
  const failing: Array<{ verdict: string; expected: string }> = [
    { verdict: 'mismatch', expected: 'mismatch' },
    { verdict: 'insufficient_quality', expected: 'insufficient_quality' },
    { verdict: 'no_face', expected: 'no_face' },
    { verdict: 'multiple_faces', expected: 'multiple_faces' },
    { verdict: 'provider_unavailable', expected: 'verification_unavailable' },
    { verdict: 'error', expected: 'provider_error' },
  ];
  for (const { verdict, expected } of failing) {
    let s: LoginFaceSession = createLoginFaceSession();
    s = transitionLoginFace(s, { type: 'start' }, 0);
    s = transitionLoginFace(s, { type: 'camera_ready' }, 0);
    s = transitionLoginFace(s, { type: 'capabilities', capable: true, hasReference: true }, 0);
    s = transitionLoginFace(s, { type: 'verification_result', verdict: verdict as never }, 0);
    assert.equal(s.state, expected, `verdict ${verdict} should map to ${expected}`);
    assert.notEqual(s.state, 'identity_verified');
    assert.deepEqual(s.finalOutcome, { status: 'fail', reason: expected });
  }
});

test('A8: timeout and cancel fail closed', () => {
  // Timeout during an in-flight verification fails closed.
  let s = createLoginFaceSession();
  s = transitionLoginFace(s, { type: 'start' }, 0);
  s = transitionLoginFace(s, { type: 'camera_ready' }, 0);
  s = transitionLoginFace(s, { type: 'capabilities', capable: true, hasReference: true }, 0);
  s = transitionLoginFace(s, { type: 'timeout' }, 0);
  assert.equal(s.state, 'timeout');
  assert.notEqual(s.state, 'identity_verified');

  // Cancel at either non-terminal stage cancels cleanly.
  for (const st of ['capability_check', 'face_verification_in_progress'] as const) {
    let c = createLoginFaceSession();
    c = transitionLoginFace(c, { type: 'start' }, 0);
    c = transitionLoginFace(c, { type: 'camera_ready' }, 0);
    if (st === 'face_verification_in_progress') {
      c = transitionLoginFace(c, { type: 'capabilities', capable: true, hasReference: true }, 0);
    }
    c = transitionLoginFace(c, { type: 'cancel' }, 0);
    assert.equal(c.state, 'cancelled');
    assert.notEqual(c.state, 'identity_verified');
  }
});

test('A9: camera denied/unavailable fail closed (no success shortcut)', () => {
  let s = createLoginFaceSession();
  s = transitionLoginFace(s, { type: 'start' }, 0);
  s = transitionLoginFace(s, { type: 'camera_denied' }, 0);
  assert.equal(s.state, 'camera_denied');
  assert.notEqual(s.state, 'identity_verified');

  let u = createLoginFaceSession();
  u = transitionLoginFace(u, { type: 'start' }, 0);
  u = transitionLoginFace(u, { type: 'camera_unavailable' }, 0);
  assert.equal(u.state, 'camera_unavailable');
  assert.notEqual(u.state, 'identity_verified');
});

test('A10: terminal sessions are frozen — cannot be pushed to success', () => {
  let s = createLoginFaceSession();
  s = transitionLoginFace(s, { type: 'start' }, 0);
  s = transitionLoginFace(s, { type: 'camera_ready' }, 0);
  s = transitionLoginFace(s, { type: 'capabilities', capable: false, hasReference: false }, 0);
  assert.equal(s.state, 'verification_unavailable');
  // Even a fabricated matched verdict cannot resurrect a terminal session.
  const after = transitionLoginFace(s, { type: 'verification_result', verdict: 'matched' }, 0);
  assert.equal(after.state, 'verification_unavailable');
  assert.equal(after.state, s.state);
});

// ── B. Provider capability ───────────────────────────────────────────

test('B1: discoverFaceCapability fails closed when capability missing', () => {
  const none: ReadonlySet<FaceVerificationCapability> = new Set();
  assert.equal(discoverFaceCapability(none, false), 'not_capable');
  // Detection alone is not enough — you need embedding or liveness actions.
  const detectionOnly: ReadonlySet<FaceVerificationCapability> = new Set(['faceDetection']);
  assert.equal(discoverFaceCapability(detectionOnly, true), 'not_capable');
});

test('B2: discoverFaceCapability honors reference presence', () => {
  const capable: ReadonlySet<FaceVerificationCapability> = new Set(['faceDetection', 'faceEmbedding']);
  assert.equal(discoverFaceCapability(capable, false), 'capable_no_reference');
  assert.equal(discoverFaceCapability(capable, true), 'capable_with_reference');
});

test('B3: the bundled in-memory provider honestly reports unavailable', () => {
  assert.equal(IN_MEMORY_FACE_PROVIDER.capabilities.size, 0);
  assert.equal(IN_MEMORY_FACE_PROVIDER.hasReferenceIdentity, false);
  const result = IN_MEMORY_FACE_PROVIDER.verify();
  assert.equal(result.verdict, 'provider_unavailable');
  assert.equal('score' in result, false, 'no fabricated score');
});

// ── C. Security / no fabricated match ────────────────────────────────

test('C1: client cannot self-assert a success — no matched field drives the machine', () => {
  // There is no event named / shaped like a client boolean assertion.
  // A bogus extra field on verification_result does not change the outcome.
  const bogus = { type: 'verification_result', verdict: 'matched', clientSaysMatched: false } as never;
  let s = createLoginFaceSession();
  s = transitionLoginFace(s, { type: 'start' }, 0);
  s = transitionLoginFace(s, { type: 'camera_ready' }, 0);
  s = transitionLoginFace(s, { type: 'capabilities', capable: false, hasReference: false }, 0);
  const after = transitionLoginFace(s, bogus, 0);
  assert.equal(after.state, 'verification_unavailable', 'a client assertion cannot flip an unavailable stage to success');
});

test('C2: AccountRecord stores only an ENCRYPTED reference + metadata — never raw biometric material', () => {
  const allowed = new Set([
    'accountId', 'walletAddress', 'passwordHash', 'passwordSalt',
    'piiCipherText', 'maskedMobile', 'maskedAadhaar', 'smsOtpVerified',
    'whatsappOtpVerified', 'googleLinked', 'identityVerified', 'createdAt',
    'biometricReferenceCipherText', 'biometricReferenceVersion',
    'biometricEnrolledAt', 'biometricConsentAt', 'biometricRevokedAt',
  ]);
  const rec = baseRecord();
  for (const key of Object.keys(rec)) {
    assert.ok(allowed.has(key), `unexpected AccountRecord field: ${key}`);
  }
  // Part 8: the record may hold an ENCRYPTED reference blob + lifecycle
  // metadata, but NEVER a raw, in-the-clear biometric template/embedding.
  assert.equal(Object.prototype.hasOwnProperty.call(rec, 'faceEmbedding'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(rec, 'faceReference'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(rec, 'faceTemplate'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(rec, 'biometricReference'), false);
  // The encrypted blob must never be a bare 128-d embedding literal.
  const blob = rec.biometricReferenceCipherText;
  if (blob !== null) {
    assert.equal(Array.isArray(blob), false, 'reference is stored encrypted as a string, not an array');
  }
});

// ── D. Server: capabilities + fail-closed snapshot ───────────────────

test('D1: server capabilities advertise faceVerificationConfigured:false', () => {
  const store = new InMemoryAccountStore();
  const service = makeService(store);
  const caps = service.capabilities;
  assert.equal(caps.googleConfigured, true);
  assert.equal(caps.faceVerificationConfigured, false);
});

test('D2: faceVerificationState is fail-closed and null for unknown wallets', () => {
  const store = new InMemoryAccountStore();
  store.create(baseRecord());
  const service = makeService(store);
  // Unknown wallet → null (no account, no PII revealed).
  assert.equal(service.faceVerificationState('0x' + 'd'.repeat(64)), null);
  // Known wallet → required:true but provider/reference both false.
  const snap = service.faceVerificationState(WALLET);
  assert.ok(snap);
  assert.equal(snap.required, true);
  assert.equal(snap.providerAvailable, false);
  assert.equal(snap.hasReferenceIdentity, false);
});

// ── E. HTTP-level: capabilities + face-verification endpoint ─────────

function makeHttpOverrides(): { dir: string; kit: GoogleTestKit; overrides: VerificationServerOverrides } {
  const dir = mkdtempSync(path.join(tmpdir(), 'priestate-face-'));
  const db = new Database(path.join(dir, 'test.db'));
  applySchema(db);
  const kit = createGoogleTestKit();
  return {
    dir,
    kit,
    overrides: {
      db,
      accountSmsProvider: {
        name: 'capture',
        configured: true,
        send: async (): Promise<SmsSendResult> => ({ ok: true }),
      },
      accountWhatsAppProvider: {
        name: 'capture',
        configured: true,
        send: async (): Promise<WhatsAppSendResult> => ({ ok: true }),
      },
      accountGoogleProvider: kit.provider,
    },
  };
}

async function httpJson(base: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('E1: GET /api/v1/account/capabilities includes faceVerificationConfigured:false', async (t) => {
  const env = makeHttpOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  const { status, json } = await httpJson(base, '/api/v1/account/capabilities');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.faceVerificationConfigured, false);
  assert.equal(json.googleConfigured, true);
});

test('E2: POST /login/face-verification is honest and never accepts a match', async (t) => {
  const env = makeHttpOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); rmSync(env.dir, { recursive: true, force: true }); });

  // Register the wallet so the account exists.
  const reg = await httpJson(base, '/api/v1/account/register', {
    walletAddress: WALLET,
    fullName: 'Face Tester',
    aadhaarNumber: '444455556666',
    addressOnAadhaar: '1, Test Road, Pune',
    pincode: '411001',
    dateOfBirth: '1990-01-01',
    mobile: '9876502222',
    password: 'Str0ng#Pass',
    passwordConfirm: 'Str0ng#Pass',
  });
  assert.equal([200, 201].includes(reg.status), true, JSON.stringify(reg.json));

  // Unknown wallet → not found.
  const missing = await httpJson(base, '/api/v1/account/login/face-verification', {
    walletAddress: '0x' + 'e'.repeat(64),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.ok, false);

  // Known wallet → fail-closed boolean snapshot, hostile assertions ignored.
  const okRes = await httpJson(base, '/api/v1/account/login/face-verification', {
    walletAddress: WALLET,
    matched: true,
    faceMatched: true,
    score: 0.99,
  });
  assert.equal(okRes.status, 200);
  const fv = okRes.json.faceVerification as { required: boolean; providerAvailable: boolean; hasReferenceIdentity: boolean };
  assert.equal(fv.required, true);
  assert.equal(fv.providerAvailable, false);
  assert.equal(fv.hasReferenceIdentity, false);
  // The server ignores any client-matched assertions and returns no session/account.
  assert.equal(Object.prototype.hasOwnProperty.call(okRes.json, 'session'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(okRes.json, 'account'), false);
});

// ── F. Login gating: no session minted just because a client says matched ─

test('F1: password+factors gate the session — a face claim cannot mint one', async () => {
  const store = new InMemoryAccountStore();
  const creds = hashPassword('correct-horse');
  const rec = baseRecord({ passwordHash: creds.hash, passwordSalt: creds.salt, identityVerified: true });
  store.create(rec);
  const service = makeService(store);

  // Wrong password → authorized-failure, NO session — regardless of any face claim.
  const wrong = await service.login({ walletAddress: WALLET, password: 'nope' });
  assert.equal(wrong.ok, false);
  assert.equal(Object.prototype.hasOwnProperty.call(wrong, 'session'), false);

  // A hostile client appending a self-affirmed "faceMatched" claim still cannot
  // mint a session: login() is keyed only on wallet + password (+ factors).
  const hostile = { walletAddress: WALLET, password: 'nope', faceMatched: true } as never;
  const hijacked = await service.login(hostile);
  assert.equal(hijacked.ok, false);
  assert.equal(Object.prototype.hasOwnProperty.call(hijacked, 'session'), false);

  // Correct password + all factors + identity verified → session minted.
  const right = await service.login({ walletAddress: WALLET, password: 'correct-horse' });
  assert.equal(right.ok, true);
  assert.ok(Object.prototype.hasOwnProperty.call(right, 'session'));
});

// ── G. Privacy audit ─────────────────────────────────────────────────

test('G1: no biometric/sensitive material in serialized login or face states', () => {
  // The serialized face session carries only enumerated values.
  let s = createLoginFaceSession();
  const serialized = JSON.stringify(s);
  assert.equal(serialized.includes('embedding'), false);
  assert.equal(serialized.includes('aadhaar'), false);
  assert.equal(serialized.includes('image'), false);
  assert.equal(serialized.includes('base64'), false);

  // A matched session still carries no biometric payload.
  s = transitionLoginFace(s, { type: 'start' }, 0);
  s = transitionLoginFace(s, { type: 'camera_ready' }, 0);
  s = transitionLoginFace(s, { type: 'capabilities', capable: true, hasReference: true }, 0);
  s = transitionLoginFace(s, { type: 'verification_result', verdict: 'matched' }, 5);
  const matchedJson = JSON.stringify(s);
  assert.equal(matchedJson.includes('embedding'), false);
  assert.equal(matchedJson.includes('aadhaar'), false);
  assert.equal(matchedJson.includes('image'), false);
});