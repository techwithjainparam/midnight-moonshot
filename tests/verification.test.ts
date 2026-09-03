// Tests for REAL contact & identity verification (FEATURE: verification).
//
// Covers:
//   * email validation + real OTP lifecycle (success/wrong/expiry/attempts,
//     cooldown, rate limits) — the dev mock below replaces ONLY the SMTP
//     transport, never the server-side OTP logic,
//   * Indian mobile validation/normalization,
//   * Aadhaar-linked mobile provider (unavailable / success / failure /
//     fail-closed ambiguity),
//   * end-to-end HTTP API behavior including honest "unavailable" states,
//   * security invariants: OTPs never exposed, secrets never VITE_*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { OtpService } from '../server/lib/otp-service';
import type { Mailer } from '../server/lib/mailer';
import {
  isValidEmail,
  normalizeEmail,
  normalizeIndianMobile,
} from '../server/lib/validation';
import { loadConfig, type ServerConfig } from '../server/config';
import { SmtpEmailContactProvider } from '../server/services/contact-provider';
import {
  HttpAadhaarKycProvider,
  interpretLinkResponse,
  kycProviderFromConfig,
} from '../server/services/identity-provider';
import { listenVerificationServer } from '../server/index';

import {
  validateEmail,
  normalizeIndianMobile as feNormalizeIndianMobile,
  parseStoredProfile,
  saveVerifiedProfile,
  getContactProfile,
  getUserProfile,
  hasVerifiedProfile,
  recordAadhaarMobileVerified,
} from '../src/profile/contact-verification';
import {
  AADHAAR_UNAVAILABLE_MESSAGE,
  VERIFICATION_UNAVAILABLE_MESSAGE,
} from '../src/profile/providers/types';
import {
  BackendContactVerificationProvider,
  BackendIdentityVerificationProvider,
} from '../src/profile/providers/backend-providers';

const TEST_HASH_SECRET = 'unit-test-otp-hash-secret-0123456789abcdef';

// ── Test doubles ─────────────────────────────────────────────────────

/** Capture transport — stands in for SMTP ONLY inside automated tests. */
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

function makeOtpService(over: Partial<ConstructorParameters<typeof OtpService>[0]> = {}): OtpService {
  return new OtpService({ hashSecret: TEST_HASH_SECRET, ...over });
}

