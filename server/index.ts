// PRIESTATE — Verification API server.
//
// Run with:  npm run verify-server
//
// REAL contact verification backend:
//   * POST /api/v1/email/send-otp      → server-generated OTP delivered
//                                        to the user's inbox (SMTP).
//   * POST /api/v1/email/verify-otp    → verifies the user-entered code.
//   * POST /api/v1/aadhaar-mobile/start → authorized KYC provider checks
//                                        the mobile↔Aadhaar link (direct
//                                        link check or OTP challenge to
//                                        the REGISTERED mobile).
//   * POST /api/v1/aadhaar-mobile/complete
//   * GET  /api/health                 → capability report for the UI.
//
// Hard rules enforced across every route:
//   * OTPs are generated and checked ONLY here; raw codes are never
//     stored unhashed, never logged, never returned in any response.
//   * All provider credentials live in non-VITE_* env vars.
//   * Missing configuration ⇒ explicit `unavailable` responses. The API
//     NEVER fakes a successful verification.
//
// `createVerificationServer` builds the full stack from an explicit
// ServerConfig (+ optional overrides used by automated tests). The CLI
// entry point below wires it to process.env.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type ServerConfig } from './config';
import { OtpService } from './lib/otp-service';
import { RateLimiter } from './lib/rate-limiter';
import type { Mailer } from './lib/mailer';
import { createSmtpMailer } from './lib/smtp-mailer';
import { SmtpEmailContactProvider } from './services/contact-provider';
import { kycProviderFromConfig } from './services/identity-provider';
import type { IdentityVerificationProvider } from './services/identity-provider-types';
import { normalizeEmail } from './lib/validation';

export interface VerificationServerOverrides {
  /** Test seam: replace SMTP delivery with a capture transport. */
  readonly mailer?: Mailer;
  /** Test seam: replace the Aadhaar KYC adapter wholesale. */
  readonly aadhaarProvider?: IdentityVerificationProvider | null;
}

const DEV_FALLBACK_OTP_SECRET =
  'priestate-insecure-development-otp-secret-0123456789';

interface BuiltStack {
  readonly server: http.Server;
  readonly port: number;
  readonly close: () => Promise<void>;
}

