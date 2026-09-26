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
import type { SmsProvider } from '../server/account/sms-provider';
import type { WhatsAppProvider } from '../server/account/whatsapp-provider';
import {
  NominatimReverseGeocoder,
} from '../server/services/geocoding-provider';
import type { GeocodingProvider } from '../server/services/geocoding-provider';
import { INDIAN_STATES as SERVER_INDIAN_STATES } from '../server/lib/validation';
import { INDIAN_STATES as CLIENT_INDIAN_STATES } from '../src/registration/personal-validation';

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
      authScheme: 'token',
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
): Promise<{ url: string; calls: Array<{ lat: number; lng: number; zoom: number }>; close: () => Promise<void> }> {
  const calls: Array<{ lat: number; lng: number; zoom: number }> = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const lat = Number(u.searchParams.get('lat'));
    const lng = Number(u.searchParams.get('lon'));
    const zoom = Number(u.searchParams.get('zoom'));
    calls.push({ lat, lng, zoom });
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

test('[geocoding] city prefers the settlement over the enclosing district', async () => {
  // Real Nominatim response for central Bengaluru: `city` is the settlement
  // while `district`/`county` name the ward. A postal form must show the city.
  const geo = await startFakeGeocoder((_call) => ({
    json: {
      display_name: 'Ashokanagar, Bengaluru, Karnataka, India',
      address: {
        suburb: 'Ashokanagar',
        city: 'Bengaluru',
        county: 'Bangalore North',
        district: 'Bangalore North',
        state: 'Karnataka',
        postcode: '560001',
        country: 'India',
      },
    },
  }));
  try {
    const provider: GeocodingProvider = new NominatimReverseGeocoder({ baseUrl: geo.url, timeoutMs: 2000 });
    const out = await provider.reverse(12.9716, 77.5946);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.city, 'Bengaluru');
    // The existing district field must keep its old meaning for other callers.
    assert.equal(out.district, 'Bangalore North');
  } finally {
    await geo.close();
  }
});

test('[geocoding] city falls back through town/village when city is absent', async () => {
  const geo = await startFakeGeocoder((_call) => ({
    json: { display_name: 'X', address: { village: 'Nandgaon', state: 'Maharashtra' } },
  }));
  try {
    const provider: GeocodingProvider = new NominatimReverseGeocoder({ baseUrl: geo.url, timeoutMs: 2000 });
    const out = await provider.reverse(19.0, 75.0);
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.city, 'Nandgaon');
  } finally {
    await geo.close();
  }
});

test('[geocoding] zoom is caller-controlled, defaults to 14, and is clamped to 0-18', async () => {
  const geo = await startFakeGeocoder((_call) => ({ json: { display_name: 'X', address: {} } }));
  try {
    const provider: GeocodingProvider = new NominatimReverseGeocoder({ baseUrl: geo.url, timeoutMs: 2000 });
    await provider.reverse(12.9716, 77.5946);
    assert.equal(geo.calls[0].zoom, 14, 'default must stay settlement-level for existing callers');
    await provider.reverse(12.9716, 77.5946, 18);
    assert.equal(geo.calls[1].zoom, 18);
    await provider.reverse(12.9716, 77.5946, 99);
    assert.equal(geo.calls[2].zoom, 18, 'clamped high');
    await provider.reverse(12.9716, 77.5946, -5);
    assert.equal(geo.calls[3].zoom, 0, 'clamped low');
  } finally {
    await geo.close();
  }
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
// ═══════════════════════════════════════════════════════════════════
// PERSONAL INFORMATION — two-phase personal step + GPS address
// ═══════════════════════════════════════════════════════════════════

/** A configured SMS seam that captures the code it was asked to deliver. */
function capturingSms(): { provider: SmsProvider; sent: Array<{ to: string; code: string }> } {
  const sent: Array<{ to: string; code: string }> = [];
  return {
    sent,
    provider: {
      name: 'capture-sms',
      configured: true,
      send: async (to, code) => {
        sent.push({ to, code });
        return { ok: true };
      },
    },
  };
}

/** A configured WhatsApp seam that captures the code it was asked to deliver. */
function capturingWhatsApp(): { provider: WhatsAppProvider; sent: Array<{ to: string; code: string }> } {
  const sent: Array<{ to: string; code: string }> = [];
  return {
    sent,
    provider: {
      name: 'capture-whatsapp',
      configured: true,
      send: async (to, code) => {
        sent.push({ to, code });
        return { ok: true };
      },
    },
  };
}

const UNCONFIGURED_SMS: SmsProvider = {
  name: 'none',
  configured: false,
  send: async () => ({ ok: false, reason: 'unconfigured' as const }),
};
const UNCONFIGURED_WA: WhatsAppProvider = {
  name: 'none',
  configured: false,
  send: async () => ({ ok: false, reason: 'unconfigured' as const }),
};

const GOOD_PERSONAL = {
  firstName: 'Asha',
  middleName: 'R',
  lastName: 'Mehta',
  aadhaarNumber: '123456789012',
  panNumber: 'ABCDE1234F',
  addressOnAadhaar: '12 MG Road, Indiranagar',
  city: 'Bengaluru',
  state: 'Karnataka',
  dateOfBirth: '1990-04-12',
  mobileCountryCode: '+91',
  mobile: '9876543210',
} as const;

test('[personal/step] phase 1 stores details but keeps the step open until the phone is proven', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {
    accountSmsProvider: UNCONFIGURED_SMS,
    accountWhatsAppProvider: UNCONFIGURED_WA,
  });
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    const resp = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL },
    });
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    // The PII landed, but the STEP is not complete: the phone is unproven.
    assert.equal(resp.body.personalVerified, false);
    assert.equal(resp.body.phoneVerified, false);
    // The number is echoed back ONLY masked — never in the clear.
    assert.equal(resp.body.maskedMobile, '+91••••10');
    assert.equal(resp.body.maskedAadhaar, '•••• 9012');
  } finally {
    await stack.close();
  }
});

