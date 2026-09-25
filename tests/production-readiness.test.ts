// PRIESTATE — Production-readiness regression tests.
//
// Covers the deployment changes that let the verification API run behind a
// real edge (Railway) with the app frontend served from Vercel:
//   * CORS echoes credentials ONLY to the allow-listed origin (never `*`),
//   * the session cookie honors a config-driven SameSite (None forces Secure),
//   * rate-limiter client IP can come from the RIGHTMOST X-Forwarded-For hop
//     behind a trusted edge — preserving per-caller buckets — while the
//     header is ignored by default,
//   * the frontend clients send credentials:'include' on every call so the
//     cross-site priestate_sid cookie is delivered,
//   * production port fallback (VERIFY_SERVER_PORT → PORT → 8787).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import type { ServerConfig } from '../server/config';
import { loadConfig } from '../server/config';
import { listenVerificationServer } from '../server/index';
import { applySchema } from '../server/account/db';
import { SessionService } from '../server/account/session';
import { resolveClientIp } from '../server/lib/client-ip';
import { registerAccount, fetchAccountCapabilities } from '../src/auth/account-api';
import { BackendContactVerificationProvider } from '../src/profile/providers/backend-providers';
import { createApplicationMetadata } from '../src/registry/registry-client';
import { createGoogleTestKit } from './helpers/google-oauth-kit';
import type { SmsSendResult, WhatsAppSendResult } from './helpers/provider-types';

const ENC = 'prod-readiness-enc-secret';
const HASH = 'prod-readiness-otp-hash-secret-0123456789';

const ACAO = 'Access-Control-Allow-Origin';
const ACAC = 'Access-Control-Allow-Credentials';

// ── Helpers ─────────────────────────────────────────────────────────

function makeAccount(): NonNullable<ServerConfig['account']> {
  return {
    encryptionSecret: ENC,
    biometricEncryptionSecret: ENC,
    dbPath: '',
    smsConfigured: true,
    whatsappConfigured: true,
    googleConfigured: true,
    sessionTtlMs: 60_000,
    sessionSecure: false,
  };
}

interface MakeConfigOverrides {
  readonly allowedOrigins?: readonly string[];
  readonly trustProxy?: boolean;
  readonly account?: Partial<NonNullable<ServerConfig['account']>>;
}

function makeServerConfig(over: MakeConfigOverrides = {}): ServerConfig {
  return {
    port: 0,
    allowedOrigins: over.allowedOrigins ?? ['https://app.example.test'],
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
    account: over.account ? { ...makeAccount(), ...over.account } : makeAccount(),
    ...(over.trustProxy !== undefined ? { trustProxy: over.trustProxy } : {}),
  };
}