interface VendorCall {
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

async function startKycVendor(
  handler: (call: VendorCall) => { status?: number; json: unknown },
): Promise<{ url: string; calls: VendorCall[]; close: () => Promise<void> }> {
  const calls: VendorCall[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      const call: VendorCall = {
        path: req.url ?? '',
        auth: req.headers.authorization,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      calls.push(call);
      const out = handler(call);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
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

function makeServerConfig(opts: { emailConfigured?: boolean; ipLimit?: number; registryOfficerToken?: string } = {}): ServerConfig {
  const emailConfigured = opts.emailConfigured ?? true;
  return {
    port: 0,
    allowedOrigins: ['http://localhost:3000'],
    email: {
      configured: emailConfigured,
      host: emailConfigured ? 'smtp.test.local' : '',
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
      maxSendsPerIpPerHour: opts.ipLimit ?? 20,
    },
    aadhaarKyc: {
      providerName: 'test-kyc',
      apiToken: '',
      baseUrl: '',
      mobileLinkPath: '/api/v1/mobile-to-aadhaar/',
      timeoutMs: 2_000,
    },
    registry: {
      officerToken: opts.registryOfficerToken ?? '',
    },
  };
}

async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body: (body ?? {}) as Record<string, unknown>, headers: res.headers };
}

// ═══════════════════════════════════════════════════════════════════
// EMAIL validation
// ═══════════════════════════════════════════════════════════════════

test('[email] valid email addresses are accepted and normalized', () => {
  assert.equal(normalizeEmail('asha.mehta@example.com'), 'asha.mehta@example.com');
  assert.equal(normalizeEmail('  User+Tag@Sub.Domain.CO.IN '), 'user+tag@sub.domain.co.in');
  assert.equal(isValidEmail('a@b.co'), true);
  assert.equal(validateEmail('asha.mehta@example.com'), null); // frontend agrees
});

test('[email] invalid email addresses are rejected', () => {
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail('missing@tld'), false);
  assert.equal(isValidEmail('two@@example.com'), false);
  assert.equal(isValidEmail(`${'a'.repeat(250)}@example.com`), false);
  assert.ok(validateEmail('nope') !== null);
});

// ═══════════════════════════════════════════════════════════════════
// MOBILE validation / normalization
// ═══════════════════════════════════════════════════════════════════

test('[mobile] valid Indian mobiles normalize to +91XXXXXXXXXX', () => {
  assert.equal(normalizeIndianMobile('9876543210'), '+919876543210');
  assert.equal(normalizeIndianMobile('+91 98765 43210'), '+919876543210');
  assert.equal(normalizeIndianMobile('+91-98765-43210'), '+919876543210');
  assert.equal(normalizeIndianMobile('098765 43210'), '+919876543210');
  assert.equal(normalizeIndianMobile('919876543210'), '+919876543210');
  assert.equal(normalizeIndianMobile('(098765) 43210'), '+919876543210');
  // Frontend helper agrees with the server.
  assert.equal(feNormalizeIndianMobile('+91 98765 43210'), '+919876543210');
});

test('[mobile] invalid Indian mobiles are rejected', () => {
  assert.equal(normalizeIndianMobile(''), null);
  assert.equal(normalizeIndianMobile('1234567890'), null); // must start 6–9
  assert.equal(normalizeIndianMobile('987654321'), null); // 9 digits
  assert.equal(normalizeIndianMobile('98765432101'), null); // 11 digits
  assert.equal(normalizeIndianMobile('abcdefghij'), null);
  assert.equal(normalizeIndianMobile('++919876543210'), null);
  assert.equal(feNormalizeIndianMobile('12345'), null);
});

// ═══════════════════════════════════════════════════════════════════
// SERVER-SIDE OTP core
// ═══════════════════════════════════════════════════════════════════

test('[otp] issues a 6-digit code that verifies exactly once', () => {
  const svc = makeOtpService({ ttlMs: 60_000 });
  const issued = svc.issue(OtpService.keyFor('email', 'once@example.com'));
  assert.ok(issued.ok && typeof issued.code === 'string');
  if (!issued.ok || !issued.code) return;
  assert.match(issued.code, /^\d{6}$/);

  const key = OtpService.keyFor('email', 'once@example.com');
  assert.deepEqual(svc.verify(key, issued.code), { ok: true });
  // Single-use: consumed on success.
  assert.deepEqual(svc.verify(key, issued.code), { ok: false, reason: 'expired' });
});

test('[otp] wrong code is rejected as invalid', () => {
  const svc = makeOtpService();
  const issued = svc.issue(OtpService.keyFor('email', 'wrong@example.com'));
  if (!issued.ok || !issued.code) return;
  assert.deepEqual(svc.verify(OtpService.keyFor('email', 'wrong@example.com'), '000000'), {
    ok: false,
    reason: 'invalid',
  });
});

test('[otp] expires after its TTL', () => {
  let t = 1_000_000;
  const svc = makeOtpService({ ttlMs: 5_000, resendCooldownMs: 1, now: () => t });
  const issued = svc.issue('k-expire');
  if (!issued.ok || !issued.code) return;

  t += 4_999;
  assert.deepEqual(svc.verify('k-expire', issued.code), { ok: true }); // still valid

  const fresh = svc.issue('k-expire');
  if (!fresh.ok || !fresh.code) return;
  t += 5_001; // beyond the fresh code's TTL
  assert.deepEqual(svc.verify('k-expire', fresh.code), { ok: false, reason: 'expired' });
});

test('[otp] locks out after the attempt limit even for the correct code', () => {
  const svc = makeOtpService({ maxAttempts: 5 });
  const key = 'k-attempts';
  const issued = svc.issue(key);
  if (!issued.ok || !issued.code) return;

  for (let i = 0; i < 4; i += 1) {
    assert.deepEqual(svc.verify(key, '999999'), { ok: false, reason: 'invalid' });
  }
  // Fifth wrong attempt trips the lock-out…
  assert.deepEqual(svc.verify(key, '999999'), { ok: false, reason: 'too-many-attempts' });
  // …and even the correct code no longer verifies.
  assert.notDeepEqual(svc.verify(key, issued.code), { ok: true });
});

test('[otp] enforces a resend cooldown between issuances', () => {
  let t = 0;
  const svc = makeOtpService({ resendCooldownMs: 1_000, ttlMs: 60_000, now: () => t });

  const first = svc.issue('k-cooldown');
  assert.ok(first.ok);

  t = 500;
  const blocked = svc.issue('k-cooldown');
  assert.ok(!blocked.ok && blocked.reason === 'cooldown');
  assert.ok(blocked.ok === false && blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 500);

  t = 1_500;
  const again = svc.issue('k-cooldown');
  assert.ok(again.ok);
});

test('[otp] caps sends per rolling window (rate limit)', () => {
  let t = 0;
  const svc = makeOtpService({
    resendCooldownMs: 1,
    sendWindowMs: 10_000,
    maxSendsPerWindow: 2,
    ttlMs: 60_000,
    now: () => t,
  });

  assert.ok(svc.issue('k-rate').ok);
  t = 1;
  assert.ok(svc.issue('k-rate').ok);
  t = 2;
  const third = svc.issue('k-rate');
  assert.ok(!third.ok && third.reason === 'rate-limited');

  // Window rolls over → allowed again.
  t = 12_000;
  assert.ok(svc.issue('k-rate').ok);
});

// ═══════════════════════════════════════════════════════════════════
// EMAIL ContactVerificationProvider (server side)
// ═══════════════════════════════════════════════════════════════════

test('[email provider] delivers a REAL code to the inbox and never returns it', async () => {
  const mailer = new CaptureMailer();
  const provider = new SmtpEmailContactProvider({
    mailer,
    otpService: makeOtpService(),
  });

  const result = await provider.sendEmailOtp('inbox@example.com');
  assert.ok(result.ok);
  if (!result.ok) return;

  // The response carries metadata only — NEVER the code.
  assert.ok(result.challenge.expiresAt > Date.now());
  const code = mailer.lastCode();
  assert.ok(code && /^\d{6}$/.test(code));
  assert.ok(!JSON.stringify(result).includes(code));

  // …but the inbox really received it.
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'inbox@example.com');

  // Verification succeeds with the delivered code.
  const verified = await provider.verifyEmailOtp('inbox@example.com', code);
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.match(verified.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test('[email provider] reports unavailable when no mail transport is configured', async () => {
  const provider = new SmtpEmailContactProvider({
    mailer: null, // e.g. SMTP credentials missing on the server
    otpService: makeOtpService(),
  });
  const result = await provider.sendEmailOtp('anyone@example.com');
  assert.deepEqual(result, {
    ok: false,
    reason: 'unavailable',
    message: 'Verification service unavailable.',
  });
});

test('[email provider] rejects invalid input and enforces wrong-code/expiry paths', async () => {
  const mailer = new CaptureMailer();
  const provider = new SmtpEmailContactProvider({
    mailer,
    otpService: makeOtpService(),
  });

  assert.equal((await provider.sendEmailOtp('nope')).ok, false);
  const invalidEmail = await provider.verifyEmailOtp('nope', '123456');
  assert.ok(!invalidEmail.ok && invalidEmail.reason === 'invalid-email');

  const sent = await provider.sendEmailOtp('flow@example.com');
  assert.ok(sent.ok);

  const wrong = await provider.verifyEmailOtp('flow@example.com', '000000');
  assert.deepEqual(wrong, { ok: false, reason: 'invalid' });

  const right = await provider.verifyEmailOtp('FLOW@Example.com', mailer.lastCode()!);
  assert.equal(right.ok, true); // case-insensitive address matching
});

// ═══════════════════════════════════════════════════════════════════
// AADHAAR IdentityVerificationProvider (authorized KYC adapter)
// ═══════════════════════════════════════════════════════════════════

test('[aadhaar] is unavailable without authorized provider credentials', () => {
  assert.equal(
    kycProviderFromConfig({
      providerName: 'surepass',
      apiToken: '', // ← no credentials configured
      baseUrl: '',
      mobileLinkPath: '/x',
      timeoutMs: 1000,
    }),
    null,
  );
  const broken = new HttpAadhaarKycProvider({
    providerName: 'surepass',
    apiToken: '', // ← token missing → feature must be unavailable
    baseUrl: 'https://kyc.example.test',
    authScheme: 'token',
    timeoutMs: 1_000,
  });
  assert.equal(broken.available, false);
});

test('[aadhaar] direct link check confirms linkage and returns a receipt-only result', async () => {
  const vendor = await startKycVendor((call) => ({
    json: call.body.mobile_number === '+919876543210' ? { status_code: 200, data: { registered: true } } : {},
  }));
  try {
    const provider = kycProviderFromConfig({
      providerName: 'surepass-test',
      apiToken: 'vendor-token-123',
      baseUrl: vendor.url,
      mobileLinkPath: '/link/',
      timeoutMs: 2_000,
    })!;

    const result = await provider.startAadhaarMobileVerification('+91 98765 43210');
    assert.ok(result.ok && result.mode === 'verified');
    if (!(result.ok && result.mode === 'verified')) return;

    assert.match(result.receipt.providerVerificationId, /^aadharmob_/);
    assert.equal(result.receipt.verificationStatus, 'VERIFIED');
    assert.equal(result.receipt.mobile, '+919876543210');

    // Credentials went to the vendor, formatted per config.
    assert.equal(vendor.calls[0].auth, 'Token vendor-token-123');
    assert.equal(vendor.calls[0].path, '/link/');
  } finally {
    await vendor.close();
  }
});

test('[aadhaar] not-linked answer is reported honestly (never as verified)', async () => {
  const vendor = await startKycVendor(() => ({ json: { status_code: 200, data: { registered: false } } }));
  try {
    const provider = kycProviderFromConfig({
      providerName: 'surepass-test',
      apiToken: 't',
      baseUrl: vendor.url,
      mobileLinkPath: '/link/',
      timeoutMs: 2_000,
    })!;
    const result = await provider.startAadhaarMobileVerification('9876543210');
    assert.ok(result.ok && result.mode === 'not-linked');
  } finally {
    await vendor.close();
  }
});

test('[aadhaar] ambiguous vendor responses FAIL CLOSED — never reported verified', async () => {
  const vendor = await startKycVendor((): { status?: number; json: unknown } => ({
    json: { status_code: 200, data: { something_else: true } },
  }));
  try {
    const provider = kycProviderFromConfig({
      providerName: 'surepass-test',
      apiToken: 't',
      baseUrl: vendor.url,
      mobileLinkPath: '/link/',
      timeoutMs: 2_000,
    })!;
    const result = await provider.startAadhaarMobileVerification('9876543210');
    assert.ok(!result.ok);
    assert.equal((result as { reason: string }).reason, 'provider-error');
    assert.equal('receipt' in result, false);
  } finally {
    await vendor.close();
  }
});

test('[aadhaar] vendor outage yields provider-error, never success', async () => {
  const vendor = await startKycVendor(() => ({ status: 500, json: { error: 'boom' } }));
  try {
    const provider = kycProviderFromConfig({
      providerName: 'surepass-test',
      apiToken: 't',
      baseUrl: vendor.url,
      mobileLinkPath: '/link/',
      timeoutMs: 2_000,
    })!;
    const result = await provider.startAadhaarMobileVerification('9876543210');
    assert.ok(!result.ok);
    assert.equal((result as { reason: string }).reason, 'provider-error');
  } finally {
    await vendor.close();
  }
});

test('[aadhaar] OTP-challenge flow verifies only after the provider accepts the code', async () => {
  const vendor = await startKycVendor((call): { status?: number; json: unknown } => {
    if (call.path === '/challenge') {
      return { json: { transaction_id: 'txn-777' } };
    }
    if (call.path === '/submit') {
      const okCode = call.body.otp === '654321' && call.body.transaction_id === 'txn-777';
      return okCode
        ? { json: { data: { linked: true } } }
        : { status: 400, json: { error: 'invalid otp' } };
    }
    return { json: {} };
  });
  try {
    const provider = new HttpAadhaarKycProvider({
      providerName: 'challenge-kyc',
      apiToken: 't',
      baseUrl: vendor.url,
      challengePath: '/challenge',
      submitPath: '/submit',
      authScheme: 'token',
      timeoutMs: 2_000,
    });

    const started = await provider.startAadhaarMobileVerification('9812345678');
    assert.ok(started.ok && started.mode === 'otp-challenge');
    if (!(started.ok && started.mode === 'otp-challenge')) return;
    const sessionId = started.session.id;

    // Wrong code → fail closed, NOT verified.
    const bad = await provider.verifyAadhaarMobileVerification({ sessionId, code: '111111' });
    assert.ok(!bad.ok);
    if (!bad.ok) assert.equal(bad.reason, 'provider-error'); // vendor rejected the OTP

    // Correct code completes the verification via the provider.
    const good = await provider.verifyAadhaarMobileVerification({ sessionId, code: '654321' });
    assert.ok(good.ok && good.mode === 'verified');
    if (!(good.ok && good.mode === 'verified')) return;
    assert.equal(good.receipt.mobile, '+919812345678');
    assert.match(good.receipt.providerVerificationId, /^aadharmob_/);

    // Unknown sessions are rejected.
    const ghost = await provider.verifyAadhaarMobileVerification({ sessionId: 'does-not-exist', code: '654321' });
    assert.ok(!ghost.ok && ghost.reason === 'invalid-session');
  } finally {
    await vendor.close();
  }
});

test('[aadhaar] receipts contain NO Aadhaar numbers — only traceability IDs', async () => {
  const vendor = await startKycVendor(() => ({ json: { data: { registered: true, aadhaar_number: '1234-5678-9012' } } }));
  try {
    const provider = kycProviderFromConfig({
      providerName: 'surepass-test',
      apiToken: 't',
      baseUrl: vendor.url,
      mobileLinkPath: '/link/',
      timeoutMs: 2_000,
    })!;
    const result = await provider.startAadhaarMobileVerification('9876500000');
    assert.ok(result.ok && result.mode === 'verified');
    if (!(result.ok && result.mode === 'verified')) return;
    const receiptJson = JSON.stringify(result.receipt);
    assert.match(receiptJson, /aadharmob_[0-9a-f-]{36}/);
    assert.doesNotMatch(receiptJson, /"aadhaar/i);
    // No raw 12-digit Aadhaar number anywhere (the verified mobile is
    // expected and stripped before the check).
    assert.doesNotMatch(receiptJson.replace(/\+91\d{10}/g, ''), /\d{12}/);
  } finally {
    await vendor.close();
  }
});

test('[aadhaar] link interpretation handles common vendor shapes and fails closed', () => {
  assert.deepEqual(interpretLinkResponse({ data: { registered: true } }), { linked: true });
  assert.deepEqual(interpretLinkResponse({ data: { linked: false } }), { linked: false });
  assert.deepEqual(interpretLinkResponse({ linked: 'true' }), { linked: true });
  assert.deepEqual(interpretLinkResponse({ data: { is_linked: 'false' } }), { linked: false });
  assert.deepEqual(interpretLinkResponse({ data: { aadhaar_linked: true } }), { linked: true });
  assert.equal(interpretLinkResponse({ hello: 'world' }), null);
  assert.equal(interpretLinkResponse(null), null);
});

// ═══════════════════════════════════════════════════════════════════
// END-TO-END verification API
// ═══════════════════════════════════════════════════════════════════

test('[api] unconfigured features respond 503 with honest unavailability messages', async () => {
  const stack = await listenVerificationServer(makeServerConfig({ emailConfigured: false }), {
    aadhaarProvider: null,
  });
  try {
    const base = `http://127.0.0.1:${stack.port}`;

    const health = await getJson(`${base}/api/health`);
    assert.deepEqual(health.body.capabilities, {
      emailOtp: false,
      aadhaarMobile: false,
      registry: false,
      account: { smsOtp: false, whatsappOtp: false, google: false },
    });

    const email = await getJson(`${base}/api/v1/email/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'someone@example.com' }),
    });
    assert.equal(email.status, 503);
    assert.equal(email.body.message, VERIFICATION_UNAVAILABLE_MESSAGE);

    const aadhaar = await getJson(`${base}/api/v1/aadhaar-mobile/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '9876543210' }),
    });
    assert.equal(aadhaar.status, 503);
    assert.equal(aadhaar.body.message, AADHAAR_UNAVAILABLE_MESSAGE);
  } finally {
    await stack.close();
  }
});

test('[api] full email OTP round trip — the code exists ONLY in the inbox, never in responses', async () => {
  const mailer = new CaptureMailer();
  const stack = await listenVerificationServer(makeServerConfig(), { mailer });
  const base = `http://127.0.0.1:${stack.port}`;
  try {
    const health = await getJson(`${base}/api/health`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    assert.deepEqual(health.body.capabilities, {
      emailOtp: true,
      aadhaarMobile: false,
      registry: false,
      account: { smsOtp: false, whatsappOtp: false, google: false },
    });
    assert.equal(health.headers.get('access-control-allow-origin'), 'http://localhost:3000');

    const send = await getJson(`${base}/api/v1/email/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'User@Example.com' }),
    });
    assert.equal(send.status, 200);
    assert.equal(send.body.ok, true);
    assert.ok(typeof send.body.expiresAt === 'number');

    const deliveredCode = mailer.lastCode();
    assert.ok(deliveredCode && /^\d{6}$/.test(deliveredCode));
    assert.ok(!JSON.stringify(send.body).includes(deliveredCode)); // never echoed

    const wrongVerify = await getJson(`${base}/api/v1/email/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', code: '000000' }),
    });
    assert.equal(wrongVerify.status, 400);
    assert.equal(wrongVerify.body.reason, 'invalid');    assert.ok(!JSON.stringify(wrongVerify.body).includes(deliveredCode));

    const rightVerify = await getJson(`${base}/api/v1/email/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', code: deliveredCode }),
    });
    assert.equal(rightVerify.status, 200);
    assert.equal(rightVerify.body.ok, true);

    // One-time use: replaying the same code fails.
    const replay = await getJson(`${base}/api/v1/email/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', code: deliveredCode }),
    });
    assert.equal(replay.body.ok, false);
  } finally {
    await stack.close();
  }
});

