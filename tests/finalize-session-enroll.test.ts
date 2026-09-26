// PRIESTATE — STEP 7 focused tests: finalize mints account session,
// enrollment works with that session, and verification requires a session.
//
// Verifies over a real HTTP server:
//   * finalize succeeds with a pre-seeded complete registration session
//   * finalize mints an account session cookie (priestate_sid)
//   * the minted session is immediately usable for biometric enrollment
//   * verification/complete without a session returns 401 (requireAuth)
//   * verification/complete with the minted session and same-face vector → matched
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { ServerConfig } from '../server/config';
import { listenVerificationServer } from '../server/index';
import { applySchema } from '../server/account/db';
import {
  InMemoryRegistrationSessionStore,
  type RegistrationSession,
} from '../server/registration/session-store';
import { enrollmentVectors, sameFaceVector } from './biometric-vectors';
import { createGoogleTestKit } from './helpers/google-oauth-kit';
import type { SmsSendResult, WhatsAppSendResult } from './helpers/provider-types';

const ENC = 'srv-level3-enc-secret';
const HASH = 'srv-test-otp-hash-secret-0123456789';
const WALLET = '0x' + 'a'.repeat(64);
const REG_TOKEN = 'test-reg-complete-token';

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

function makeEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), 'priestate-finalize-'));
  const db = new Database(path.join(dir, 'test.db'));
  applySchema(db);
  const capture = { sms: [] as { to: string; code: string }[], whatsapp: [] as { to: string; code: string }[] };
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
        send: async (to: string, code: string): Promise<SmsSendResult> => {
          capture.sms.push({ to, code });
          return { ok: true };
        },
      },
      accountWhatsAppProvider: {
        name: 'capture',
        configured: true,
        send: async (to: string, code: string): Promise<WhatsAppSendResult> => {
          capture.whatsapp.push({ to, code });
          return { ok: true };
        },
      },
      accountGoogleProvider: kit.provider,
    },
  };
}

function completeSession(): RegistrationSession {
  const now = Date.now();
  return {
    sessionToken: REG_TOKEN,
    walletAddress: null,
    personalPiiCipherText: 'fake-pii-ciphertext-ok',
    personalCompletedAt: Date.now(),
    maskedMobile: '987XXXX110',
    maskedAadhaar: 'XXXX XXXX 3444',
    aadhaarOcrCipherText: null,
    aadhaarDocumentStatus: 'verified',
    aadhaarDocumentExtractedAt: now,
    emailVerified: true,
    emailVerifiedAt: now,
    smsOtpVerified: true,
    smsOtpVerifiedAt: now,
    whatsappOtpVerified: true,
    whatsappOtpVerifiedAt: now,
    aadhaarMobileLinked: true,
    aadhaarMobileLinkedAt: now,
    passwordHash: 'test-hash',
    passwordSalt: 'test-salt',
    photoStatus: 'verified',
    photoContentHash: 'fake-photo-hash',
    livenessPassed: true,
    livenessPassedAt: now,
    locationAccepted: true,
    locationAcceptedAt: now,
    finalizedAt: null,
    createdAt: now,
    expiresAt: now + 60 * 60 * 1000,
  };
}

async function post(base: string, pathName: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + pathName, { method: 'POST', headers, body: JSON.stringify(body) });
  let b: unknown = null;
  try {
    b = await res.json();
  } catch {
    b = {};
  }
  return {
    status: res.status,
    body: (b ?? {}) as Record<string, unknown>,
    setCookie: res.headers.get('Set-Cookie'),
  };
}

function accountSid(setCookie: string | null | undefined): string | null {
  if (!setCookie) return null;
  const m = /priestate_sid=([0-9a-f]+)/.exec(setCookie);
  return m ? m[1] : null;
}