test('[personal/step] Continue is refused until the phone is verified (fails closed)', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {
    accountSmsProvider: UNCONFIGURED_SMS,
    accountWhatsAppProvider: UNCONFIGURED_WA,
  });
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL },
    });
    const resp = await getJson(`${base}/api/v1/registration/personal/complete`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: {},
    });
    assert.equal(resp.status, 409, 'completing without a proven phone must fail closed');
    assert.equal(resp.body.ok, false);
    assert.match(String(resp.body.message), /SMS or WhatsApp/i);
  } finally {
    await stack.close();
  }
});

test('[personal/step] SMS alone satisfies the phone gate and unlocks Continue', async () => {
  const sms = capturingSms();
  const stack = await listenVerificationServer(makeServerConfig(), {
    accountSmsProvider: sms.provider,
    accountWhatsAppProvider: UNCONFIGURED_WA,
  });
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL },
    });
    const issue = await getJson(`${base}/api/v1/registration/sms/issue`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: {},
    });
    assert.equal(issue.status, 200);
    assert.equal(sms.sent.length, 1);
    assert.equal(sms.sent[0]?.to, '+919876543210', 'the code went to the stored E.164 number');

    const verify = await getJson(`${base}/api/v1/registration/sms/verify`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { code: sms.sent[0]?.code },
    });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.smsOtpVerified, true);
    // The verify route answers with just its own result, so the derived
    // either-or state is read from the authoritative status projection.
    const after = await getJson(`${base}/api/v1/registration/status`, {
      headers: { Cookie: `priestate_reg_sid=${sess}` },
    });
    const s = after.body.session as {
      phoneVerified: boolean;
      phoneChannel: string | null;
      personalVerified: boolean;
      whatsappOtpVerified: boolean;
    };
    assert.equal(s.whatsappOtpVerified, false, 'WhatsApp was never used');
    assert.equal(s.phoneVerified, true, 'EITHER channel is sufficient');
    assert.equal(s.phoneChannel, 'sms');
    // A verified phone proves the NUMBER. It must not, by itself, complete the
    // step — the citizen still owes an explicit Continue.
    assert.equal(s.personalVerified, false, 'phone proof alone must not complete the step');

    const done = await getJson(`${base}/api/v1/registration/personal/complete`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: {},
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.personalVerified, true, 'Continue is what completes the step');

    // Durable: the completion survives a fresh read of the status projection.
    const reread = await getJson(`${base}/api/v1/registration/status`, {
      headers: { Cookie: `priestate_reg_sid=${sess}` },
    });
    assert.equal(
      (reread.body.session as { personalVerified?: boolean } | null)?.personalVerified,
      true,
      'completion is persisted',
    );
  } finally {
    await stack.close();
  }
});

