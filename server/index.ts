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
// Registry metadata API (application/officer support — see server/registry):
//   * POST /api/v1/officer/applications   → authorized officer catalogues
//                                            metadata referencing an on-chain
//                                            registration (NO verdict, no
//                                            property VALUE, no secrets).
//   * GET  /api/v1/officer/applications   → list catalogued metadata.
//   * GET  /api/v1/officer/applications/:id
//   * POST /api/v1/applications            → applicant persists ONLY safe public
//                                            metadata referencing a real on-chain
//                                            registration id, without the officer
//                                            credential (grants no officer
//                                            privilege; no verdict, no property
//                                            VALUE, no secrets).
//
// The registry routes are an ADDITIONAL server-side officer boundary (Bearer
// REGISTRY_OFFICER_API_TOKEN) for officer operations. The applicant route above
// is a separate, lower-privilege intake that never touches the officer
// credential. None of them fabricate an on-chain verdict or store the
// confidential property VALUE; the Midnight contract remains the source of
// truth for on-chain status.
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
import { RegistryService } from './registry/service';
import type { RegistryStore } from './registry/store';
import { InMemoryRegistryStore } from './registry/store';
import { AccountService } from './account/service';
import type { AccountStore } from './account/store';
import { openDatabase } from './account/db';
import { SqliteAccountStore } from './account/sqlite-store';
import { SessionService } from './account/session';

export interface VerificationServerOverrides {
  /** Test seam: replace SMTP delivery with a capture transport. */
  readonly mailer?: Mailer;
  /** Test seam: replace the Aadhaar KYC adapter wholesale. */
  readonly aadhaarProvider?: IdentityVerificationProvider | null;
  /** Test seam: replace the registry metadata persistence backend. */
  readonly registryStore?: RegistryStore;
  /** Test seam: override the server-side officer credential for registry ops. */
  readonly registryOfficerToken?: string;
  /** Test seam: replace the account persistence backend. */
  readonly accountStore?: AccountStore;
  /** Test seam: account PII encryption secret (fail closed without it). */
  readonly accountEncryptionSecret?: string;
  /** Test seam: SMS OTP delivery transport (capture real codes in tests). */
  readonly accountSmsDelivery?: { configured: boolean; send: (to: string, code: string) => void };
  /** Test seam: WhatsApp OTP delivery transport. */
  readonly accountWhatsappDelivery?: { configured: boolean; send: (to: string, code: string) => void };
  /** Test seam: Google OAuth boundary. */
  readonly accountGoogleAuthenticator?: { configured: boolean; complete: (code: string) => boolean };
  /** Test seam: provide a pre-built SessionService. */
  readonly sessionService?: SessionService;
  /** Test seam: SQLite database handle (skips openDatabase when set). */
  readonly db?: import('better-sqlite3').Database;
}

const DEV_FALLBACK_OTP_SECRET =
  'priestate-insecure-development-otp-secret-0123456789';

interface BuiltStack {
  readonly server: http.Server;
  readonly port: number;
  readonly close: () => Promise<void>;
  /** Expose session service so tests can create/validate sessions. */
  readonly sessions: SessionService;
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

  // Registry metadata API: an ADDITIONAL server-side officer boundary (see
  // server/registry/service.ts). The officer credential is a non-VITE_* env
  // var; empty ⇒ the feature reports `unavailable` (fail closed).
  const registryStore: RegistryStore = overrides.registryStore ?? new InMemoryRegistryStore();
  const registryService = new RegistryService({
    store: registryStore,
    officerToken: overrides.registryOfficerToken ?? config.registry.officerToken,
  });

  // Level 3 account service. PII-at-rest encryption secret, SMS/WhatsApp
  // delivery, and the Google OAuth boundary are provider-configured; when any
  // is unset the affected feature reports `unavailable` (fail closed) — we
  // never fabricate auth. Test seams replace the transport with capture hooks.

  // ── Database + persistent store (Level 3 Part 2) ─────────────────
  const db = overrides.db ?? openDatabase(config.account?.dbPath || undefined);
  const persistentAccountStore: AccountStore =
    overrides.accountStore ?? new SqliteAccountStore(db);

  // ── Server-side sessions ────────────────────────────────────────
  const sessionService: SessionService =
    overrides.sessionService ??
    new SessionService(db, {
      secure: config.account?.sessionSecure ?? true,
      ttlMs: config.account?.sessionTtlMs,
    });