function makeOverrides() {
  const db = new Database(':memory:');
  applySchema(db);
  // Registration is gated on ALL factors being configured — mirror the
  // capture-provider seam used by the account HTTP tests so `register`
  // succeeds (it never performs a real delivery here).
  const capture: { sms: { to: string; code: string }[]; whatsapp: { to: string; code: string }[] } = {
    sms: [],
    whatsapp: [],
  };
  const kit = createGoogleTestKit();
  return {
    db,
    kit,
    capture,
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

function registerPayload(wallet = '0x' + 'c'.repeat(64)) {
  return {
    walletAddress: wallet,
    fullName: 'Prod Tester',
    aadhaarNumber: '222233334444',
    addressOnAadhaar: '7, MG Road, Delhi',
    pincode: '110001',
    dateOfBirth: '1990-07-15',
    mobile: '9876501111',
    password: 'Str0ng#Pass',
    passwordConfirm: 'Str0ng#Pass',
  };
}

async function registerWithXff(base: string, xff: string, walletIndex: number): Promise<number> {
  const res = await fetch(`${base}/api/v1/account/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': xff,
    },
    body: JSON.stringify(registerPayload('0x' + walletIndex.toString(16).padStart(64, '0'))),
  });
  return res.status;
}

function installFetchStub() {
  const original = globalThis.fetch;
  let capturedInit: RequestInit | undefined;
  // A generic success body that satisfies every client funnel (sendEmailOtp
  // additionally checks the expiry timestamps, so include them).
  const body = { ok: true, expiresAt: Date.now() + 60_000, resendAvailableAt: 0 };
  globalThis.fetch = ((_input: unknown, init?: RequestInit): Promise<Response> => {
    capturedInit = init;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return {
    init: () => capturedInit,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ── Config: production defaults, port fallback, SameSite/Secure ──────

test('loadConfig: production port fallback is VERIFY_SERVER_PORT → PORT → 8787', () => {
  assert.equal(loadConfig({}).port, 8787);
  assert.equal(loadConfig({ VERIFY_SERVER_PORT: '9100' }).port, 9100);
  assert.equal(loadConfig({ PORT: '8080' }).port, 8080);
  // Explicit override always wins over a platform-injected PORT.
  assert.equal(loadConfig({ VERIFY_SERVER_PORT: '9100', PORT: '8080' }).port, 9100);
  // A non-numeric value must not crash — fall back to the default.
  assert.equal(loadConfig({ VERIFY_SERVER_PORT: 'not-a-port' }).port, 8787);
});

test('loadConfig: trust proxy and session SameSite defaults (secure, non-breaking)', () => {
  const plain = loadConfig({});
  assert.equal(plain.trustProxy, false);
  assert.equal(plain.account?.sessionSameSite, 'Lax');
  assert.equal(plain.account?.sessionSecure, true);

  assert.equal(loadConfig({ VERIFY_SERVER_TRUST_PROXY: 'true' }).trustProxy, true);
  assert.equal(loadConfig({ VERIFY_SERVER_TRUST_PROXY: 'false' }).trustProxy, false);
});

test('loadConfig: SameSite=None forces Secure; unknown values fall back to Lax', () => {
  // None without Secure is invalid in browsers — the config must force Secure.
  const none = loadConfig({ ACCOUNT_SESSION_SAMESITE: 'None', ACCOUNT_SESSION_SECURE: 'false' });
  assert.equal(none.account?.sessionSameSite, 'None');
  assert.equal(none.account?.sessionSecure, true);

  assert.equal(loadConfig({ ACCOUNT_SESSION_SAMESITE: 'Lax' }).account?.sessionSameSite, 'Lax');
  assert.equal(loadConfig({ ACCOUNT_SESSION_SAMESITE: 'Strict' }).account?.sessionSameSite, 'Strict');
  assert.equal(loadConfig({ ACCOUNT_SESSION_SAMESITE: 'Bogus' }).account?.sessionSameSite, 'Lax');

  // Only SameSite=None forces Secure; other values keep the configured flag.
  const laxInsecure = loadConfig({ ACCOUNT_SESSION_SAMESITE: 'Lax', ACCOUNT_SESSION_SECURE: 'false' });
  assert.equal(laxInsecure.account?.sessionSecure, false);
});

// ── Client IP behind a trusted edge ─────────────────────────────────

test('resolveClientIp: X-Forwarded-For is ignored unless trustProxy is enabled', () => {
  const src = { socketAddress: '127.0.0.1', forwardedFor: '203.0.113.9, 10.0.0.1' };
  assert.equal(resolveClientIp(src, false), '127.0.0.1');
});

test('resolveClientIp: the RIGHTMOST XFF hop wins behind a trusted edge', () => {
  const src = {
    socketAddress: '10.0.0.2',
    // Leading hops (attacker-supplied) never win — only the edge-appended one.
    forwardedFor: '6.6.6.6, 127.0.0.1, 203.0.113.7',
  };
  assert.equal(resolveClientIp(src, true), '203.0.113.7');
});

test('resolveClientIp: falls back to the socket address when XFF is absent or malformed', () => {
  assert.equal(resolveClientIp({ socketAddress: '9.9.9.9' }, true), '9.9.9.9');
  assert.equal(resolveClientIp({ socketAddress: '9.9.9.9', forwardedFor: '' }, true), '9.9.9.9');
  assert.equal(resolveClientIp({ socketAddress: '9.9.9.9', forwardedFor: '  ,  ' }, true), '9.9.9.9');
  assert.equal(resolveClientIp({ socketAddress: '9.9.9.9', forwardedFor: undefined }, true), '9.9.9.9');
});

test('resolveClientIp: array XFF headers are joined and each hop trimmed', () => {
  const src = { socketAddress: '10.0.0.2', forwardedFor: ['6.6.6.6', '203.0.113.4 '] };
  assert.equal(resolveClientIp(src, true), '203.0.113.4');
});

// ── HTTP behavior: rate-limit buckets follow the trusted-edge IP ─────

test('Rate limit buckets follow the rightmost XFF when trustProxy is on', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig({ trustProxy: true }), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); });

  const SAME_CALLER = '6.6.6.6, 203.0.113.7'; // spoofed leader + real caller
  assert.equal(await registerWithXff(base, SAME_CALLER, 1), 201);
  assert.equal(await registerWithXff(base, SAME_CALLER, 2), 201);
  assert.equal(await registerWithXff(base, SAME_CALLER, 3), 201);
  // 4th from the SAME caller IP (the edge-appended rightmost hop) → limited.
  assert.equal(await registerWithXff(base, SAME_CALLER, 4), 429);

  // A DIFFERENT caller (different rightmost hop) is a fresh bucket → allowed.
  // The spoofed leading 6.6.6.6 is ignored, so it did not consume the caller's
  // bucket nor ours.
  assert.equal(await registerWithXff(base, '6.6.6.6, 203.0.113.99', 5), 201);
});

test('Without trustProxy, X-Forwarded-For is ignored (sockets share one bucket)', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); });

  const statuses: number[] = [];
  for (let i = 1; i <= 4; i++) {
    statuses.push(await registerWithXff(base, `10.0.0.${i}, 203.0.113.${100 + i}`, i));
  }
  // All four share the socket bucket even though the XFF headers differ.
  assert.deepEqual(statuses, [201, 201, 201, 429]);
});

// ── CORS: credentialed responses only for the allow-list ────────────

test('CORS: allowed origin gets credentialed headers; disallowed origin never does', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); });

  const allowed = await fetch(`${base}/api/health`, { headers: { Origin: 'https://app.example.test' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get(ACAO), 'https://app.example.test');
  assert.equal(allowed.headers.get(ACAC), 'true');
  // Never a wildcard while carrying credentials.
  assert.notEqual(allowed.headers.get(ACAO), '*');

  const disallowed = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(disallowed.status, 200);
  assert.equal(disallowed.headers.get(ACAO), null);
  assert.equal(disallowed.headers.get(ACAC), null);
});

test('CORS preflight: 204 with credentials for the allow-listed origin only', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(makeServerConfig(), env.overrides);
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); });

  async function preflight(origin: string) {
    return fetch(`${base}/api/v1/account/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
  }

  const ok = await preflight('https://app.example.test');
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get(ACAO), 'https://app.example.test');
  assert.equal(ok.headers.get(ACAC), 'true');
  assert.match(ok.headers.get('Access-Control-Allow-Methods') ?? '', /POST/);
  assert.match(ok.headers.get('Access-Control-Allow-Headers') ?? '', /content-type/i);

  const denied = await preflight('https://evil.example');
  assert.equal(denied.status, 204);
  assert.equal(denied.headers.get(ACAO), null);
  assert.equal(denied.headers.get(ACAC), null);
});