test('[personal/step] WhatsApp alone equally satisfies the phone gate', async () => {
  const wa = capturingWhatsApp();
  const stack = await listenVerificationServer(makeServerConfig(), {
    accountSmsProvider: UNCONFIGURED_SMS,
    accountWhatsAppProvider: wa.provider,
  });
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL },
    });
    const issue = await getJson(`${base}/api/v1/registration/whatsapp/issue`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: {},
    });
    assert.equal(issue.status, 200);
    const verify = await getJson(`${base}/api/v1/registration/whatsapp/verify`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { code: wa.sent[0]?.code },
    });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.whatsappOtpVerified, true);
    const after = await getJson(`${base}/api/v1/registration/status`, {
      headers: { Cookie: `priestate_reg_sid=${sess}` },
    });
    const s = after.body.session as {
      smsOtpVerified: boolean;
      phoneVerified: boolean;
      phoneChannel: string | null;
      personalVerified: boolean;
    };
    assert.equal(s.smsOtpVerified, false);
    assert.equal(s.phoneVerified, true, 'EITHER channel is sufficient');
    assert.equal(s.phoneChannel, 'whatsapp');
    // Same rule as the SMS path: proof of the number is not proof of consent
    // to advance, so Continue still has to be pressed.
    assert.equal(s.personalVerified, false);
    const done = await getJson(`${base}/api/v1/registration/personal/complete`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: {},
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.personalVerified, true);
  } finally {
    await stack.close();
  }
});

test('[personal/step] editing the details invalidates an earlier phone proof', async () => {
  const sms = capturingSms();
  const stack = await listenVerificationServer(makeServerConfig(), {
    accountSmsProvider: sms.provider,
    accountWhatsAppProvider: UNCONFIGURED_WA,
  });
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL },
    });
    await getJson(`${base}/api/v1/registration/sms/issue`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: {},
    });
    await getJson(`${base}/api/v1/registration/sms/verify`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { code: sms.sent[0]?.code },
    });
    const before = await getJson(`${base}/api/v1/registration/status`, {
      headers: { Cookie: `priestate_reg_sid=${sess}` },
    });
    assert.equal((before.body.session as { phoneVerified?: boolean } | null)?.phoneVerified, true);

    // The citizen edits the address → the number may no longer be theirs, so
    // both channels must be proven again.
    const edited = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL, addressOnAadhaar: '99 Church Street, Bangalore' },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.phoneVerified, false, 'the earlier proof no longer counts');
    assert.equal(edited.body.personalVerified, false);
  } finally {
    await stack.close();
  }
});

test('[personal/validation] a malformed PAN is rejected', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    const resp = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL, panNumber: 'NOTAPAN' },
    });
    assert.equal(resp.status, 400);
    assert.match(JSON.stringify(resp.body.issues), /PAN/i);
  } finally {
    await stack.close();
  }
});

test('[personal/validation] a missing first/last name is rejected, a missing middle name is fine', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sessA = await beginSession(base);
    const noName = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sessA}` },
      json: { ...GOOD_PERSONAL, firstName: '', lastName: '' },
    });
    assert.equal(noName.status, 400);
    assert.match(JSON.stringify(noName.body.issues), /first and last name/i);

    const sessB = await beginSession(base);
    const noMiddle = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sessB}` },
      json: { ...GOOD_PERSONAL, middleName: '' },
    });
    assert.equal(noMiddle.status, 200, 'middle name is optional');
  } finally {
    await stack.close();
  }
});

test('[personal/validation] a foreign number is stored as E.164, never remapped to +91', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    // A well-formed UK mobile is accepted and kept in its own country.
    const uk = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL, mobileCountryCode: '+44', mobile: '7400123456' },
    });
    assert.equal(uk.status, 200, JSON.stringify(uk.body));
    assert.equal(uk.body.maskedMobile, '+44••••56', 'full calling code kept, not truncated to +91');

    // A number that does not fit the SELECTED country is refused rather than
    // being coerced into another country's numbering plan.
    const sessB = await beginSession(base);
    const mismatched = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sessB}` },
      json: { ...GOOD_PERSONAL, mobileCountryCode: '+44', mobile: '1234567890' },
    });
    assert.equal(mismatched.status, 400, 'not a valid UK number');

    // The PIN code and state remain India-only even for a foreign number: the
    // identity model was deliberately NOT widened.
    const sessC = await beginSession(base);
    const badPin = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sessC}` },
      json: { ...GOOD_PERSONAL, mobileCountryCode: '+44', mobile: '7400123456', pincode: 'SW1A 1AA' },
    });
    assert.equal(badPin.status, 400, 'a UK postcode is not a valid Indian PIN');
  } finally {
    await stack.close();
  }
});