  const accountService = new AccountService({
    store: persistentAccountStore,
    encryptionSecret: overrides.accountEncryptionSecret ?? config.account?.encryptionSecret ?? '',
    otp: { hashSecret: config.otp.hashSecret || DEV_FALLBACK_OTP_SECRET },
    smsDelivery:
      overrides.accountSmsDelivery ??
      (config.account?.smsConfigured
        ? { configured: true, send: () => undefined }
        : { configured: false, send: () => undefined }),
    whatsappDelivery:
      overrides.accountWhatsappDelivery ??
      (config.account?.whatsappConfigured
        ? { configured: true, send: () => undefined }
        : { configured: false, send: () => undefined }),
    googleAuthenticator:
      overrides.accountGoogleAuthenticator ??
      (config.account?.googleConfigured
        ? { configured: true, complete: () => false }
        : { configured: false, complete: () => false }),
  });

  const emailSendIpLimiter = new RateLimiter({
    maxEvents: config.otp.maxSendsPerIpPerHour,
    windowMs: 60 * 60 * 1000,
  });
  const aadhaarStartLimiter = new RateLimiter({ maxEvents: 10, windowMs: 60 * 60 * 1000 });
  // Account-sensitive endpoint rate limiters (per IP, per window).
  const accountRegisterLimiter = new RateLimiter({ maxEvents: 3, windowMs: 60 * 60 * 1000 });
  const accountLoginLimiter = new RateLimiter({ maxEvents: 5, windowMs: 60 * 60 * 1000 });
  const accountOtpSendLimiter = new RateLimiter({ maxEvents: 10, windowMs: 60 * 60 * 1000 });

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

  /** Extract a `Bearer <token>` from an Authorization header ('' when absent). */
  function bearerToken(header: string | undefined): string {
    if (!header) return '';
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    return m ? m[1].trim() : '';
  }

  /** Parse the priestate_sid cookie from the request's Cookie header. */
  function parseSessionCookie(req: http.IncomingMessage): string | null {
    const cookieHeader = req.headers.cookie ?? '';
    const match = /(?:^|;\s*)priestate_sid=([^;]+)/.exec(cookieHeader);
    return match ? match[1] : null;
  }

