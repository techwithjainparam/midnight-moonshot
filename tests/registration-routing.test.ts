// PRIESTATE — Registration (Part 1) & forgot-password HTTP layer.
//
// Covers the NEW registration stepper routes and the forgot-password flow:
//   * capabilities + status endpoints report real provider state,
//   * `begin` creates a session cookie and resumes via Set-Cookie,
//   * every stepper step REQUIRES an active registration session (401),
//   * OCR / pincode / geocoding adapters fail closed and never fabricate,
//   * forgot-password `begin` is anti-enumeration (uniform masked result),
//   * unconfigured providers never succeed — `unavailable` fails closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { loadConfig, type ServerConfig } from '../server/config';
import { listenVerificationServer } from '../server/index';
import type { Mailer } from '../server/lib/mailer';
import {
  NominatimReverseGeocoder,
} from '../server/services/geocoding-provider';
import type { GeocodingProvider } from '../server/services/geocoding-provider';

const TEST_HASH_SECRET = 'unit-test-otp-hash-secret-0123456789abcdef';

class CaptureMailer implements Mailer {
  readonly sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  async send(input: { to: string; subject: string; text: string; html: string }): Promise<void> {
    this.sent.push(input);
  }
  lastCode(): string | null {
    const last = this.sent[this.sent.length - 1];
    if (!last) return null;
    const m = last.text.match(/\b(\d{6})\b/);
    return m ? m[1] : null;
  }
}

function makeServerConfig(): ServerConfig {
  return {
    port: 0,
    allowedOrigins: ['http://localhost:3000'],
    email: {
      configured: true,
      host: 'smtp.test.local',
      port: 587,
      secure: false,
      user: 'unit',
      pass: 'unit-pass',
      from: 'PRIESTATE <no-reply@test.local>',
    },
    otp: {
      hashSecret: TEST_HASH_SECRET,
      ttlMs: 10 * 60 * 1000,
      maxAttempts: 5,
      resendCooldownMs: 60_000,
      maxSendsPerEmailPerHour: 5,
      maxSendsPerIpPerHour: 20,
    },
    aadhaarKyc: {
      providerName: 'test-kyc',
      apiToken: '',
      baseUrl: '',
      mobileLinkPath: '/api/v1/mobile-to-aadhaar/',
      timeoutMs: 2_000,
    },
    registry: {
      officerToken: '',
    },
    account: {
      encryptionSecret: 'registration-routing-test-enc-secret-0123456789',
      biometricEncryptionSecret: 'registration-routing-test-bio-secret-0123456789',
      dbPath: ':memory:',
      smsConfigured: false,
      whatsappConfigured: false,
      googleConfigured: false,
      sessionTtlMs: 24 * 60 * 60 * 1000,
      sessionSecure: false,
    },
  };
}

async function getJson(
  url: string,
  init: RequestInit & { json?: Record<string, unknown> } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const { json, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: {
      ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body: (body ?? {}) as Record<string, unknown>, headers: res.headers };
}

function cookieFrom(resp: { headers: Headers }): string | null {
  const set = resp.headers.get('set-cookie');
  if (!set) return null;
  const m = /priestate_reg_sid=([^;]+)/.exec(set);
  return m ? m[1] : null;
}

interface FakeGeoHandlerArgs {
  lat: number;
  lng: number;
}
async function startFakeGeocoder(
  handler: (call: FakeGeoHandlerArgs) => { status?: number; json: unknown },
): Promise<{ url: string; calls: Array<{ lat: number; lng: number }>; close: () => Promise<void> }> {
  const calls: Array<{ lat: number; lng: number }> = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const lat = Number(u.searchParams.get('lat'));
    const lng = Number(u.searchParams.get('lon'));
    calls.push({ lat, lng });
    const out = handler({ lat, lng });
    res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.json));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ═══════════════════════════════════════════════════════════════════