test('[personal/validation] an unknown country code is refused, never guessed at', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    const resp = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL, mobileCountryCode: '+999', mobile: '7400123456' },
    });
    assert.equal(resp.status, 400);
  } finally {
    await stack.close();
  }
});

test('[personal/validation] an impossible or future date of birth is rejected', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    for (const dob of ['2090-01-01', '2024-02-31', '1899-01-01']) {
      const sess = await beginSession(base);
      const resp = await getJson(`${base}/api/v1/registration/personal`, {
        method: 'POST',
        headers: { Cookie: `priestate_reg_sid=${sess}` },
        json: { ...GOOD_PERSONAL, dateOfBirth: dob },
      });
      assert.equal(resp.status, 400, `${dob} must be rejected`);
      assert.match(JSON.stringify(resp.body.issues), /date of birth/i);
    }
  } finally {
    await stack.close();
  }
});

test('[personal/privacy] a guessed OTP is never accepted and no provider means no success', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {
    accountSmsProvider: UNCONFIGURED_SMS,
    accountWhatsAppProvider: UNCONFIGURED_WA,
  });
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL },
    });
    // Issuing must fail closed when no gateway is configured.
    for (const path of ['sms', 'whatsapp']) {
      const issue = await getJson(`${base}/api/v1/registration/${path}/issue`, {
        method: 'POST',
        headers: { Cookie: `priestate_reg_sid=${sess}` },
        json: {},
      });
      assert.equal(issue.status, 503, `${path} must fail closed when unconfigured`);
    }
    // A hardcoded code must NOT verify.
    const guess = await getJson(`${base}/api/v1/registration/sms/verify`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { code: '123456' },
    });
    assert.notEqual(guess.status, 200, 'a guessed code must never verify');
    assert.equal(guess.body.smsOtpVerified, undefined);
  } finally {
    await stack.close();
  }
});

test('[personal/geocode] a coordinate resolves to an address and the coords are never echoed back', async () => {
  const fake = await startFakeGeocoder(() => ({
    json: {
      display_name: '12 MG Road, Indiranagar, Bengaluru, Karnataka 560038, India',
      address: { district: 'Bengaluru', state: 'Karnataka', postcode: '560038', country: 'India' },
    },
  }));
  const stack = await listenVerificationServer(makeServerConfig(), {
    registrationGeocodingProvider: new NominatimReverseGeocoder({ baseUrl: fake.url }),
  });
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    const resp = await getJson(`${base}/api/v1/registration/personal/reverse-geocode`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { lat: 12.9716, lng: 77.5946 },
    });
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(resp.body.address, '12 MG Road, Indiranagar, Bengaluru, Karnataka 560038, India');
    assert.equal(resp.body.city, 'Bengaluru');
    assert.equal(resp.body.state, 'Karnataka');
    assert.equal(resp.body.pincode, '560038');
    // Raw coordinates are NOT returned to the browser.
    assert.equal(resp.body.lat, undefined);
    assert.equal(resp.body.lng, undefined);
    assert.equal(resp.body.coords, undefined);
  } finally {
    await stack.close();
    await fake.close();
  }
});

test('[personal/geocode] an out-of-range coordinate is rejected without calling the upstream', async () => {
  const fake = await startFakeGeocoder(() => ({ json: { display_name: 'never' } }));
  const stack = await listenVerificationServer(makeServerConfig(), {
    registrationGeocodingProvider: new NominatimReverseGeocoder({ baseUrl: fake.url }),
  });
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    const resp = await getJson(`${base}/api/v1/registration/personal/reverse-geocode`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { lat: 999, lng: 999 },
    });
    assert.equal(resp.status, 400);
    assert.equal(fake.calls.length, 0, 'an invalid coordinate never reaches the provider');
  } finally {
    await stack.close();
    await fake.close();
  }
});