// ── Session cookie SameSite ─────────────────────────────────────────

test('SessionService: SameSite is config-driven on issued and cleared cookies', () => {
  const db = new Database(':memory:');
  applySchema(db);
  // sessions.account_id is a foreign key — seed one account row.
  db.prepare(
    `INSERT INTO accounts (account_id, wallet_address, password_hash, password_salt, pii_ciphertext, masked_mobile, masked_aadhaar, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('acc-1', 'w-1', 'h', 's', 'c', '••••', '••••', Date.now());

  const lax = new SessionService(db, { secure: false });
  const laxCookie = lax.create('acc-1', 'w-1').cookieHeader;
  assert.match(laxCookie, /SameSite=Lax/);
  assert.doesNotMatch(laxCookie, /Secure/);
  assert.match(laxCookie, /HttpOnly/);
  assert.match(laxCookie, /Path=\//);

  const none = new SessionService(db, { secure: false, sameSite: 'None' });
  const noneCookie = none.create('acc-1', 'w-1').cookieHeader;
  assert.match(noneCookie, /SameSite=None/);
  // SameSite=None without Secure is rejected by browsers → always forced on.
  assert.match(noneCookie, /Secure/);

  const clear = SessionService.clearCookieHeader(true, 'None');
  assert.match(clear, /SameSite=None/);
  assert.match(clear, /Secure/);
  assert.match(clear, /Max-Age=0/);
});

test('HTTP: registration Set-Cookie honors SameSite=None with Secure forced on', async (t) => {
  const env = makeOverrides();
  const stack = await listenVerificationServer(
    makeServerConfig({ account: { sessionSameSite: 'None', sessionSecure: false } }),
    env.overrides,
  );
  const base = `http://127.0.0.1:${stack.port}`;
  t.after(async () => { await stack.close(); });

  const reg = await fetch(`${base}/api/v1/account/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(registerPayload()),
  });
  assert.equal(reg.status, 201);
  const setCookie = reg.headers.get('Set-Cookie') ?? '';
  assert.match(setCookie, /priestate_sid=/);
  assert.match(setCookie, /SameSite=None/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Path=\//);
});

// ── Frontend: credentialed cross-origin fetches ─────────────────────

test('Frontend clients send credentials:"include" on every backend call', async () => {
  const stub = installFetchStub();
  try {
    const account = await registerAccount(registerPayload());
    assert.equal(account.ok, true);
    assert.equal(stub.init()?.credentials, 'include');

    await fetchAccountCapabilities();
    assert.equal(stub.init()?.credentials, 'include');

    const provider = new BackendContactVerificationProvider('http://api.example.test');
    const otp = await provider.sendEmailOtp('tester@example.com');
    assert.equal(otp.ok, true);
    assert.equal(stub.init()?.credentials, 'include');

    await createApplicationMetadata({ referenceId: '7' }, 'http://api.example.test');
    assert.equal(stub.init()?.credentials, 'include');
  } finally {
    stub.restore();
  }
});