// CAPABILITIES + STATUS
// ═══════════════════════════════════════════════════════════════════

test('[registration/status] no session cookie reports session:null', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const status = await getJson(`${base}/api/v1/registration/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.equal(status.body.session, null);
  } finally {
    await stack.close();
  }
});

test('[registration/capabilities] honestly reports provider state (all unconfigured)', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {
    aadhaarProvider: null,
    accountSmsProvider: { name: 'x', configured: false, send: async () => ({ ok: false, reason: 'unconfigured' as const }) },
    accountWhatsAppProvider: { name: 'x', configured: false, send: async () => ({ ok: false, reason: 'unconfigured' as const }) },
  });
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const caps = await getJson(`${base}/api/v1/registration/capabilities`);
    assert.equal(caps.status, 200);
    assert.deepEqual(caps.body.capabilities, {
      smsConfigured: false,
      whatsappConfigured: false,
      emailConfigured: true,
      aadhaarOcrConfigured: false,
      aadhaarMobileConfigured: false,
      pincodeConfigured: true,
      geocodingConfigured: true,
      passwordRecoveryConfigured: true,
    });
  } finally {
    await stack.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// BEGIN / RESUME
// ═══════════════════════════════════════════════════════════════════

const WALLET = '0x' + 'a'.repeat(64);

test('[registration/begin] creates a wallet-free session cookie and status resumes it', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const begin = await getJson(`${base}/api/v1/registration/begin`, {
      method: 'POST',
      json: {},
    });
    assert.equal(begin.status, 200);
    assert.equal(begin.body.ok, true);
    const sess = cookieFrom(begin);
    assert.ok(sess && sess.length >= 32);

    // Resuming without the cookie is not possible (cookie is the session key).
    const statusNoCookie = await getJson(`${base}/api/v1/registration/status`);
    assert.equal(statusNoCookie.body.session, null);

    const resumed = await getJson(`${base}/api/v1/registration/status`, {
      headers: { Cookie: `priestate_reg_sid=${sess}` },
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.ok, true);
    const session = resumed.body.session as Record<string, unknown>;
    assert.equal(session?.walletAddress, null);
  } finally {
    await stack.close();
  }
});

test('[registration/begin] ignores any wallet address sent in the payload', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const begun = await getJson(`${base}/api/v1/registration/begin`, {
      method: 'POST',
      json: { walletAddress: 'not-a-wallet' },
    });
    assert.equal(begun.status, 200);
    assert.equal(begun.body.ok, true);
    const resumed = await getJson(`${base}/api/v1/registration/status`, {
      headers: { Cookie: `priestate_reg_sid=${cookieFrom(begun)}` },
    });
    assert.equal(resumed.status, 200);
    const session = resumed.body.session as Record<string, unknown>;
    assert.equal(session?.walletAddress, null);
  } finally {
    await stack.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// STEP GATING: every stepper step requires an active session
// ═══════════════════════════════════════════════════════════════════

test('[registration/gating] every stepper step returns 401 without a session', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const steps: Array<{ path: string; body?: Record<string, unknown> }> = [
      { path: '/api/v1/registration/personal', body: { fullName: 'A' } },
      { path: '/api/v1/registration/email', body: { email: 'a@b.co' } },
      { path: '/api/v1/registration/email/verify', body: { code: '123456' } },
      { path: '/api/v1/registration/sms/verify', body: { code: '123456' } },
      { path: '/api/v1/registration/whatsapp/verify', body: { code: '123456' } },
      { path: '/api/v1/registration/aadhaar-mobile/complete', body: { sessionId: 'x', code: '123456' } },
      { path: '/api/v1/registration/password', body: { password: 'X', confirm: 'X' } },
      { path: '/api/v1/registration/finalize' },
    ];
    for (const step of steps) {
      const resp = await getJson(`${base}${step.path}`, {
        method: 'POST',
        json: step.body ?? {},
        headers: {},
      });
      assert.equal(resp.status, 401, `${step.path} should require a session`);
      assert.equal(resp.body.reason, 'no-session');
    }
  } finally {
    await stack.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// PERSONAL — validation, NEVER fabricated
// ═══════════════════════════════════════════════════════════════════

async function beginSession(base: string): Promise<string> {
  const begin = await getJson(`${base}/api/v1/registration/begin`, {
    method: 'POST',
    json: {},
  });
  const sess = cookieFrom(begin);
  assert.ok(sess);
  return sess;
}

test('[registration/personal] invalid Aadhaar number is rejected', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    const resp = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: {
        fullName: 'Asha Mehta',
        aadhaarNumber: 'NOT-A-NUMBER',
        dateOfBirth: '1990-01-01',
        mobile: '9876543210',
      },
    });
    assert.equal(resp.status, 400);
    assert.equal(resp.body.reason, 'invalid-input');
    const issues = resp.body.issues as string[];
    assert.ok(issues.some((i) => /aadhaar/i.test(i)));
  } finally {
    await stack.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// AADHAAR DOCUMENT — unconfigured OCR fails closed
// ═══════════════════════════════════════════════════════════════════

test('[registration/aadhaar-document] unconfigured OCR reports unavailable (503), never success', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);

    // Complete the personal step first (without a pincode, so no echo of the
    // India Post upstream) so the document step is the NEXT gate to check.
    const personal = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: {
        fullName: 'Asha Mehta',
        aadhaarNumber: '456789012345',
        dateOfBirth: '1990-01-01',
        mobile: '9876543210',
      },
    });
    assert.equal(personal.status, 200, 'personal should complete first');

    const boundary = '----priestate-test-boundary';
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const parts = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="aadhaar.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const resp = await fetch(`${base}/api/v1/registration/aadhaar-document`, {
      method: 'POST',
      headers: {
        Cookie: `priestate_reg_sid=${sess}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: parts,
    });
    const json = (await resp.json()) as Record<string, unknown>;
    assert.equal(resp.status, 503);
    assert.equal(json.reason, 'unavailable');
  } finally {
    await stack.close();
  }
});