test('[personal/geocode] an unreachable geocoder fails closed and manual entry is offered', async () => {
  const fake = await startFakeGeocoder(() => ({ status: 500, json: { error: 'boom' } }));
  const stack = await listenVerificationServer(makeServerConfig(), {
    registrationGeocodingProvider: new NominatimReverseGeocoder({ baseUrl: fake.url }),
  });
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    const resp = await getJson(`${base}/api/v1/registration/personal/reverse-geocode`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { lat: 12.97, lng: 77.59 },
    });
    assert.equal(resp.status, 502, 'a geocoder failure is reported, never faked');
    assert.equal(resp.body.ok, false);
    assert.match(String(resp.body.message), /manually/i, 'the citizen is told to type it instead');
  } finally {
    await stack.close();
    await fake.close();
  }
});

test('[personal/auth] the personal routes require an active session', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    for (const path of [
      '/api/v1/registration/personal',
      '/api/v1/registration/personal/complete',
      '/api/v1/registration/personal/reverse-geocode',
    ]) {
      const resp = await getJson(`${base}${path}`, { method: 'POST', json: { lat: 1, lng: 1 } });
      assert.equal(resp.status, 401, `${path} must require a session`);
    }
  } finally {
    await stack.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// PERSONAL STEP — completion gate, state allowlist, list drift guard
// ═══════════════════════════════════════════════════════════════════

test('[personal/step] Continue is refused until the phone is actually proven', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL },
    });
    // Details are stored, so a bare Continue must fail closed rather than
    // trusting the client's button state.
    const early = await getJson(`${base}/api/v1/registration/personal/complete`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: {},
    });
    assert.equal(early.status, 409);
    assert.match(JSON.stringify(early.body), /SMS or WhatsApp/i);

    const after = await getJson(`${base}/api/v1/registration/status`, {
      headers: { Cookie: `priestate_reg_sid=${sess}` },
    });
    assert.equal((after.body.session as { personalVerified?: boolean } | null)?.personalVerified, false);
  } finally {
    await stack.close();
  }
});

test('[personal/step] editing the details revokes a completed Continue', async () => {
  const sms = capturingSms();
  const stack = await listenVerificationServer(makeServerConfig(), { accountSmsProvider: sms.provider });
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sess = await beginSession(base);
    await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL },
    });
    await getJson(`${base}/api/v1/registration/sms/issue`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: {},
    });
    await getJson(`${base}/api/v1/registration/sms/verify`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { code: sms.sent[0]?.code },
    });
    const done = await getJson(`${base}/api/v1/registration/personal/complete`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: {},
    });
    assert.equal(done.body.personalVerified, true);

    // Changing the details must send the citizen back through verification.
    const edited = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sess}` },
      json: { ...GOOD_PERSONAL, addressOnAadhaar: '5 MG Road, Bengaluru' },
    });
    assert.equal(edited.body.personalVerified, false, 'Continue was revoked by the edit');
  } finally {
    await stack.close();
  }
});

test('[personal/validation] the state must be a real Indian state or UT', async () => {
  const stack = await listenVerificationServer(makeServerConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const sessA = await beginSession(base);
    const bogus = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sessA}` },
      json: { ...GOOD_PERSONAL, state: 'Atlantis' },
    });
    assert.equal(bogus.status, 400, 'a client cannot invent a state');
    assert.match(JSON.stringify(bogus.body.issues), /state/i);

    const sessB = await beginSession(base);
    const real = await getJson(`${base}/api/v1/registration/personal`, {
      method: 'POST',
      headers: { Cookie: `priestate_reg_sid=${sessB}` },
      json: { ...GOOD_PERSONAL, state: 'Karnataka' },
    });
    assert.equal(real.status, 200, JSON.stringify(real.body));
  } finally {
    await stack.close();
  }
});

test('[personal/validation] server and client state lists cannot drift apart', async () => {
  assert.deepEqual(
    [...SERVER_INDIAN_STATES].sort(),
    [...CLIENT_INDIAN_STATES].sort(),
    'the <select> options and the server allowlist must stay identical',
  );
  assert.equal(SERVER_INDIAN_STATES.length, 36, '28 states + 8 union territories');
  assert.equal(new Set(SERVER_INDIAN_STATES).size, SERVER_INDIAN_STATES.length, 'no duplicates');
});