// After finalize the session carries NO wallet; bind the real Midnight wallet
// with /api/v1/account/wallet/associate, which RE-MINTS priestate_sid so the
// session carries the wallet required by biometric enrollment.
async function associateWallet(base: string, cookie: string, walletAddress: string): Promise<string> {
  const res = await post(base, '/api/v1/account/wallet/associate', { walletAddress }, cookie);
  assert.equal(res.status, 200, `wallet associate failed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true, `wallet associate not ok: ${JSON.stringify(res.body)}`);
  const sid = accountSid(res.setCookie);
  assert.ok(sid, 'associate must re-mint priestate_sid');
  return `priestate_sid=${sid}`;
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

test('finalize mints priestate_sid account session cookie', async (t) => {
  const env = makeEnv();
  const regStore = new InMemoryRegistrationSessionStore();
  regStore.create(completeSession());
  const stack = await listenVerificationServer(makeServerConfig(), {
    ...env.overrides,
    registrationStore: regStore,
  });
  t.after(async () => {
    await stack.close();
    rmSync(env.dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${stack.port}`;

  const res = await post(base, '/api/v1/registration/finalize', {}, `priestate_reg_sid=${REG_TOKEN}`);
  assert.equal(res.status, 200, `finalize failed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.accountId, 'string');
  assert.ok((res.body.accountId as string).length > 0, 'accountId must be non-empty');
  assert.equal(res.body.walletAddress, null, 'finalize creates a wallet-free account');
  const sid = accountSid(res.setCookie);
  assert.ok(sid, 'Set-Cookie must contain priestate_sid');
  assert.ok(res.setCookie?.includes('priestate_reg_sid=;'), 'registration cookie must be cleared');
});

test('minted session is immediately usable for biometric enrollment', async (t) => {
  const env = makeEnv();
  const regStore = new InMemoryRegistrationSessionStore();
  regStore.create(completeSession());
  const stack = await listenVerificationServer(makeServerConfig(), {
    ...env.overrides,
    registrationStore: regStore,
  });
  t.after(async () => {
    await stack.close();
    rmSync(env.dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${stack.port}`;

  // Step 1: finalize to mint the session (wallet-free)
  const fin = await post(base, '/api/v1/registration/finalize', {}, `priestate_reg_sid=${REG_TOKEN}`);
  assert.equal(fin.status, 200, `finalize failed: ${JSON.stringify(fin.body)}`);
  const sid = accountSid(fin.setCookie);
  assert.ok(sid, 'session must be minted');

  // Step 2: bind the real wallet (re-mints the session cookie so it carries it)
  const cookie = await associateWallet(base, `priestate_sid=${sid}`, WALLET);

  // Step 3: begin enrollment (no identity-evidence call needed — finalize set identityEvidenceAcceptedAt)
  const begin = await post(base, '/api/v1/account/biometric/enrollment/begin', {}, cookie);
  assert.equal(begin.status, 200, `enrollment begin failed: ${JSON.stringify(begin.body)}`);
  assert.equal(typeof begin.body.token, 'string');
  assert.ok((begin.body.token as string).length > 0);

  // Step 4: complete enrollment with real embedding vectors
  const done = await post(base, '/api/v1/account/biometric/enrollment/complete', {
    token: begin.body.token,
    consent: true,
    embeddings: enrollmentVectors(4),
  }, cookie);
  assert.equal(done.status, 200, `enrollment complete failed: ${JSON.stringify(done.body)}`);
  assert.equal(done.body.identityVerified, true, 'enrollment must set identityVerified');
  assert.equal(done.body.enrollmentState, 'enrolled');
});

test('verification/complete without session returns 401', async (t) => {
  const env = makeEnv();
  const regStore = new InMemoryRegistrationSessionStore();
  regStore.create(completeSession());
  const stack = await listenVerificationServer(makeServerConfig(), {
    ...env.overrides,
    registrationStore: regStore,
  });
  t.after(async () => {
    await stack.close();
    rmSync(env.dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${stack.port}`;

  // Enroll first (finalize → associate wallet → enroll)
  const fin = await post(base, '/api/v1/registration/finalize', {}, `priestate_reg_sid=${REG_TOKEN}`);
  assert.equal(fin.status, 200);
  const sid = accountSid(fin.setCookie)!;
  const cookie = await associateWallet(base, `priestate_sid=${sid}`, WALLET);

  const begin = await post(base, '/api/v1/account/biometric/enrollment/begin', {}, cookie);
  assert.equal(begin.status, 200);
  await post(base, '/api/v1/account/biometric/enrollment/complete', {
    token: begin.body.token,
    consent: true,
    embeddings: enrollmentVectors(4),
  }, cookie);

  // verification/complete without session → 401
  const noAuth = await post(base, '/api/v1/account/biometric/verification/complete', {
    verificationToken: 'fake-token',
    liveEmbedding: sameFaceVector,
  });
  assert.equal(noAuth.status, 401, 'verification/complete must require a session cookie');
});

test('full finalize→enroll→verify flow with same-face vector matches', async (t) => {
  const env = makeEnv();
  const regStore = new InMemoryRegistrationSessionStore();
  regStore.create(completeSession());
  const stack = await listenVerificationServer(makeServerConfig(), {
    ...env.overrides,
    registrationStore: regStore,
  });
  t.after(async () => {
    await stack.close();
    rmSync(env.dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${stack.port}`;

  // 1. Finalize → mint wallet-free session
  const fin = await post(base, '/api/v1/registration/finalize', {}, `priestate_reg_sid=${REG_TOKEN}`);
  assert.equal(fin.status, 200, `finalize failed: ${JSON.stringify(fin.body)}`);
  const sid = accountSid(fin.setCookie)!;
  assert.ok(sid, 'session must be minted');

  // 2. Associate the real wallet → re-mints the session so it carries it
  const cookie = await associateWallet(base, `priestate_sid=${sid}`, WALLET);

  // 3. Enroll (begin + complete)
  const begin = await post(base, '/api/v1/account/biometric/enrollment/begin', {}, cookie);
  assert.equal(begin.status, 200, `enrollment begin failed: ${JSON.stringify(begin.body)}`);
  const done = await post(base, '/api/v1/account/biometric/enrollment/complete', {
    token: begin.body.token,
    consent: true,
    embeddings: enrollmentVectors(4),
  }, cookie);
  assert.equal(done.status, 200, `enrollment complete failed: ${JSON.stringify(done.body)}`);
  assert.equal(done.body.identityVerified, true);

  // 3. Verify (begin + complete with same-face vector)
  const vb = await post(base, '/api/v1/account/biometric/verification/begin', { walletAddress: WALLET });
  assert.equal(vb.status, 200, `verification begin failed: ${JSON.stringify(vb.body)}`);
  assert.equal(typeof vb.body.token, 'string');
  assert.ok((vb.body.token as string).length > 0);

  const vr = await post(base, '/api/v1/account/biometric/verification/complete', {
    verificationToken: vb.body.token,
    liveEmbedding: sameFaceVector,
  }, cookie);
  assert.equal(vr.status, 200, `verification complete failed: ${JSON.stringify(vr.body)}`);
  assert.equal(vr.body.ok, true);
  assert.equal(vr.body.verdict, 'matched');
});
