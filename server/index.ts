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
import { resolveClientIp } from './lib/client-ip';
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
import {
  OFFICER_SESSION_COOKIE_NAME,
  OfficerService,
  SqliteOfficerStore,
  type OfficerStore,
  type PublicOfficerView,
} from './account/officer';
import type { IdentityEvidence } from './account/model';
import type { FaceEmbedding } from './account/biometric';
import { createSmsProviderFromConfig, type SmsProvider } from './account/sms-provider';
import { createWhatsAppProviderFromConfig, type WhatsAppProvider } from './account/whatsapp-provider';
import {
  createGoogleProviderFromConfig,
  GOOGLE_STATE_TTL_MS,
  type GoogleProviderDomain,
  type GoogleProviderObject,
} from './account/google-provider';
import {
  OAuthHttp,
  GoogleUserInfoHttp,
} from './lib/oauth-http';
import type { TokenVerifier } from './lib/id-token-verifier';
import { createOidcVerifier } from './lib/identity-provider-oidc';
import { OAuthStateSession } from './lib/oauth-state';
import { parseMultipart } from './lib/multipart';
import { RegistrationService, type RegistrationResult } from './registration/service';
import {
  SqliteRegistrationSessionStore,
  SqliteForgotPasswordSessionStore,
  type RegistrationSessionStore,
  type ForgotPasswordSessionStore,
} from './registration/session-store';
import { ForgotPasswordService, type ForgotPasswordResult } from './registration/forgot-password';
import { InMemoryLivenessService, type LivenessService } from './registration/liveness';
import { createPincodeProviderFromConfig, type PincodeProvider } from './services/pincode-provider';
import { NominatimReverseGeocoder, type GeocodingProvider } from './services/geocoding-provider';
import { createDisposableEmailChecker, type DisposableEmailChecker } from './services/disposable-email';
import { SurepassAadhaarOcrProvider, type AadhaarOcrProvider } from './services/aadhaar-ocr-provider';

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
  /** Test seam: SEPARATE biometric-reference encryption secret (fail closed without it). */
  readonly accountBiometricEncryptionSecret?: string;
  /** Test seam: SMS OTP delivery transport (capture real codes in tests). */
  readonly accountSmsDelivery?: { configured: boolean; send: (to: string, code: string) => void };
  /** Test seam: WhatsApp OTP delivery transport. */
  readonly accountWhatsappDelivery?: { configured: boolean; send: (to: string, code: string) => void };
  /**
   * Test seam: replace the SmsProvider (instead of the legacy synchronous
   * `accountSmsDelivery`). Useful to inject a real async HTTP transport.
   */
  readonly accountSmsProvider?: SmsProvider;
  /**
   * Test seam: replace the WhatsAppProvider (instead of the legacy synchronous
   * `accountWhatsappDelivery`).
   */
  readonly accountWhatsAppProvider?: WhatsAppProvider;
  /**
   * Test seam: replace the GoogleProvider (carries the state+nonce challenge
   * and a real or double ID-token exchange).
   */
  readonly accountGoogleProvider?: GoogleProviderObject;
  /**
   * Test seam: replace the OIDC token verifier used for ID-token checks. When
   * absent the provider builds one from config (fail-closed if unconfigured).
   */
  readonly oidcTokenVerifier?: TokenVerifier;
  /**
   * Test seam: override the OAuth HTTP client (fetch/exchange/redirect/JWKS).
   */
  readonly oauthHttp?: OAuthHttp;
  /** Test seam: override the userinfo fetcher (cross-checks ID-token `sub`). */
  readonly googleUserInfo?: GoogleUserInfoHttp;
  /**
   * Test seam: override the Google provider's derived capabilities/URLs.
   */
  readonly googleDomain?: Partial<GoogleProviderDomain>;
  /** Test seam: pre-built OAuth state session store (challenge book). */
  readonly oauthStateStore?: OAuthStateSession;
  /** Test seam: provide a pre-built SessionService. */
  readonly sessionService?: SessionService;
  /** Test seam: SQLite database handle (skips openDatabase when set). */
  readonly db?: import('better-sqlite3').Database;
  /** Test seam: replace the officer-credential persistence backend. */
  readonly officerStore?: OfficerStore;
  /** Test seam: override the one-time officer commissioning code (empty ⇒ unavailable). */
  readonly officerRegistrationCode?: string;
  /** Test seam: provide a pre-built OfficerService. */
  readonly officerService?: OfficerService;
  /** Test seam: registration-stack store (session persistence). */
  readonly registrationStore?: RegistrationSessionStore;
  /** Test seam: forgot-password session store. */
  readonly forgotPasswordStore?: ForgotPasswordSessionStore;
  /** Test seam: pre-built RegistrationService (skips provider wiring in tests). */
  readonly registrationService?: RegistrationService;
  /** Test seam: pre-built ForgotPasswordService. */
  readonly forgotPasswordService?: ForgotPasswordService;
  /** Test seam: Aadhaar document OCR adapter (vs. the config-built Surepass one). */
  readonly registrationAadhaarOcrProvider?: AadhaarOcrProvider;
  /** Test seam: disposable-email checker. */
  readonly registrationDisposableEmailChecker?: DisposableEmailChecker;
  /** Test seam: liveness challenge engine (deterministic in tests). */
  readonly registrationLiveness?: LivenessService;
}

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

  // The OTP hash secret is a HARD security dependency: without it, every OTP
  // feature must not start at all (fail closed), never fall back to a baked-in
  // development secret. Production must set OTP_HASH_SECRET.
  if (!config.otp.hashSecret || config.otp.hashSecret.length < 16) {
    throw new Error(
      'OTP_HASH_SECRET must be configured (at least 16 characters). ' +
        'Refusing to start the verification server with an insecure fallback.',
    );
  }
  const otpHashSecret = config.otp.hashSecret;

  const mailer: Mailer | null = overrides.mailer ?? createSmtpMailer(config);
  const otpService = new OtpService({
    hashSecret: otpHashSecret,
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
      sameSite: config.account?.sessionSameSite,
    });

  // ── Server-backed officer credential (single commissioned officer) ────
  // A SEPARATE `priestate_officer_sid` HttpOnly cookie keeps the officer
  // identity distinct from any citizen session on the same browser. Sessions
  // live in the `officer_sessions` table on the SAME database handle. When no
  // commissioning code is configured, registration reports `unavailable` and
  // login simply has no officer to match (fail closed — never faked).
  const officerService: OfficerService =
    overrides.officerService ??
    new OfficerService({
      store: overrides.officerStore ?? new SqliteOfficerStore(db),
      registrationCode:
        overrides.officerRegistrationCode !== undefined
          ? overrides.officerRegistrationCode
          : config.officer?.registrationCode ?? '',
      sessionSecure: config.account?.sessionSecure ?? true,
      sessionSameSite: config.account?.sessionSameSite,
      sessionTtlMs: config.account?.sessionTtlMs,
      db,
    });

  // ── Real OAuth / delivery provider wiring (J.4) ─────────────────

  // SMS / WhatsApp: REAL HTTP transport adapters that fail closed when no
  // gateway is configured. Tests inject deterministic local doubles at the
  // provider boundary; the adapters themselves never fake delivery.
  const smsProvider: SmsProvider =
    overrides.accountSmsProvider ?? createSmsProviderFromConfig(config.account);
  const whatsAppProvider: WhatsAppProvider =
    overrides.accountWhatsAppProvider ?? createWhatsAppProviderFromConfig(config.account);

  // Google: a REAL OAuth2 authorization-code provider with server-side
  // state+nonce, ID-token JWKS verification, and a redirect callback. When no
  // client id/secret are configured it reports `configured:false` and every
  // begin/complete step fails closed — we never invent a Google login.
  const oauthHttp: OAuthHttp =
    overrides.oauthHttp ?? new OAuthHttp(config.account?.googleOauth?.timeoutMs);
  const tokenVerifier: TokenVerifier | null =
    overrides.oidcTokenVerifier ??
    createOidcVerifier(
      config.account?.googleOauth
        ? {
            enabled: config.account.googleOauth.enabled,
            issuer: config.account.googleOauth.issuer ?? 'https://accounts.google.com',
            audience: config.account.googleOauth.clientId ?? '',
            jwksUri: config.account.googleOauth.jwksUri ?? 'https://www.googleapis.com/oauth2/v3/certs',
          }
        : undefined,
    );
  const googleUserInfo: GoogleUserInfoHttp = overrides.googleUserInfo ?? new GoogleUserInfoHttp();
  const googleDomain: GoogleProviderDomain = {
    enabled: overrides.googleDomain?.enabled ?? config.account?.googleOauth?.enabled,
    clientId: overrides.googleDomain?.clientId ?? config.account?.googleOauth?.clientId ?? '',
    clientSecret:
      overrides.googleDomain?.clientSecret ?? config.account?.googleOauth?.clientSecret ?? '',
    oauthAuthorizeEndpoint:
      overrides.googleDomain?.oauthAuthorizeEndpoint ??
      config.account?.googleOauth?.oauthAuthorizeEndpoint ?? '',
    oauthTokenEndpoint:
      overrides.googleDomain?.oauthTokenEndpoint ??
      config.account?.googleOauth?.oauthTokenEndpoint ?? '',
    oauthUserinfoEndpoint:
      overrides.googleDomain?.oauthUserinfoEndpoint ??
      config.account?.googleOauth?.oauthUserinfoEndpoint ?? '',
    redirectUri:
      overrides.googleDomain?.redirectUri ?? config.account?.googleOauth?.redirectUri ?? '',
    jwksUri: overrides.googleDomain?.jwksUri ?? config.account?.googleOauth?.jwksUri ?? '',
    issuer: overrides.googleDomain?.issuer ?? config.account?.googleOauth?.issuer ?? '',
    stateTtlMs: overrides.googleDomain?.stateTtlMs ?? config.account?.googleOauth?.stateTtlMs,
  };
  const googleStateStore: OAuthStateSession =
    overrides.oauthStateStore ??
    new OAuthStateSession({ now: () => Date.now(), ttlMs: googleDomain.stateTtlMs ?? GOOGLE_STATE_TTL_MS });
  const googleProvider: GoogleProviderObject = overrides.accountGoogleProvider ??
    createGoogleProviderFromConfig({
      domain: googleDomain,
      stateStore: googleStateStore,
      oauthHttp,
      tokenVerifier,
      googleUserInfoHttp: googleUserInfo,
    });

  const accountService = new AccountService({
    store: persistentAccountStore,
encryptionSecret: overrides.accountEncryptionSecret ?? config.account?.encryptionSecret ?? '',
      biometricEncryptionSecret:
        overrides.accountBiometricEncryptionSecret ?? config.account?.biometricEncryptionSecret ?? '',
      otp: { hashSecret: otpHashSecret },
    smsProvider,
    whatsAppProvider,
    googleProvider,
  });

  // ── Registration + forgot-password stacks (Part 1) ──────────────
  // Real providers only: missing credentials ⇒ the affected step reports
  // `unavailable` and FAILS CLOSED — nothing is ever faked.
  const registrationStore: RegistrationSessionStore =
    overrides.registrationStore ?? new SqliteRegistrationSessionStore(db);
  const forgotPasswordStore: ForgotPasswordSessionStore =
    overrides.forgotPasswordStore ?? new SqliteForgotPasswordSessionStore(db);

  const registrationAadhaarOcr: AadhaarOcrProvider =
    overrides.registrationAadhaarOcrProvider ??
    new SurepassAadhaarOcrProvider(
      config.registration?.aadhaarOcr ?? { providerName: '', apiToken: '', baseUrl: '', ocrPath: '', timeoutMs: 20000 },
    );
  const registrationPincode: PincodeProvider = createPincodeProviderFromConfig(
    config.registration?.pincode ?? {},
  );
  const registrationGeocoding: GeocodingProvider = new NominatimReverseGeocoder(
    config.registration?.geocoding ?? {},
  );
  const registrationDisposableEmail: DisposableEmailChecker =
    overrides.registrationDisposableEmailChecker ??
    createDisposableEmailChecker(config.registration?.disposableEmailExtraDomains ?? '');
  const registrationLiveness: LivenessService =
    overrides.registrationLiveness ??
    new InMemoryLivenessService({ now: () => Date.now() });

  const registrationService: RegistrationService =
    overrides.registrationService ??
    new RegistrationService({
      store: registrationStore,
      accounts: accountService,
      mailer,
      otp: { hashSecret: otpHashSecret },
      smsProvider,
      whatsAppProvider,
      aadhaarProvider,
      aadhaarOcr: registrationAadhaarOcr,
      pincodeProvider: registrationPincode,
      geocodingProvider: registrationGeocoding,
      disposableEmail: registrationDisposableEmail,
      liveness: registrationLiveness,
      photoConfig: { maxBytes: config.registration?.photoMaxBytes },
      sessionTtlMs: config.registration?.sessionTtlMs,
    });

  const forgotPasswordService: ForgotPasswordService =
    overrides.forgotPasswordService ??
    new ForgotPasswordService({
      store: forgotPasswordStore,
      accounts: accountService,
      mailer,
      otp: { hashSecret: otpHashSecret },
      liveness: registrationLiveness,
      disposableEmail: registrationDisposableEmail,
      sessionTtlMs: config.registration?.sessionTtlMs,
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
  const officerAuthLimiter = new RateLimiter({ maxEvents: 5, windowMs: 60 * 60 * 1000 });
  const registrationBeginLimiter = new RateLimiter({ maxEvents: 5, windowMs: 60 * 60 * 1000 });
  const forgotPasswordBeginLimiter = new RateLimiter({ maxEvents: 5, windowMs: 60 * 60 * 1000 });

  // ── Registration cookie (HttpOnly, SameSite) ────────────────────
  const REGISTRATION_COOKIE = 'priestate_reg_sid';
  const registrationSessionMaxAgeSec = Math.floor((config.registration?.sessionTtlMs ?? 2 * 60 * 60 * 1000) / 1000);
  const registrationSecure = config.account?.sessionSecure ?? true;
  const registrationSameSite = config.account?.sessionSameSite ?? 'Lax';

  function parseRegistrationCookie(req: http.IncomingMessage): string | null {
    const cookieHeader = req.headers.cookie ?? '';
    const match = new RegExp(`(?:^|;\\s*)${REGISTRATION_COOKIE}=([^;]+)`).exec(cookieHeader);
    return match ? match[1] : null;
  }

  function setRegistrationCookie(token: string): string {
    return `${REGISTRATION_COOKIE}=${token}; Path=/; HttpOnly; Max-Age=${registrationSessionMaxAgeSec}${registrationSecure ? '; Secure' : ''}; SameSite=${registrationSameSite}`;
  }

  function clearRegistrationCookie(): string {
    return `${REGISTRATION_COOKIE}=; Path=/; Max-Age=0; HttpOnly`;
  }

  /**
   * Read a fixed-size raw body (for multipart uploads) into a single Buffer.
   * Returns null when the body exceeds `maxBytes` or is empty.
   */
  function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { resolve(null); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(chunks.length === 0 ? null : Buffer.concat(chunks)));
      req.on('error', () => resolve(null));
    });
  }

  // ── HTTP plumbing ──────────────────────────────────────────────────

  // A generous per-request JSON body limit. Larger than historical 8 KB
  // because the biometric enrollment payload carries ~512 real face-embedding
  // floats (~9–10 KB). The strict security invariants (no PII on chain, etc.)
  // are unaffected; requests still fail closed when oversized.
  const MAX_BODY_BYTES = 128 * 1024;

  interface JsonBody {
    [key: string]: unknown;
  }

  function readJson(req: http.IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<JsonBody | null> {
    return new Promise((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
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

  /**
   * CORS for the Vercel frontend origin. Credentials (the `priestate_sid`
   * cookie) are ONLY echoed to an explicitly allow-listed origin — never to
   * an arbitrary Origin and never with `Access-Control-Allow-Origin: *`
   * (which the browser forbids alongside credentials anyway). Cross-site
   * cookie traffic therefore requires the matching SameSite=None+Secure
   * session cookie, issued by the API over HTTPS.
   */
  function corsHeaders(): Record<string, string> {
    if (requestOrigin && config.allowedOrigins.includes(requestOrigin)) {
      return {
        'Access-Control-Allow-Origin': requestOrigin,
        'Access-Control-Allow-Credentials': 'true',
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
    const forwardedFor = req.headers['x-forwarded-for'];
    return resolveClientIp(
      {
        socketAddress: req.socket.remoteAddress ?? 'unknown',
        forwardedFor:
          typeof forwardedFor === 'string'
            ? forwardedFor
            : Array.isArray(forwardedFor)
              ? forwardedFor
              : undefined,
      },
      config.trustProxy === true,
    );
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

  /** Parse the SEPARATE officer session cookie (`priestate_officer_sid`). */
  function parseOfficerCookie(req: http.IncomingMessage): string | null {
    const cookieHeader = req.headers.cookie ?? '';
    const match = new RegExp(`(?:^|;\\s*)${OFFICER_SESSION_COOKIE_NAME}=([^;]+)`).exec(cookieHeader);
    return match ? match[1] : null;
  }

  /**
   * Validate the session cookie. Returns `{ accountId, walletAddress }` if
   * valid, otherwise sends a 401 response and returns null.
   */
  function requireAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): { accountId: string; walletAddress: string | null } | null {
    const token = parseSessionCookie(req);
    if (!token) {
      sendJson(res, 401, { ok: false, reason: 'unauthorized', message: 'Login required.' });
      return null;
    }
    const session = sessionService.get(token);
    if (!session) {
      res.setHeader(
        'Set-Cookie',
        SessionService.clearCookieHeader(
          config.account?.sessionSecure ?? true,
          config.account?.sessionSameSite,
        ),
      );
      sendJson(res, 401, { ok: false, reason: 'session-expired', message: 'Session expired. Please log in again.' });
      return null;
    }
    return { accountId: session.accountId, walletAddress: session.walletAddress };
  }

  /**
   * Some authenticated routes are ONLY meaningful once the account has a real
   * Midnight wallet. Accounts created wallet-free keep a null-wallet session
   * until the wallet-association step, so this guard rejects them cleanly.
   */
  function requireWallet(
    auth: { accountId: string; walletAddress: string | null },
    res: http.ServerResponse,
  ): string | null {
    if (!auth.walletAddress) {
      sendJson(res, 403, {
        ok: false,
        reason: 'bad-state',
        message: 'Associate a Midnight wallet with your account first.',
      });
      return null;
    }
    return auth.walletAddress;
  }

  /**
   * Validate the OFFICER session cookie. Returns the public officer view if
   * valid, otherwise sends a 401 response and returns null.
   */
  function requireOfficerAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): PublicOfficerView | null {
    const token = parseOfficerCookie(req);
    if (!token) {
      sendJson(res, 401, { ok: false, reason: 'unauthorized', message: 'Officer login required.' });
      return null;
    }
    const officer = officerService.getBySessionToken(token);
    if (!officer) {
      res.setHeader('Set-Cookie', officerService.clearCookieHeader());
      sendJson(res, 401, { ok: false, reason: 'session-expired', message: 'Officer session expired. Please log in again.' });
      return null;
    }
    return officer;
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
          registration: {
            ...registrationService.capabilities,
            passwordRecoveryConfigured: forgotPasswordService.emailConfigured,
          },
          account: {
            smsOtp: accountService.smsConfigured,
            whatsappOtp: accountService.whatsappConfigured,
            google: accountService.googleConfigured,
          },
          officer: {
            registration: officerService.capabilities().registrationAvailable,
            login: officerService.capabilities().loginAvailable,
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

    // ── Registration (Part 1) — capabilities + resume ─────────────
    if (req.method === 'GET' && url === '/api/v1/registration/capabilities') {
      sendJson(res, 200, {
        ok: true,
        capabilities: {
          ...registrationService.capabilities,
          passwordRecoveryConfigured: forgotPasswordService.emailConfigured,
        },
      });
      return;
    }
    if (req.method === 'GET' && url === '/api/v1/registration/status') {
      const token = parseRegistrationCookie(req);
      if (!token) {
        sendJson(res, 200, { ok: true, session: null });
        return;
      }
      const status = registrationService.status(token);
      if (!status) {
        res.setHeader('Set-Cookie', clearRegistrationCookie());
        sendJson(res, 200, { ok: true, session: null });
        return;
      }
      sendJson(res, 200, { ok: true, session: status });
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

    // ── Server-backed officer credential routes (single commissioned officer) ──
    if (req.method === 'GET' && url === '/api/v1/officer/auth/capabilities') {
      sendJson(res, 200, { ok: true, capabilities: officerService.capabilities() });
      return;
    }
    if (req.method === 'GET' && url === '/api/v1/officer/auth/me') {
      routeOfficerMe(req, res);
      return;
    }
    if (url === '/api/v1/officer/auth/logout' && (req.method === 'GET' || req.method === 'POST')) {
      routeOfficerLogout(req, res);
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

    if (url === '/api/v1/account/google/callback' && req.method === 'GET') {
      return void (await routeAccountGoogleCallback(req, res));
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    // Multipart uploads (registration) are handled BEFORE the JSON body read.
    if (url === '/api/v1/registration/aadhaar-document') {
      return void (await routeRegistrationAadhaarDocument(req, res));
    }
    if (url === '/api/v1/registration/photo') {
      return void (await routeRegistrationPhoto(req, res));
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
      case '/api/v1/account/identity-evidence':
        return void (await routeIdentityEvidence(req, res, body));
      case '/api/v1/account/biometric/enrollment/begin':
        return void (await routeBiometricEnrollmentBegin(req, res));
      case '/api/v1/account/biometric/enrollment/complete':
        return void (await routeBiometricEnrollmentComplete(req, res, body));
      case '/api/v1/account/biometric/revoke':
        return void (await routeBiometricRevoke(req, res));
      case '/api/v1/account/biometric/verification/begin':
        return void (await routeBiometricVerificationBegin(res, body));
      case '/api/v1/account/biometric/verification/complete':
        return void (await routeBiometricVerificationComplete(req, res, body));
      case '/api/v1/account/login':
        return void (await routeAccountLogin(req, res, body));
      case '/api/v1/account/wallet/associate':
        return void (await routeAccountAssociateWallet(req, res, body));
      case '/api/v1/officer/auth/register':
        return void (await routeOfficerRegister(req, res, body));
      case '/api/v1/officer/auth/login':
        return void (await routeOfficerLogin(req, res, body));
      // ── Registration stepper (Part 1) ─────────────────────────────
      case '/api/v1/registration/begin':
        return void (await routeRegistrationBegin(req, res));
      case '/api/v1/registration/personal':
        return void (await routeRegistrationPersonal(req, res, body));
      case '/api/v1/registration/email':
        return void (await routeRegistrationEmail(req, res, body));
      case '/api/v1/registration/email/verify':
        return void (await routeRegistrationEmailVerify(req, res, body));
      case '/api/v1/registration/sms/issue':
        return void (await routeRegistrationSmsIssue(req, res));
      case '/api/v1/registration/sms/verify':
        return void (await routeRegistrationSmsVerify(req, res, body));
      case '/api/v1/registration/whatsapp/issue':
        return void (await routeRegistrationWhatsappIssue(req, res));
      case '/api/v1/registration/whatsapp/verify':
        return void (await routeRegistrationWhatsappVerify(req, res, body));
      case '/api/v1/registration/aadhaar-mobile/start':
        return void (await routeRegistrationAadhaarMobileStart(req, res));
      case '/api/v1/registration/aadhaar-mobile/complete':
        return void (await routeRegistrationAadhaarMobileComplete(req, res, body));
      case '/api/v1/registration/password':
        return void routeRegistrationPassword(req, res, body);
      case '/api/v1/registration/liveness/start':
        return void routeRegistrationLivenessStart(req, res);
      case '/api/v1/registration/liveness/evidence':
        return void routeRegistrationLivenessEvidence(req, res, body);
      case '/api/v1/registration/location':
        return void (await routeRegistrationLocation(req, res, body));
      case '/api/v1/registration/finalize':
        return void routeRegistrationFinalize(req, res);
      // ── Forgot-password (Part 1) ──────────────────────────────────
      case '/api/v1/account/forgot-password/begin':
        return void (await routeForgotPasswordBegin(req, res, body));
      case '/api/v1/account/forgot-password/email/verify':
        return void routeForgotPasswordEmailVerify(res, body);
      case '/api/v1/account/forgot-password/liveness/start':
        return void routeForgotPasswordLivenessStart(res, body);
      case '/api/v1/account/forgot-password/liveness/evidence':
        return void routeForgotPasswordLivenessEvidence(res, body);
      case '/api/v1/account/forgot-password/biometric/start':
        return void routeForgotPasswordBiometricStart(res, body);
      case '/api/v1/account/forgot-password/biometric/verify':
        return void routeForgotPasswordBiometricVerify(res, body);
      case '/api/v1/account/forgot-password/reset':
        return void routeForgotPasswordReset(res, body);
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
      case 'delivery-failed':
        sendJson(res, 503, {
          ok: false,
          reason: 'delivery-failed',
          message: 'The code could not be delivered to your device. Try again shortly.',
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
      case 'identity-evidence-rejected':
        sendJson(res, 422, {
          ok: false,
          reason: 'identity-evidence-rejected',
          message: 'Registration identity evidence was incomplete, stale, or invalid. A bare "verified" flag is never accepted.',
        });
        return;
      case 'no-consent':
        sendJson(res, 400, { ok: false, reason: 'no-consent', message: 'Biometric consent was not recorded.' });
        return;
      case 'session-invalid':
        sendJson(res, 401, { ok: false, reason: 'session-invalid', message: 'That one-time code/credential was missing, reused, expired, or bound to a different wallet.' });
        return;
      case 'low-quality':
        sendJson(res, 422, { ok: false, reason: 'low-quality', message: 'The captured embeddings were insufficient to derive a usable reference.' });
        return;
      case 'no-reference':
        sendJson(res, 409, { ok: false, reason: 'no-reference', message: 'No enrolled biometric reference exists for login verification.' });
        return;
      case 'revoked':
        sendJson(res, 409, { ok: false, reason: 'revoked', message: 'The biometric reference for this account has been revoked.' });
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
    const wallet = requireWallet(auth, res);
    if (!wallet) return;
    const result = await accountService.issueSmsOtp(wallet);
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
    const wallet = requireWallet(auth, res);
    if (!wallet) return;
    const result = accountService.verifySmsOtp(wallet, code);
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
    const wallet = requireWallet(auth, res);
    if (!wallet) return;
    const result = await accountService.issueWhatsappOtp(wallet);
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
    const wallet = requireWallet(auth, res);
    if (!wallet) return;
    const result = accountService.verifyWhatsappOtp(wallet, code);
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
    const state = str(body, 'state');
    const nonce = str(body, 'nonce');
    if (!state || !nonce) {
      sendJson(res, 400, { ok: false, reason: 'bad-state', message: 'Google sign-in state + nonce are required.' });
      return;
    }
    const wallet = requireWallet(auth, res);
    if (!wallet) return;
    const result = accountService.googleComplete(wallet, { state, nonce });
    if (result.ok && 'view' in result) {
      sendJson(res, 200, { ok: true, account: result.view });
      return;
    }
    sendAccountError(res, result.ok ? 'internal' : result.reason);
  }

  /**
   * GET /api/v1/account/google/callback — the OAuth2 authorization redirect
   * from the identity provider (a POPUP/top-level navigation, deliberately NOT
   * behind the session cookie). Looks the challenge up by `state`, exchanges
   * the code over HTTPS, cryptographically verifies the ID token and the
   * userinfo profile server-side, then redirects the browser to a neutral
   * completion page. The raw code/token/state are never logged.
   */
  async function routeAccountGoogleCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const query = new URL(req.url ?? '', 'http://localhost');
    const params = {
      state: query.searchParams.get('state') ?? '',
      code: query.searchParams.get('code') ?? undefined,
      error: query.searchParams.get('error') ?? undefined,
    };
    if (!params.state) {
      sendJson(res, 400, { ok: false, reason: 'bad-state' });
      return;
    }
    const result = await accountService.googleOAuthRedirect(params);
    if (!result.ok) {
      sendJson(res, 400, { ok: false, reason: result.reason, message: 'Google sign-in did not complete.' });
      return;
    }
    // The exchange + verification succeeded. Redirect the popup to the
    // configured allowed origin with an opaque non-secret status query.
    const target = config.allowedOrigins[0] ?? 'http://localhost:3000';
    const redirect = new URL(target);
    redirect.searchParams.set('google', 'pending');
    res.writeHead(302, {
      Location: redirect.toString(),
      'Cache-Control': 'no-store',
    });
    res.end();
  }

  /** Begin a secure Google sign-in, returning a fresh state + nonce challenge. */
  async function routeAccountGoogleBegin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const wallet = requireWallet(auth, res);
    if (!wallet) return;
    const result = accountService.googleBegin(wallet);
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

  /**
   * POST /api/v1/account/biometric/enrollment/begin
   *
   * ⚠️ SECURITY FIX (Part 8): the old `/api/v1/account/identity-verified` route
   * accepted a bare `confirmed:true` from the browser and set `identityVerified`
   * with NO server-computed evidence. That self-assertion path is REMOVED.
   *
   * This is the only way to begin identity-verification setup now: it issues a
   * single-use, short-TTL, wallet-bound ENROLLMENT token. The server never sets
   * `identityVerified` here.
   */
  function routeBiometricEnrollmentBegin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const wallet = requireWallet(auth, res);
    if (!wallet) return;
    const result = accountService.beginBiometricEnrollment(wallet);
    if (!result.ok) return sendAccountError(res, result.reason);
    sendJson(res, 200, result);
  }

  /**
   * POST /api/v1/account/biometric/enrollment/complete
   *
   * The server consumes the enrollment token, derives + encrypts the reference,
   * and — as the ONLY path — sets `identityVerified=true`. It never trusts a
   * client `matched`/`score`/`isHuman`/`confirmed`.
   */
  function routeBiometricEnrollmentComplete(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const wallet = requireWallet(auth, res);
    if (!wallet) return;
    const token = str(body, 'token');
    const consent = body?.consent === true;
    const embeddings = body?.embeddings;
    if (!Array.isArray(embeddings)) return sendAccountError(res, 'invalid-input');
    let result: ReturnType<AccountService['enrollBiometricReference']>;
    try {
      result = accountService.enrollBiometricReference(wallet, {
        token,
        embeddings: embeddings as readonly FaceEmbedding[],
        consent,
      });
    } catch (e) {
      console.error('ENROLL_ROUTE_ERR', (e as Error)?.stack ?? String(e));
      throw e;
    }
    if (!result.ok) return sendAccountError(res, result.reason);
    sendJson(res, 200, result);
  }

  /**
   * POST /api/v1/account/biometric/revoke
   *
   * Revoke (and revert identityVerified) so the account must re-enroll.
   */
  function routeBiometricRevoke(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const wallet = requireWallet(auth, res);
    if (!wallet) return;
    const result = accountService.revokeBiometricReference(wallet);
    if (!result.ok) return sendAccountError(res, result.reason);
    sendJson(res, 200, result);
  }

  /**
   * POST /api/v1/account/biometric/verification/begin
   *
   * Issue a single-use, wallet- AND reference-version-bound verification token
   * used for server-authoritative login face matching.
   */
  function routeBiometricVerificationBegin(
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const walletAddress = str(body, 'walletAddress');
    if (!/^0x[a-fA-F0-9]{64}$/.test(walletAddress)) {
      sendJson(res, 400, { ok: false, reason: 'invalid-input' });
      return;
    }
    const result = accountService.beginBiometricVerification(walletAddress);
    if (!result.ok) {
      sendAccountError(res, result.reason);
      return;
    }
    sendJson(res, 200, result);
  }

  /**
   * POST /api/v1/account/biometric/verification/complete
   *
   * Server-authoritative login face match: decrypts the stored reference and
   * compares the live embedding to derive the verdict. Any client-supplied
   * `matched`/`score` is ignored — only `{ ok, verdict, score }` is returned.
   */
  function routeBiometricVerificationComplete(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const wallet = requireWallet(auth, res);
    if (!wallet) return;
    const token = str(body, 'verificationToken');
    const welcomeEmbedding = body?.liveEmbedding;
    if (!Array.isArray(welcomeEmbedding) || welcomeEmbedding.length === 0) {
      sendJson(res, 400, { ok: false, verdict: 'invalid_input' });
      return;
    }
    const result = accountService.verifyBiometricMatch(wallet, {
      verificationToken: token,
      liveEmbedding: welcomeEmbedding as readonly number[],
    });
    sendJson(res, 200, result);
  }

  /**
   * POST /api/v1/account/identity-evidence
   *
   * Additive, server-authoritative boundary for the COMBINED registration
   * identity check (real landmark liveness + live browser location). The server
   * does NOT trust a bare `livenessPassed`/`locationVerified` boolean: it runs
   * the submitted evidence through the pure validator and rejects anything
   * incomplete, stale, coarsely-located, or coordinate-invalid. It never
   * stores or echoes raw coordinates, landmarks, or any biometric value.
   */
  async function routeIdentityEvidence(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const wallet = requireWallet(auth, res);
    if (!wallet) return;
    const result = accountService.recordIdentityEvidence(
      wallet,
      body?.identityEvidence as IdentityEvidence | null | undefined,
    );
    if (!result.ok) {
      sendAccountError(res, result.reason);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      accepted: result.accepted,
      receivedAtMs: result.receivedAtMs,
      message: result.accepted
        ? 'Registration identity evidence accepted (validated server-side).'
        : 'Registration identity evidence refused on the server: a bare "verified" flag is never accepted.',
    });
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
    const record = persistentAccountStore.getById(auth.accountId);
    if (!record) {
      sendJson(res, 404, { ok: false, reason: 'not-found' });
      return;
    }
    sendJson(res, 200, { ok: true, account: { accountId: record.accountId, walletAddress: record.walletAddress } });
  }

  /**
   * Bind the real Midnight wallet to the session's account. Used after a
   * wallet-free registration so the citizen's wallet gates property flows.
   * On success the session cookie is re-minted to carry the wallet.
   */
  async function routeAccountAssociateWallet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const walletAddress = str(body, 'walletAddress');
    if (!/^0x[a-fA-F0-9]{64}$/.test(walletAddress)) {
      sendJson(res, 400, { ok: false, reason: 'invalid-input', issues: ['A valid wallet address is required.'] });
      return;
    }
    const result = accountService.associateWallet(auth.accountId, walletAddress);
    if (!result.ok) {
      const status =
        result.reason === 'not-found' ? 404
        : result.reason === 'invalid-input' ? 400
        : 409;
      sendJson(res, status, { ok: false, reason: result.reason });
      return;
    }
    const current = parseSessionCookie(req);
    if (current) sessionService.destroy(current);
    const { cookieHeader } = sessionService.create(auth.accountId, walletAddress);
    res.setHeader('Set-Cookie', cookieHeader);
    const account = 'view' in result ? result.view : null;
    sendJson(res, 200, { ok: true, account });
  }

  /** End the current session (logout). */
  function routeAccountLogout(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const token = parseSessionCookie(req);
    if (token) sessionService.destroy(token);
    res.setHeader(
      'Set-Cookie',
      SessionService.clearCookieHeader(
        config.account?.sessionSecure ?? true,
        config.account?.sessionSameSite,
      ),
    );
    sendJson(res, 200, { ok: true });
  }

  // ── Server-backed officer credential routes ─────────────────────────

  /**
   * POST /api/v1/officer/auth/register
   *
   * Mint the SINGLE commissioned officer account. Requires the one-time
   * commissioning code (OFFICER_REGISTRATION_CODE) and refuses any further
   * registration once an officer exists. On success it sets the SEPARATE
   * `priestate_officer_sid` HttpOnly cookie. The raw code/password are never
   * echoed back or logged.
   */
  function routeOfficerRegister(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const limit = officerAuthLimiter.take(`ip:${clientIp(req)}`);
    if (!limit.allowed) {
      sendJson(res, 429, {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: limit.retryAfterMs,
        message: 'Too many attempts. Try again later.',
      });
      return;
    }
    const result = officerService.register({
      displayName: str(body, 'displayName'),
      password: str(body, 'password'),
      passwordConfirm: str(body, 'passwordConfirm'),
      registrationCode: str(body, 'registrationCode'),
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'registration-disabled':
          sendJson(res, 503, {
            ok: false,
            reason: 'registration-disabled',
            message: 'Officer registration is not enabled on this deployment (no commissioning code is configured). It was NOT simulated.',
          });
          return;
        case 'code-invalid':
          sendJson(res, 403, { ok: false, reason: 'code-invalid', message: 'The commissioning code is incorrect.' });
          return;
        case 'officer-exists':
          sendJson(res, 409, {
            ok: false,
            reason: 'officer-exists',
            message: 'An officer account already exists. Officer registration is a single, one-time commissioning step.',
          });
          return;
        case 'unavailable':
          sendJson(res, 503, { ok: false, reason: 'unavailable' });
          return;
        default:
          sendJson(res, 400, {
            ok: false,
            reason: 'invalid-input',
            message: 'Invalid officer details: display name 2–80 characters, password at least 10 characters with upper/lowercase, a number and a symbol.',
          });
      }
      return;
    }
    res.setHeader('Set-Cookie', result.cookieHeader);
    sendJson(res, 201, { ok: true, officer: result.view, capabilities: officerService.capabilities() });
  }

  /**
   * POST /api/v1/officer/auth/login
   *
   * Exchange display name + password for the officer session cookie. Fails
   * closed with a uniform 401 (no username oracle). The password is compared
   * against the stored scrypt hash server-side and never returned.
   */
  function routeOfficerLogin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const limit = officerAuthLimiter.take(`ip:${clientIp(req)}`);
    if (!limit.allowed) {
      sendJson(res, 429, {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: limit.retryAfterMs,
        message: 'Too many attempts. Try again later.',
      });
      return;
    }
    const result = officerService.login({
      displayName: str(body, 'displayName'),
      password: str(body, 'password'),
    });
    if (!result.ok) {
      sendJson(res, 401, { ok: false, reason: 'unauthorized', message: 'Invalid officer credentials.' });
      return;
    }
    res.setHeader('Set-Cookie', result.cookieHeader);
    sendJson(res, 200, { ok: true, officer: result.view, capabilities: officerService.capabilities() });
  }

  /** GET /api/v1/officer/auth/me — current server-backed officer (or 401). */
  function routeOfficerMe(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const officer = requireOfficerAuth(req, res);
    if (!officer) return;
    sendJson(res, 200, { ok: true, officer, capabilities: officerService.capabilities() });
  }

  /** POST/GET /api/v1/officer/auth/logout — destroy the officer session. */
  function routeOfficerLogout(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const token = parseOfficerCookie(req);
    if (token) officerService.logout(token);
    res.setHeader('Set-Cookie', officerService.clearCookieHeader());
    sendJson(res, 200, { ok: true });
  }

  // ── Registration stepper (Part 1) ───────────────────────────────
  /** Map a RegistrationResult to the HTTP response. */
  function sendRegistrationResult(
    res: http.ServerResponse,
    result: RegistrationResult<unknown>,
  ): void {
    if (result.ok) {
      sendJson(res, 200, { ok: true, ...(result.value as Record<string, unknown>) });
      return;
    }
    const message = 'message' in result ? result.message : undefined;
    const issues = 'issues' in result ? result.issues : undefined;
    const withMessage = message === undefined ? {} : { message };
    switch (result.reason) {
      case 'unavailable':
        sendJson(res, 503, { ok: false, reason: 'unavailable', ...withMessage });
        break;
      case 'bad-state':
        sendJson(res, 409, { ok: false, reason: 'bad-state', ...withMessage });
        break;
      case 'invalid-input':
        sendJson(res, 400, { ok: false, reason: 'invalid-input', issues: issues ?? [] });
        break;
      case 'not-found':
        sendJson(res, 404, { ok: false, reason: 'not-found', ...withMessage });
        break;
      case 'already-registered':
        sendJson(res, 409, { ok: false, reason: 'already-registered', ...withMessage });
        break;
      case 'provider-error':
        sendJson(res, 502, { ok: false, reason: 'provider-error', ...withMessage });
        break;
      case 'mismatch':
        sendJson(res, 422, { ok: false, reason: 'mismatch', ...withMessage });
        break;
    }
  }

  /** Map a ForgotPasswordResult to the HTTP response. */
  function sendForgotResult(
    res: http.ServerResponse,
    result: ForgotPasswordResult<unknown>,
  ): void {
    if (result.ok) {
      sendJson(res, 200, { ok: true, ...(result.value as Record<string, unknown>) });
      return;
    }
    const message = 'message' in result ? result.message : undefined;
    const issues = 'issues' in result ? result.issues : undefined;
    const withMessage = message === undefined ? {} : { message };
    switch (result.reason) {
      case 'unavailable':
        sendJson(res, 503, { ok: false, reason: 'unavailable', ...withMessage });
        break;
      case 'not-found':
        sendJson(res, 404, { ok: false, reason: 'not-found', ...withMessage });
        break;
      case 'bad-state':
        sendJson(res, 409, { ok: false, reason: 'bad-state', ...withMessage });
        break;
      case 'invalid-input':
        sendJson(res, 400, { ok: false, reason: 'invalid-input', issues: issues ?? [] });
        break;
      case 'provider-error':
        sendJson(res, 502, { ok: false, reason: 'provider-error', ...withMessage });
        break;
      case 'mismatch':
        sendJson(res, 422, { ok: false, reason: 'mismatch', ...withMessage });
        break;
      case 'no-reference':
        sendJson(res, 409, { ok: false, reason: 'no-reference', message: 'No enrolled biometric reference exists.' });
        break;
      case 'revoked':
        sendJson(res, 409, { ok: false, reason: 'revoked', message: 'The biometric reference has been revoked.' });
        break;
    }
  }

  function sendMissingRegistration(res: http.ServerResponse): void {
    sendJson(res, 401, { ok: false, reason: 'no-session', message: 'Start or resume a registration first.' });
  }

  async function routeRegistrationBegin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const limit = registrationBeginLimiter.take(`ip:${clientIp(req)}`);
    if (!limit.allowed) {
      sendJson(res, 429, {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: limit.retryAfterMs,
        message: 'Too many attempts. Try again later.',
      });
      return;
    }
    const result = registrationService.begin();
    if (!result.ok) {
      sendRegistrationResult(res, result);
      return;
    }
    const sessionId = result.value.token;
    res.setHeader('Set-Cookie', setRegistrationCookie(sessionId));
    sendJson(res, 200, {
      ok: true,
      session: sessionId,
      expiresAt: result.value.expiresAt,
    });
  }

  async function routeRegistrationPersonal(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = await registrationService.personal(token, {
      fullName: str(body, 'fullName'),
      aadhaarNumber: str(body, 'aadhaarNumber'),
      addressOnAadhaar: str(body, 'addressOnAadhaar'),
      pincode: str(body, 'pincode'),
      dateOfBirth: str(body, 'dateOfBirth'),
      mobile: str(body, 'mobile'),
    });
    sendRegistrationResult(res, result);
  }

  async function routeRegistrationAadhaarDocument(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const maxBytes = config.registration?.aadhaarDocumentMaxBytes ?? 10 * 1024 * 1024;
    const raw = await readRawBody(req, maxBytes);
    if (raw === null) {
      sendJson(res, 400, { ok: false, reason: 'invalid-body' });
      return;
    }
    const parsed = parseMultipart(req.headers['content-type'], raw, maxBytes);
    if (!parsed.ok) {
      sendJson(res, 400, { ok: false, reason: 'invalid-multipart' });
      return;
    }
    const doc = parsed.body.files.find((f) => f.name === 'document') ?? parsed.body.files[0];
    if (!doc) {
      sendJson(res, 400, { ok: false, reason: 'missing-file' });
      return;
    }
    const result = await registrationService.aadhaarDocument(token, {
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      data: doc.data,
    });
    sendRegistrationResult(res, result);
  }

  async function routeRegistrationEmail(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = await registrationService.submitEmail(token, str(body, 'email'));
    sendRegistrationResult(res, result);
  }

  async function routeRegistrationEmailVerify(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = registrationService.verifyEmailOtp(token, str(body, 'code'));
    sendRegistrationResult(res, result);
  }

  async function routeRegistrationSmsIssue(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = await registrationService.issueSmsOtp(token);
    sendRegistrationResult(res, result);
  }

  async function routeRegistrationSmsVerify(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = registrationService.verifySmsOtp(token, str(body, 'code'));
    sendRegistrationResult(res, result);
  }

  async function routeRegistrationWhatsappIssue(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = await registrationService.issueWhatsappOtp(token);
    sendRegistrationResult(res, result);
  }

  async function routeRegistrationWhatsappVerify(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = registrationService.verifyWhatsappOtp(token, str(body, 'code'));
    sendRegistrationResult(res, result);
  }

  async function routeRegistrationAadhaarMobileStart(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = await registrationService.aadhaarMobileStart(token);
    sendRegistrationResult(res, result);
  }

  async function routeRegistrationAadhaarMobileComplete(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = await registrationService.aadhaarMobileComplete(token, {
      sessionId: str(body, 'sessionId'),
      code: str(body, 'code'),
    });
    sendRegistrationResult(res, result);
  }

  function routeRegistrationPassword(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = registrationService.setPassword(token, {
      password: str(body, 'password'),
      confirm: str(body, 'confirm'),
    });
    sendRegistrationResult(res, result);
  }

  function routeRegistrationLivenessStart(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = registrationService.livenessStart(token);
    sendRegistrationResult(res, result);
  }

  function routeRegistrationLivenessEvidence(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = registrationService.livenessEvidence(
      token,
      body as unknown as import('./registration/liveness').LivenessEvidenceInput,
    );
    sendRegistrationResult(res, result);
  }

  async function routeRegistrationLocation(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = await registrationService.location(token, body);
    sendRegistrationResult(res, result);
  }

  async function routeRegistrationPhoto(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const maxBytes = config.registration?.photoMaxBytes ?? 8 * 1024 * 1024;
    const raw = await readRawBody(req, maxBytes);
    if (raw === null) {
      sendJson(res, 400, { ok: false, reason: 'invalid-body' });
      return;
    }
    const parsed = parseMultipart(req.headers['content-type'], raw, maxBytes);
    if (!parsed.ok) {
      sendJson(res, 400, { ok: false, reason: 'invalid-multipart' });
      return;
    }
    const file = parsed.body.files[0];
    if (!file) {
      sendJson(res, 400, { ok: false, reason: 'missing-file' });
      return;
    }
    const result = registrationService.photo(token, file.data);
    sendRegistrationResult(res, result);
  }

  function routeRegistrationFinalize(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const token = parseRegistrationCookie(req);
    if (!token) {
      sendMissingRegistration(res);
      return;
    }
    const result = registrationService.finalize(token);
    if (!result.ok) {
      sendRegistrationResult(res, result);
      return;
    }
    // The freshly-finalized account is immediately usable: mint an account
    // session so the browser can start the real biometric ENROLLMENT step
    // right after finalize (enrollment requires `requireAuth`). Also clear the
    // one-time registration cookie.
    const { cookieHeader } = sessionService.create(result.value.accountId, result.value.walletAddress);
    res.setHeader('Set-Cookie', [clearRegistrationCookie(), cookieHeader]);
    sendJson(res, 200, {
      ok: true,
      accountId: result.value.accountId,
      walletAddress: result.value.walletAddress,
    });
  }

  // ── Forgot-password (Part 1) ────────────────────────────────────
  async function routeForgotPasswordBegin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: JsonBody,
  ): Promise<void> {
    const limit = forgotPasswordBeginLimiter.take(`ip:${clientIp(req)}`);
    if (!limit.allowed) {
      sendJson(res, 429, {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: limit.retryAfterMs,
        message: 'Too many attempts. Try again later.',
      });
      return;
    }
    const result = await forgotPasswordService.begin(
      str(body, 'walletAddress'),
      str(body, 'email'),
    );
    sendForgotResult(res, result);
  }

  function routeForgotPasswordEmailVerify(
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const result = forgotPasswordService.verifyEmailOtp(
      str(body, 'walletAddress'),
      str(body, 'code'),
    );
    sendForgotResult(res, result);
  }

  function routeForgotPasswordLivenessStart(
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const result = forgotPasswordService.livenessStart(str(body, 'walletAddress'));
    sendForgotResult(res, result);
  }

  function routeForgotPasswordLivenessEvidence(
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const result = forgotPasswordService.livenessEvidence(
      str(body, 'walletAddress'),
      body as unknown as import('./registration/liveness').LivenessEvidenceInput,
    );
    sendForgotResult(res, result);
  }

  function routeForgotPasswordBiometricStart(
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const result = forgotPasswordService.biometricStart(str(body, 'walletAddress'));
    sendForgotResult(res, result);
  }

  function routeForgotPasswordBiometricVerify(
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const raw = body['liveEmbedding'] as unknown;
    const liveEmbedding = Array.isArray(raw) && raw.every((x) => typeof x === 'number')
      ? raw
      : undefined;
    if (liveEmbedding === undefined) {
      sendJson(res, 400, { ok: false, reason: 'invalid-input', issues: [{ field: 'liveEmbedding', code: 'invalid' }] });
      return;
    }
    const result = forgotPasswordService.biometricVerify(
      str(body, 'walletAddress'),
      {
        verificationToken: str(body, 'verificationToken'),
        liveEmbedding,
      },
    );
    sendForgotResult(res, result);
  }

  function routeForgotPasswordReset(
    res: http.ServerResponse,
    body: JsonBody,
  ): void {
    const walletAddress = str(body, 'walletAddress');
    const result = forgotPasswordService.reset(walletAddress, {
      newPassword: str(body, 'newPassword'),
      confirmPassword: str(body, 'confirmPassword'),
    });
    if (!result.ok) {
      sendForgotResult(res, result);
      return;
    }
    // Destroy every existing session so the password change really takes effect.
    const rec = accountService.get(walletAddress);
    if (rec.ok && 'view' in rec) {
      sessionService.destroyByAccount(rec.view.accountId);
    }
    sendJson(res, 200, { ok: true, ...(result.value as Record<string, unknown>) });
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
  const { server, port } = createVerificationServer(config);
  server.listen(port, () => {
    console.log(`[priestate-verify] listening on :${port}`);
    console.log('[priestate-verify] OTP codes are generated server-side and never echoed to clients.');
  });
}