  /**
   * Validate the session cookie. Returns `{ accountId, walletAddress }` if
   * valid, otherwise sends a 401 response and returns null.
   */
  function requireAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): { accountId: string; walletAddress: string } | null {
    const token = parseSessionCookie(req);
    if (!token) {
      sendJson(res, 401, { ok: false, reason: 'unauthorized', message: 'Login required.' });
      return null;
    }
    const session = sessionService.get(token);
    if (!session) {
      res.setHeader('Set-Cookie', SessionService.clearCookieHeader(config.account?.sessionSecure ?? true));
      sendJson(res, 401, { ok: false, reason: 'session-expired', message: 'Session expired. Please log in again.' });
      return null;
    }
    return { accountId: session.accountId, walletAddress: session.walletAddress };
  }

  function unavailableResponse(feature: 'email' | 'aadhaar'): { error: 'unavailable'; message: string } {
    return feature === 'email'
      ? { error: 'unavailable', message: 'Verification service unavailable.' }
      : { error: 'unavailable', message: 'Aadhaar-linked mobile verification is not available in this demo.' };
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
          registry: registryService.available,
          account: {
            smsOtp: accountService.smsConfigured,
            whatsappOtp: accountService.whatsappConfigured,
            google: accountService.googleConfigured,
          },
        },
        aadhaarProvider: aadhaarProvider?.available === true ? aadhaarProvider.name : null,
      });
      return;
    }

    if (req.method === 'GET' && url === '/api/v1/account/capabilities') {
      sendJson(res, 200, { ok: true, ...accountService.capabilities });
      return;
    }

    if (req.method === 'GET' && url === '/api/v1/account/me') {
      routeAccountMe(req, res);
      return;
    }

    // Logout works for both GET and POST for easy client integration.
    if (url === '/api/v1/account/logout' && (req.method === 'GET' || req.method === 'POST')) {
      routeAccountLogout(req, res);
      return;
    }

    // Registry metadata API (server-side officer boundary). Supports GET and
    // POST, all guarded by a server-side officer credential.
    if (url.startsWith('/api/v1/officer/applications')) {
      const rest = url.slice('/api/v1/officer/applications'.length);
      const token = bearerToken(req.headers.authorization);
      if (req.method === 'POST' && rest === '') {
        const body = await readJson(req);
        if (body === null) {
          sendJson(res, 400, { error: 'invalid-body' });
          return;
        }
        routeRegistryCreate(res, token, body);
        return;
      }
      if (req.method === 'GET' && rest === '') {
        routeRegistryList(res, token);
        return;
      }
      const match = /^\/([^/]+)\/?$/.exec(rest);
      if (req.method === 'GET' && match) {
        routeRegistryGet(res, token, decodeURIComponent(match[1]));
        return;
      }
      sendJson(res, 404, { error: 'not-found' });
      return;
    }

    // Applicant registry metadata intake. Distinct from the officer boundary:
    // an applicant persists ONLY safe public metadata referencing a real
    // on-chain registration id after a successful submission, WITHOUT the
    // server-side officer credential (which never reaches the browser). No
    // officer privilege is granted and a verdict can never be asserted.
    if (req.method === 'POST' && url === '/api/v1/applications') {
      const body = await readJson(req);
      if (body === null) {
        sendJson(res, 400, { error: 'invalid-body' });
        return;
      }
      routeRegistryApplicantCreate(res, body);
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
      case '/api/v1/account/register':
        return void (await routeAccountRegister(req, res, body));
      case '/api/v1/account/otp-sms/send':
        return void (await routeAccountSmsSend(req, res));
      case '/api/v1/account/otp-sms/verify':
        return void (await routeAccountSmsVerify(req, res, body));
      case '/api/v1/account/otp-whatsapp/send':
        return void (await routeAccountWhatsappSend(req, res));
      case '/api/v1/account/otp-whatsapp/verify':
        return void (await routeAccountWhatsappVerify(req, res, body));
      case '/api/v1/account/google/begin':
        return void (await routeAccountGoogleBegin(req, res));
      case '/api/v1/account/google/complete':
        return void (await routeAccountGoogleComplete(req, res, body));
      case '/api/v1/account/exists':
        return void routeAccountExists(res, body);
      case '/api/v1/account/login/state':
        return void routeAccountLoginState(res, body);
      case '/api/v1/account/login/face-verification':
        return void routeAccountFaceVerification(res, body);
      case '/api/v1/account/identity-verified':
        return void (await routeAccountIdentity(req, res, body));
      case '/api/v1/account/login':
        return void (await routeAccountLogin(req, res, body));
      default:
        sendJson(res, 404, { error: 'not-found' });
    }
  }

  // ── Level 3 account routes ─────────────────────────────────────────

  function sendAccountError(
    res: http.ServerResponse,
    reason: string,
  ): void {
    switch (reason) {
      case 'unavailable':
        sendJson(res, 503, {
          ok: false,
          reason: 'unavailable',
          message: 'This factor’s delivery channel is not configured in this demo.',
        });
        return;
      case 'unauthorized':
        sendJson(res, 401, { ok: false, reason: 'unauthorized' });
        return;
      case 'invalid-input':
        sendJson(res, 400, { ok: false, reason: 'invalid-input' });
        return;
      case 'already-registered':
        sendJson(res, 409, { ok: false, reason: 'already-registered' });
        return;
      case 'not-found':
        sendJson(res, 404, { ok: false, reason: 'not-found' });
        return;
      case 'factor-missing':
        sendJson(res, 403, { ok: false, reason: 'factor-missing' });
        return;
      case 'identity-verification-required':
        sendJson(res, 428, { ok: false, reason: 'identity-verification-required' });
        return;
      case 'bad-state':
        sendJson(res, 400, { ok: false, reason: 'bad-state', message: 'Invalid Google sign-in state.' });
        return;
      case 'expired':
        sendJson(res, 400, { ok: false, reason: 'expired', message: 'Google sign-in state expired. Restart it.' });
        return;
      case 'replay':
        sendJson(res, 400, { ok: false, reason: 'replay', message: 'Google sign-in state was already used.' });
        return;
      default:
        sendJson(res, 500, { ok: false, reason: 'internal' });
    }
  }

  /** OTP metadata without the raw code — the code is only sent to the device. */

  async function routeAccountRegister(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    // Rate limit: max 3 registrations per IP per hour.
    const limit = accountRegisterLimiter.take(`ip:${clientIp(req)}`);
    if (!limit.allowed) {
      sendJson(res, 429, {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: limit.retryAfterMs,
        message: 'Too many registration attempts. Try again later.',
      });
      return;
    }
    const result = accountService.register(body);
    if (!result.ok) {
      sendAccountError(res, result.reason);
      return;
    }
    if (!('view' in result)) return sendAccountError(res, 'internal');
    // Create a session on successful registration so the user is logged in.
    const { cookieHeader } = sessionService.create(result.view.accountId, result.view.walletAddress);
    res.setHeader('Set-Cookie', cookieHeader);
    sendJson(res, 201, { ok: true, account: result.view });
  }

  async function routeAccountSmsSend(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const auth = requireAuth(req, res);
    if (!auth) return;
    // Rate limit: max 10 OTP sends per IP per hour.
    const limit = accountOtpSendLimiter.take(`ip:${clientIp(req)}`);
    if (!limit.allowed) {
      sendJson(res, 429, {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: limit.retryAfterMs,
        message: 'Too many OTP requests. Try again later.',
      });
      return;
    }
    const result = accountService.issueSmsOtp(auth.walletAddress);
    if (result.ok === true) {
      sendJson(res, 200, { ok: true, channel: 'sms', expiresAt: result.expiresAt });
      return;
    }
    if (result.reason === 'cooldown' || result.reason === 'rate-limited') {
      sendJson(res, 429, {
        ok: false,
        reason: result.reason,
        retryAfterMs: result.retryAfterMs,
      });
      return;
    }
    sendAccountError(res, result.reason);
  }

  async function routeAccountSmsVerify(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const code = str(body, 'code').trim();
    if (!/^\d{6}$/.test(code)) {
      sendJson(res, 400, { ok: false, reason: 'invalid', message: 'Enter the 6-digit code.' });
      return;
    }
    const result = accountService.verifySmsOtp(auth.walletAddress, code);
    if (result.ok === true) {
      sendJson(res, 200, { ok: true, channel: 'sms' });
      return;
    }
    if (result.reason === 'expired' || result.reason === 'too-many-attempts') {
      sendJson(res, 400, { ok: false, reason: result.reason });
      return;
    }
    sendAccountError(res, result.reason);
  }

  async function routeAccountWhatsappSend(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const limit = accountOtpSendLimiter.take(`ip:${clientIp(req)}`);
    if (!limit.allowed) {
      sendJson(res, 429, {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: limit.retryAfterMs,
        message: 'Too many OTP requests. Try again later.',
      });
      return;
    }
    const result = accountService.issueWhatsappOtp(auth.walletAddress);
    if (result.ok === true) {
      sendJson(res, 200, { ok: true, channel: 'whatsapp', expiresAt: result.expiresAt });
      return;
    }
    if (result.reason === 'cooldown' || result.reason === 'rate-limited') {
      sendJson(res, 429, {
        ok: false,
        reason: result.reason,
        retryAfterMs: result.retryAfterMs,
      });
      return;
    }
    sendAccountError(res, result.reason);
  }

  async function routeAccountWhatsappVerify(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const code = str(body, 'code').trim();
    if (!/^\d{6}$/.test(code)) {
      sendJson(res, 400, { ok: false, reason: 'invalid', message: 'Enter the 6-digit code.' });
      return;
    }
    const result = accountService.verifyWhatsappOtp(auth.walletAddress, code);
    if (result.ok === true) {
      sendJson(res, 200, { ok: true, channel: 'whatsapp' });
      return;
    }
    if (result.reason === 'expired' || result.reason === 'too-many-attempts') {
      sendJson(res, 400, { ok: false, reason: result.reason });
      return;
    }
    sendAccountError(res, result.reason);
  }

  async function routeAccountGoogleComplete(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const authCode = str(body, 'authCode') || str(body, 'code');
    const state = str(body, 'state');
    const nonce = str(body, 'nonce');

    // Secure state/nonce flow: the client begins Google auth, receives a
    // state+nonce, and echoes them here. If present they are enforced.
    if (state && nonce) {
      const result = accountService.googleComplete(auth.walletAddress, { state, nonce, code: authCode });
      if (result.ok && 'view' in result) {
        sendJson(res, 200, { ok: true, account: result.view });
        return;
      }
      sendAccountError(res, result.ok ? 'internal' : result.reason);
      return;
    }

    // Legacy code-only path (used by existing tests / simple flows).
    const result = accountService.completeGoogle(auth.walletAddress, authCode);
    if (!result.ok) {
      sendAccountError(res, result.reason);
      return;
    }
    if (!('view' in result)) return sendAccountError(res, 'internal');
    sendJson(res, 200, { ok: true, account: result.view });
  }

  /** Begin a secure Google sign-in, returning a fresh state + nonce challenge. */
  async function routeAccountGoogleBegin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const result = accountService.googleBegin(auth.walletAddress);
    if (!result.ok) {
      sendAccountError(res, result.reason);
      return;
    }
    // The nonce is returned to the in-app client (never placed in a URL);
    // the state is meant to be passed through the OAuth callback.
    sendJson(res, 200, { ok: true, state: result.state, nonce: result.nonce, authUrl: result.authUrl });
  }

  /**
   * Authoritative account-existence + registration-state check. Reveals
   * nothing but { exists, registration } — never PII.
   */
  function routeAccountExists(res: http.ServerResponse, body: JsonBody): void {
    const walletAddress = str(body, 'walletAddress');
    if (!/^0x[a-fA-F0-9]{64}$/.test(walletAddress)) {
      sendJson(res, 400, { ok: false, reason: 'invalid-input' });
      return;
    }
    const exists = accountService.hasAccount(walletAddress);
    const registration = accountService.registrationState(walletAddress);
    const login = accountService.loginState(walletAddress);
    sendJson(res, 200, { ok: true, exists, registration, login });
  }

  /**
   * Server-authoritative login-state endpoint (Level 3 Part 5). Returns the
   * safe login factor snapshot { ok, exists, login }. An unknown wallet yields
   * exists:false with a null login — no account is ever created here and no
   * session is minted. Never returns password, OTP, token, or PII.
   */
  function routeAccountLoginState(
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const walletAddress = str(body, 'walletAddress');
    if (!/^0x[a-fA-F0-9]{64}$/.test(walletAddress)) {
      sendJson(res, 400, { ok: false, reason: 'invalid-input' });
      return;
    }
    const exists = accountService.hasAccount(walletAddress);
    const login = accountService.loginState(walletAddress);
    sendJson(res, 200, { ok: true, exists, login });
  }

  /**
   * Server-authoritative LOGIN FACE-VERIFICATION stage endpoint (Level 3
   * Part 6). Returns the honest, FAIL-CLOSED identity-stage snapshot
   * { ok, faceVerification }: `required` is always true (it is a mandatory
   * subsequent identity step), while `providerAvailable` and
   * `hasReferenceIdentity` are false in this build because no real CV provider
   * and no registered biometric reference exist. It NEVER accepts or records a
   * self-affirmed client "matched" boolean, so no fabricated face match can
   * ever be used to mint a session.
   */
  function routeAccountFaceVerification(
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const walletAddress = str(body, 'walletAddress');
    if (!/^0x[a-fA-F0-9]{64}$/.test(walletAddress)) {
      sendJson(res, 400, { ok: false, reason: 'invalid-input' });
      return;
    }
    const faceVerification = accountService.faceVerificationState(walletAddress);
    if (!faceVerification) {
      sendJson(res, 404, { ok: false, reason: 'not-found' });
      return;
    }
    sendJson(res, 200, { ok: true, faceVerification });
  }

  async function routeAccountIdentity(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const confirmed = body.confirmed === true;
    const result = accountService.markIdentityVerified(auth.walletAddress, confirmed);
    if (!result.ok) {
      sendAccountError(res, result.reason);
      return;
    }
    if (!('view' in result)) return sendAccountError(res, 'internal');
    sendJson(res, 200, { ok: true, account: result.view });
  }

  async function routeAccountLogin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    // Rate limit: max 5 login attempts per IP per hour.
    const limit = accountLoginLimiter.take(`ip:${clientIp(req)}`);
    if (!limit.allowed) {
      sendJson(res, 429, {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: limit.retryAfterMs,
        message: 'Too many login attempts. Try again later.',
      });
      return;
    }
    const walletAddress = str(body, 'walletAddress');
    const password = str(body, 'password');
    const result = accountService.login({ walletAddress, password });
    if (!result.ok) {
      sendAccountError(res, result.reason);
      return;
    }
    if (!('session' in result)) return sendAccountError(res, 'internal');
    // Create a server-side session and set the HttpOnly cookie.
    const { cookieHeader } = sessionService.create(result.session.accountId, walletAddress);
    res.setHeader('Set-Cookie', cookieHeader);
    sendJson(res, 200, { ok: true, session: result.session });
  }

  /** Return the current authenticated account (requires a valid session). */
  function routeAccountMe(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const record = persistentAccountStore.getByWallet(auth.walletAddress);
    if (!record) {
      sendJson(res, 404, { ok: false, reason: 'not-found' });
      return;
    }
    sendJson(res, 200, { ok: true, account: { accountId: record.accountId, walletAddress: record.walletAddress } });
  }

  /** End the current session (logout). */
  function routeAccountLogout(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const token = parseSessionCookie(req);
    if (token) sessionService.destroy(token);
    res.setHeader('Set-Cookie', SessionService.clearCookieHeader(config.account?.sessionSecure ?? true));
    sendJson(res, 200, { ok: true });
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

  // ── Registry metadata routes (server-side officer boundary) ────────────

  function sendRegistryError(
    res: http.ServerResponse,
    reason: string,
  ): void {
    switch (reason) {
      case 'unavailable':
        sendJson(res, 503, {
          ok: false,
          reason: 'unavailable',
          message: 'Registry API unavailable.',
        });
        return;
      case 'unauthorized':
        sendJson(res, 401, {
          ok: false,
          reason: 'unauthorized',
          message: 'Officer authorization required.',
        });
        return;
      case 'invalid-input':
        sendJson(res, 400, { ok: false, reason: 'invalid-input' });
        return;
      case 'forbidden-field':
        sendJson(res, 400, { ok: false, reason: 'forbidden-field' });
        return;
      case 'not-found':
        sendJson(res, 404, { ok: false, reason: 'not-found' });
        return;
      default:
        sendJson(res, 500, { ok: false, reason: 'internal' });
    }
  }

  async function routeRegistryCreate(
    res: http.ServerResponse,
    token: string,
    body: JsonBody,
  ): Promise<void> {
    const result = registryService.ingest(token, body);
    if (!result.ok) {
      sendRegistryError(res, result.reason);
      return;
    }
    if (!('item' in result)) return sendRegistryError(res, 'internal');
    sendJson(res, 201, { ok: true, application: result.item });
  }

  /**
   * Applicant endpoint: persist safe public metadata referencing a real
   * on-chain registration. No officer credential is required or used — this is
   * NOT the officer boundary. Validation is identical and strict, on-chain
   * status remains authoritative, and the response never carries a verdict or
   * the property VALUE.
   */
  async function routeRegistryApplicantCreate(
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const result = registryService.ingestApplicant(body);
    if (!result.ok) {
      sendRegistryError(res, result.reason);
      return;
    }
    if (!('item' in result)) return sendRegistryError(res, 'internal');
    sendJson(res, 201, { ok: true, application: result.item });
  }

  function routeRegistryList(res: http.ServerResponse, token: string): void {
    const result = registryService.list(token);
    if (!result.ok) {
      sendRegistryError(res, result.reason);
      return;
    }
    if (!('items' in result)) return sendRegistryError(res, 'internal');
    sendJson(res, 200, { ok: true, applications: result.items });
  }

  function routeRegistryGet(res: http.ServerResponse, token: string, id: string): void {
    const result = registryService.get(token, id);
    if (!result.ok) {
      sendRegistryError(res, result.reason);
      return;
    }
    if (!('item' in result)) return sendRegistryError(res, 'internal');
    sendJson(res, 200, { ok: true, application: result.item });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    });
  });

  return {
    server,
    port: config.port,
    sessions: sessionService,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          // Close the persistent SQLite connection (no-op for in-memory seams).
          try {
            if (persistentAccountStore instanceof SqliteAccountStore) {
              persistentAccountStore.close();
            } else if (overrides.db) {
              overrides.db.close();
            }
          } catch {
            /* ignore close errors */
          }
          resolve();
        });
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