test('[registration/aadhaar-document] missing session cookie is rejected', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const boundary = '----priestate-test-boundary2';
    const parts = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.from('0123456789'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const resp = await fetch(`${base}/api/v1/registration/aadhaar-document`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: parts,
    });
    const json = (await resp.json()) as Record<string, unknown>;
    assert.equal(resp.status, 401);
    assert.equal(json.reason, 'no-session');
  } finally {
    await stack.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// FORGOT-PASSWORD — anti-enumeration + fail-closed
// ═══════════════════════════════════════════════════════════════════

test('[forgot-password/begin] responds uniformly whether or not the email exists (anti-enumeration)', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;

    const known = await getJson(`${base}/api/v1/account/forgot-password/begin`, {
      method: 'POST',
      // No matching account: indistinguishable from a successful begin below.
      json: { walletAddress: WALLET, email: 'neha.patil@example.com' },
    });
    assert.equal(known.status, 200);
    assert.equal(known.body.ok, true);
    assert.equal(known.body.status, 'started');
    assert.equal(typeof known.body.maskedEmail, 'string');

    const unknown = await getJson(`${base}/api/v1/account/forgot-password/begin`, {
      method: 'POST',
      json: { walletAddress: '0x' + 'b'.repeat(64), email: 'Nobody@Example.com' },
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.status, 'started');
    // Same shape as a real (account-exists) begin.
    assert.deepEqual(
      { status: unknown.body.status, masked: typeof unknown.body.maskedEmail },
      { status: known.body.status, masked: typeof known.body.maskedEmail },
    );
  } finally {
    await stack.close();
  }
});