export function createVerificationServer(
  config: ServerConfig,
  overrides: VerificationServerOverrides = {},
): BuiltStack {
  // ── Providers ──────────────────────────────────────────────────────

  const mailer: Mailer | null = overrides.mailer ?? createSmtpMailer(config);
  const otpService = new OtpService({
    hashSecret: config.otp.hashSecret || DEV_FALLBACK_OTP_SECRET,
    ttlMs: config.otp.ttlMs,
    maxAttempts: config.otp.maxAttempts,
    resendCooldownMs: config.otp.resendCooldownMs,
  });

  const emailProvider = new SmtpEmailContactProvider({
    mailer,
    otpService,
    ttlMinutes: Math.max(1, Math.round(otpService.ttlMs / 60_000)),
  });

  const aadhaarProvider: IdentityVerificationProvider | null =
    overrides.aadhaarProvider !== undefined
      ? overrides.aadhaarProvider
      : kycProviderFromConfig({
          providerName: config.aadhaarKyc.providerName,
          apiToken: config.aadhaarKyc.apiToken,
          baseUrl: config.aadhaarKyc.baseUrl,
          mobileLinkPath: config.aadhaarKyc.mobileLinkPath,
          timeoutMs: config.aadhaarKyc.timeoutMs,
        });

  const emailSendIpLimiter = new RateLimiter({
    maxEvents: config.otp.maxSendsPerIpPerHour,
    windowMs: 60 * 60 * 1000,
  });
  const aadhaarStartLimiter = new RateLimiter({ maxEvents: 10, windowMs: 60 * 60 * 1000 });

  // ── HTTP plumbing ──────────────────────────────────────────────────

  const MAX_BODY_BYTES = 8 * 1024;

  interface JsonBody {
    [key: string]: unknown;
  }

  function readJson(req: http.IncomingMessage): Promise<JsonBody | null> {
    return new Promise((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve({});
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsed !== null && typeof parsed === 'object' ? (parsed as JsonBody) : null);
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  let requestOrigin: string | undefined;

  function corsHeaders(): Record<string, string> {
    if (requestOrigin && config.allowedOrigins.includes(requestOrigin)) {
      return {
        'Access-Control-Allow-Origin': requestOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        Vary: 'Origin',
      };
    }
    return { Vary: 'Origin' };
  }

  function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(),
    });
    res.end(body);
  }

  function clientIp(req: http.IncomingMessage): string {
    return req.socket.remoteAddress ?? 'unknown';
  }

  function str(body: JsonBody, key: string): string {
    const v = body[key];
    return typeof v === 'string' ? v : '';
  }

  function unavailableResponse(feature: 'email' | 'aadhaar'): { error: 'unavailable'; message: string } {
    return feature === 'email'
      ? { error: 'unavailable', message: 'Verification service unavailable.' }
      : { error: 'unavailable', message: 'Aadhaar-linked mobile verification is currently unavailable.' };
  }

  // ── Routes ─────────────────────────────────────────────────────────

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    requestOrigin = req.headers.origin;
    const url = (req.url ?? '/').split('?')[0];

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === 'GET' && url === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'priestate-verification-api',
        capabilities: {
          emailOtp: emailProvider.configured,
          aadhaarMobile: aadhaarProvider?.available === true,
        },
        aadhaarProvider: aadhaarProvider?.available === true ? aadhaarProvider.name : null,
      });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    const body = await readJson(req);
    if (body === null) {
      sendJson(res, 400, { error: 'invalid-body' });
      return;
    }

    switch (url) {
      case '/api/v1/email/send-otp':
        return void (await routeEmailSend(req, res, body));
      case '/api/v1/email/verify-otp':
        return void (await routeEmailVerify(res, body));
      case '/api/v1/aadhaar-mobile/start':
        return void (await routeAadhaarStart(req, res, body));
      case '/api/v1/aadhaar-mobile/complete':
        return void (await routeAadhaarComplete(res, body));
      default:
        sendJson(res, 404, { error: 'not-found' });
    }
  }

  async function routeEmailSend(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    if (!emailProvider.configured) {
      sendJson(res, 503, unavailableResponse('email'));
      return;
    }
    const ipLimit = emailSendIpLimiter.take(`ip:${clientIp(req)}`);
    if (!ipLimit.allowed) {
      sendJson(res, 429, {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: ipLimit.retryAfterMs,
        message: 'Too many requests. Try again later.',
      });
      return;
    }

    const result = await emailProvider.sendEmailOtp(str(body, 'email'));
    if (!result.ok) {
      const status =
        result.reason === 'invalid-email' ? 400
        : result.reason === 'cooldown' || result.reason === 'rate-limited' ? 429
        : result.reason === 'provider-error' ? 502
        : 503;
      sendJson(res, status, {
        ok: false,
        reason: result.reason,
        message: result.message,
        retryAfterMs: 'retryAfterMs' in result ? result.retryAfterMs : undefined,
      });
      return;
    }
    // NOTE: no code in the response — it went to the user's inbox only.
    sendJson(res, 200, {
      ok: true,
      expiresAt: result.challenge.expiresAt,
      resendAvailableAt: result.challenge.resendAvailableAt,
    });
  }

  async function routeEmailVerify(res: http.ServerResponse, body: JsonBody): Promise<void> {
    const email = normalizeEmail(str(body, 'email'));
    const code = str(body, 'code');
    if (!email || !/^\d{4,8}$/.test(code.trim())) {
      sendJson(res, 400, { ok: false, reason: 'invalid', message: 'Enter the code that was sent to you.' });
      return;
    }
    const result = await emailProvider.verifyEmailOtp(email, code);
    if (!result.ok) {
      const status = result.reason === 'unavailable' ? 503 : 400;
      sendJson(res, status, { ok: false, reason: result.reason });
      return;
    }
    sendJson(res, 200, { ok: true, verifiedAt: result.verifiedAt, channel: 'email' });
  }

  async function routeAadhaarStart(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    if (aadhaarProvider === null || !aadhaarProvider.available) {
      sendJson(res, 503, unavailableResponse('aadhaar'));
      return;
    }
    const limit = aadhaarStartLimiter.take(`ip:${clientIp(req)}`);
    if (!limit.allowed) {
      sendJson(res, 429, {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: limit.retryAfterMs,
        message: 'Too many verification attempts. Try again later.',
      });
      return;
    }

    const result = await aadhaarProvider.startAadhaarMobileVerification(str(body, 'mobile'));
    if (!result.ok) {
      const status =
        result.reason === 'invalid-mobile' ? 400
        : result.reason === 'rate-limited' ? 429
        : result.reason === 'provider-error' ? 502
        : 503;
      sendJson(res, status, {
        ok: false,
        reason: result.reason,
        message: result.message,
        retryAfterMs: 'retryAfterMs' in result ? result.retryAfterMs : undefined,
      });
      return;
    }
    if (result.mode === 'otp-challenge') {
      sendJson(res, 200, {
        ok: true,
        mode: 'otp-challenge',
        session: result.session,
        message: result.message,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      mode: result.mode,
      ...(result.mode === 'verified' ? { receipt: result.receipt } : {}),
      ...(result.mode === 'not-linked' ? { message: result.message } : {}),
    });
  }

  async function routeAadhaarComplete(res: http.ServerResponse, body: JsonBody): Promise<void> {
    if (aadhaarProvider === null || !aadhaarProvider.available) {
      sendJson(res, 503, unavailableResponse('aadhaar'));
      return;
    }
    const sessionId = str(body, 'sessionId');
    const code = str(body, 'code');
    if (!sessionId || !/^[\d]{4,8}$/.test(code.trim())) {
      sendJson(res, 400, { ok: false, reason: 'invalid-code', message: 'Enter the code sent to your registered mobile.' });
      return;
    }
    const result = await aadhaarProvider.verifyAadhaarMobileVerification({ sessionId, code });
    if (!result.ok) {
      const status =
        result.reason === 'unavailable' ? 503
        : result.reason === 'provider-error' ? 502
        : 400;
      sendJson(res, status, { ok: false, reason: result.reason, message: result.message });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      mode: result.mode,
      ...(result.mode === 'verified' ? { receipt: result.receipt } : {}),
      ...(result.mode === 'not-linked' ? { message: result.message } : {}),
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    });
  });

  return {
    server,
    port: config.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Listen on `port` (or an ephemeral port when port is 0). */
export function listenVerificationServer(
  config: ServerConfig,
  overrides: VerificationServerOverrides = {},
): Promise<BuiltStack> {
  const stack = createVerificationServer(config, overrides);
  return new Promise((resolve, reject) => {
    stack.server.once('error', reject);
    stack.server.listen(config.port, '127.0.0.1', () => {
      const address = stack.server.address() as AddressInfo;
      resolve({ ...stack, port: address.port });
    });
  });
}

// ── CLI entry point ──────────────────────────────────────────────────

function isMainModule(): boolean {
  // tsx sets argv[1] to the executed script path.
  const script = process.argv[1] ?? '';
  return script.endsWith('server/index.ts') || script.endsWith('server/index.js');
}

if (isMainModule()) {
  const config = loadConfig();
  if (!config.otp.hashSecret) {
    console.warn(
      '[priestate-verify] WARNING: OTP_HASH_SECRET is not set — using an insecure development secret. Set it before any real deployment.',
    );
  }
  const { server, port } = createVerificationServer(config);
  server.listen(port, () => {
    console.log(`[priestate-verify] listening on :${port}`);
    console.log('[priestate-verify] OTP codes are generated server-side and never echoed to clients.');
  });
}