test('[api] rate-limits sends per client IP', async () => {
  const stack = await listenVerificationServer(makeServerConfig({ ipLimit: 1 }), {
    mailer: new CaptureMailer(),
  });
  const base = `http://127.0.0.1:${stack.port}`;
  try {
    const first = await getJson(`${base}/api/v1/email/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'first@example.com' }),
    });
    assert.equal(first.status, 200);

    const second = await getJson(`${base}/api/v1/email/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'second@example.com' }),
    });
    assert.equal(second.status, 429);
    assert.equal(second.body.reason, 'rate-limited');
    assert.ok(typeof second.body.retryAfterMs === 'number');
  } finally {
    await stack.close();
  }
});

test('[api] aadhaar start validates input and passes provider verdicts through', async () => {
  const vendor = await startKycVendor((call) => ({
    json: call.body.mobile_number === '+919876543210' ? { data: { registered: true } } : { data: { registered: false } },
  }));
  const provider = kycProviderFromConfig({
    providerName: 'vendor-e2e',
    apiToken: 'tok',
    baseUrl: vendor.url,
    mobileLinkPath: '/link/',
    timeoutMs: 2_000,
  })!;
  const stack = await listenVerificationServer(makeServerConfig(), { aadhaarProvider: provider });
  const base = `http://127.0.0.1:${stack.port}`;
  try {
    const health = await getJson(`${base}/api/health`);
    const capabilities = health.body.capabilities as Record<string, unknown>;
    assert.equal(capabilities.aadhaarMobile, true);
    assert.equal(health.body.aadhaarProvider, 'vendor-e2e');

    const badInput = await getJson(`${base}/api/v1/aadhaar-mobile/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '12345' }),
    });
    assert.equal(badInput.status, 400);
    assert.equal(badInput.body.reason, 'invalid-mobile');

    const linked = await getJson(`${base}/api/v1/aadhaar-mobile/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '+91 98765 43210' }),
    });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.mode, 'verified');
    const receipt = linked.body.receipt as Record<string, unknown>;
    assert.match(String(receipt.providerVerificationId), /^aadharmob_/);
    assert.equal(receipt.verificationStatus, 'VERIFIED');

    const notLinked = await getJson(`${base}/api/v1/aadhaar-mobile/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '9811100000' }),
    });
    assert.equal(notLinked.status, 200);
    assert.equal(notLinked.body.mode, 'not-linked');
    assert.equal(notLinked.body.ok, true);
    assert.equal('receipt' in notLinked.body, false);
  } finally {
    await stack.close();
    await vendor.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// FRONTEND provider clients against the live API
// ═══════════════════════════════════════════════════════════════════

test('[client] BackendContactVerificationProvider round-trips the wire format', async () => {
  const mailer = new CaptureMailer();
  const stack = await listenVerificationServer(makeServerConfig(), { mailer });
  try {
    const client = new BackendContactVerificationProvider(`http://127.0.0.1:${stack.port}`);

    const sent = await client.sendEmailOtp('wire@example.com');
    assert.ok(sent.ok);
    if (!sent.ok) return;
    assert.ok(sent.challenge.expiresAt > Date.now());
    assert.ok(sent.challenge.resendAvailableAt > Date.now());

    const wrong = await client.verifyEmailOtp('wire@example.com', '000000');
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.reason, 'invalid');

    const right = await client.verifyEmailOtp('wire@example.com', mailer.lastCode()!);
    assert.equal(right.ok, true);
  } finally {
    await stack.close();
  }
});