test('[forgot-password/begin] invalid wallet is rejected', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const resp = await getJson(`${base}/api/v1/account/forgot-password/begin`, {
      method: 'POST',
      json: { walletAddress: 'nope', email: 'a@b.co' },
    });
    assert.equal(resp.status, 400);
    assert.equal(resp.body.reason, 'invalid-input');
  } finally {
    await stack.close();
  }
});

test('[forgot-password/begin] unknown email is valid but never sends an OTP', async () => {
  const mailer = new CaptureMailer();
  const stack = await listenVerificationServer(makeServerConfig(), { mailer });
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const before = mailer.sent.length;
    const resp = await getJson(`${base}/api/v1/account/forgot-password/begin`, {
      method: 'POST',
      json: { walletAddress: '0x' + 'c'.repeat(64), email: 'NotRegistered@Example.in' },
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.body.status, 'started');
    // No OTP was dispatched for a non-existent account.
    assert.equal(mailer.sent.length, before);
  } finally {
    await stack.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// GEOCODING PROVIDER — real adapter fail-closed behaviour
// ═══════════════════════════════════════════════════════════════════

test('[geocoding] Nominatim reverse geocoder keeps us honest about country checks', async () => {
  const geo = await startFakeGeocoder((_call) => ({
    json: {
      display_name: 'Pune, Maharashtra, India',
      address: { country: 'India' },
      state: 'Maharashtra',
    },
  }));
  try {
    const provider: GeocodingProvider = new NominatimReverseGeocoder({ baseUrl: geo.url, timeoutMs: 2000 });
    assert.equal(provider.configured, true);
    const out = await provider.reverse(18.0, 73.0);
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.country, 'India');
    assert.equal(geo.calls.length, 1);
    assert.equal(geo.calls[0].lat, 18.0);
    assert.equal(geo.calls[0].lng, 73.0);
  } finally {
    await geo.close();
  }
});

test('[geocoding] Nominatim reverse geocoder fails closed on network error', async () => {
  const provider: GeocodingProvider = new NominatimReverseGeocoder({
    baseUrl: 'http://127.0.0.1:1', // nothing listening
    timeoutMs: 500,
  });
  const out = await provider.reverse(18.0, 73.0);
  assert.equal(out.ok, false);
});

// ═══════════════════════════════════════════════════════════════════
// CONFIG-level OTP secret guard (server refuses to boot without it)
// ═══════════════════════════════════════════════════════════════════

test('[config] verification server refuses to start without a strong OTP_HASH_SECRET', () => {
  const cfg: ServerConfig = {
    ...makeServerConfig(),
    otp: { ...makeServerConfig().otp, hashSecret: 'short' },
  };
  assert.throws(() => listenVerificationServer(cfg), /OTP_HASH_SECRET/);
});

test('[config] loadConfig reflects a configured registration section', () => {
  const env = {
    ...process.env,
    AADHAAR_OCR_PROVIDER: 'surepass',
    AADHAAR_OCR_API_TOKEN: 'test-token',
    AADHAAR_OCR_BASE_URL: 'https://api.surepass.io',
    PINCODE_BASE_URL: 'https://api.postalpincode.in',
    GEOCODING_BASE_URL: 'https://nominatim.openstreetmap.org',
    DISPOSABLE_EMAIL_BLOCK_LIST: 'example.com',
    REGISTRATION_SESSION_TTL_MINUTES: '90',
  };
  const cfg = loadConfig(env);
  assert.equal(cfg.registration?.aadhaarOcr?.providerName, 'surepass');
  assert.equal(cfg.registration?.aadhaarOcr?.apiToken, 'test-token');
  assert.equal(cfg.registration?.pincode?.baseUrl, 'https://api.postalpincode.in');
  assert.equal(cfg.registration?.geocoding?.baseUrl, 'https://nominatim.openstreetmap.org');
  assert.equal(cfg.registration?.disposableEmailExtraDomains, 'example.com');
  assert.equal(cfg.registration?.sessionTtlMs, 90 * 60 * 1000);
});