test('[client] Aadhaar client reports unavailable when the API cannot be reached', async () => {
  const client = new BackendIdentityVerificationProvider('http://127.0.0.1:1'); // nothing listening
  const result = await client.startAadhaarMobileVerification('9876543210');
  assert.deepEqual(result, { ok: false, reason: 'unavailable', message: AADHAAR_UNAVAILABLE_MESSAGE });
});

test('[client] Aadhaar client surfaces provider verdicts end-to-end', async () => {
  const vendor = await startKycVendor(() => ({ json: { data: { registered: true } } }));
  const provider = kycProviderFromConfig({
    providerName: 'vendor-client',
    apiToken: 'tok',
    baseUrl: vendor.url,
    mobileLinkPath: '/link/',
    timeoutMs: 2_000,
  })!;
  const stack = await listenVerificationServer(makeServerConfig(), { aadhaarProvider: provider });
  try {
    const client = new BackendIdentityVerificationProvider(`http://127.0.0.1:${stack.port}`);
    assert.equal(await client.isConfiguredOnServer(), true);

    const result = await client.startAadhaarMobileVerification('9876543210');
    assert.ok(result.ok && result.mode === 'verified');
    if (!(result.ok && result.mode === 'verified')) return;
    assert.match(result.receipt.providerVerificationId, /^aadharmob_/);
    assert.equal(result.receipt.verificationStatus, 'VERIFIED');
    // No Aadhaar number ever reaches the browser.
    assert.doesNotMatch(JSON.stringify(result), /"aadhaar/i);
  } finally {
    await stack.close();
    await vendor.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// SECURITY invariants
// ═══════════════════════════════════════════════════════════════════

test('[security] no secret-bearing VITE_* variable is referenced anywhere in src/', () => {
  const srcRoot = fileURLToPath(new URL('../src', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(p);
    }
  };
  walk(srcRoot);

  // Names carry no real secret in the VITE_ namespace. The two registration
  // vars are intentionally-named DEMO secrets: they default to a throwaway
  // all-zero key in the browser and only ever authorize local demo flows
  // (real authorization is enforced on-chain by the designated-officer gate).
  const allowlisted = new Set([
    'VITE_PRIESTATE_APPLICANT_SECRET',
    'VITE_PRIESTATE_OFFICER_SECRET',
  ]);
  const forbidden = /(SMTP|KYC|AADHAAR|OTP|SECRET|PASSWORD|TOKEN|API_KEY|PASS|KEY)/i;
  const offenders: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const m of content.matchAll(/VITE_[A-Z0-9_]+/g)) {
      if (allowlisted.has(m[0])) continue;
      if (forbidden.test(m[0])) offenders.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('[security] loadConfig ignores VITE_* variables entirely', () => {
  const cfg = loadConfig({
    VITE_SMTP_PASS: 'browser-leaked-smtp-secret',
    VITE_OTP_HASH_SECRET: 'browser-leaked-otp-secret',
    VITE_AADHAAR_KYC_API_TOKEN: 'browser-leaked-kyc-token',
  } as unknown as NodeJS.ProcessEnv);

  assert.equal(cfg.email.configured, false); // VITE_SMTP_PASS did NOT configure SMTP
  const serialized = JSON.stringify(cfg);
  assert.ok(!serialized.includes('browser-leaked-smtp-secret'));
  assert.ok(!serialized.includes('browser-leaked-otp-secret'));
  assert.ok(!serialized.includes('browser-leaked-kyc-token'));
});

test('[security] .env.example keeps every credential outside the VITE_ namespace', () => {
  const envExample = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
  const lines = envExample.split('\n').filter((l) => /^\s*VITE_[A-Z0-9_]+=/.test(l));
  const names = lines.map((l) => l.split('=')[0]);
  // The two registration vars are intentionally-named DEMO secrets (see the
  // allowlist above); they default to throwaway keys and carry no real secret.
  const allowlisted = new Set([
    'VITE_PRIESTATE_APPLICANT_SECRET',
    'VITE_PRIESTATE_OFFICER_SECRET',
  ]);
  for (const name of names) {
    if (allowlisted.has(name)) continue;
    assert.equal(
      /(SMTP|KYC|AADHAAR|OTP|SECRET|PASSWORD|TOKEN|PASS|KEY)/i.test(name),
      false,
      `${name} must not carry a secret`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════
// PROFILE store (verification results only)
// ═══════════════════════════════════════════════════════════════════

test('[profile] legacy v1 profiles migrate into the channel model', () => {
  const legacy = JSON.stringify({
    address: 'legacy-wallet',
    contactType: 'email',
    contactValue: 'old@example.com',
    verifiedAt: '2025-01-01T00:00:00.000Z',
  });
  const parsed = parseStoredProfile(legacy);
  assert.ok(parsed?.email);
  assert.equal(parsed.email?.value, 'old@example.com');

  const saved = saveVerifiedProfile('legacy-wallet', 'mobile', '+919876500001');
  assert.equal(getContactProfile('legacy-wallet')?.contactValue, '+919876500001');
  assert.equal(hasVerifiedProfile('LEGACY-WALLET'), true);
  assert.ok(saved.verifiedAt);
});

test('[profile] aadhaar record stores verification result only — never an Aadhaar number', () => {
  const rec = recordAadhaarMobileVerified('receipt-wallet', {
    mobile: '+919876543210',
    providerVerificationId: 'aadharmob_test-0001',
    verificationStatus: 'VERIFIED',
  });
  assert.equal(rec.verified, true);
  assert.equal(rec.providerVerificationId, 'aadharmob_test-0001');
  assert.equal(rec.verificationStatus, 'VERIFIED');

  const profile = getUserProfile('receipt-wallet');
  assert.equal(profile?.aadhaarMobile?.verified, true);
  const json = JSON.stringify(profile);
  assert.doesNotMatch(json, /"aadhaarNumber"/i);
  assert.doesNotMatch(json.replace(/\+91\d{10}/g, ''), /\d{12}/); // no raw 12-digit value
  assert.equal(hasVerifiedProfile('receipt-wallet'), true);
});
