// PRIESTATE verification server — configuration.
//
// ⚠️ SERVER-SIDE ONLY. This module runs exclusively in the Node process
// (tsx server/index.ts) and is NEVER bundled into the browser build.
//
// Every secret below is read from a plain (non-VITE_*) environment
// variable so nothing here can leak into client JavaScript. The ONLY
// variable the browser may see is VITE_VERIFICATION_API_URL, which is a
// public URL of this API — never a credential.

export interface ServerConfig {
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  /**
   * When true, the client IP used by rate limiters is taken from the
   * RIGHTMOST `X-Forwarded-For` entry (the value appended by a single trusted
   * reverse-proxy edge such as Railway/Render/Fly/Vercel). Client-supplied
   * leading entries are never trusted. When false/unset (local development)
   * the socket peer address is used and `X-Forwarded-For` is ignored.
   */
  readonly trustProxy?: boolean;
  readonly email: {
    readonly configured: boolean;
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly user: string;
    readonly pass: string;
    readonly from: string;
  };
  readonly otp: {
    /** Hash secret for OTP-at-rest (HMAC-SHA256). Required in production. */
    readonly hashSecret: string;
    readonly ttlMs: number;
    readonly maxAttempts: number;
    readonly resendCooldownMs: number;
    readonly maxSendsPerEmailPerHour: number;
    readonly maxSendsPerIpPerHour: number;
  };
  readonly aadhaarKyc: {
    readonly providerName: string;
    readonly apiToken: string;
    readonly baseUrl: string;
    /** Endpoint path for mobile→Aadhaar link verification at the provider. */
    readonly mobileLinkPath: string;
    /** Optional OTP-challenge endpoints (vendor sends an OTP to the registered mobile). */
    readonly challengePath?: string;
    readonly submitPath?: string;
    /** Authorization scheme used for the KYC vendor API. */
    readonly authScheme: 'token' | 'bearer';
    readonly timeoutMs: number;
  };
  readonly registry: {
    /**
     * Server-side officer credential for the registry metadata API. It is a
     * plain (non-VITE_*) env var that never reaches the browser bundle and is
     * never logged. Empty ⇒ the registry API is `unavailable` (fail closed).
     * This is a SEPARATE boundary from the on-chain officer check and from
     * the DEMO frontend role gate.
     */
    readonly officerToken: string;
  };
  /**
   * One-time officer commissioning code for the server-backed officer
   * credential (see server/account/officer.ts). It mints the SINGLE officer
   * account for a deployment. Empty ⇒ officer registration is `unavailable`
   * (fail closed). Never placed in a VITE_* variable or logged. Optional so
   * test fixtures can omit it (loadConfig always populates it).
   */
  readonly officer?: {
    readonly registrationCode: string;
  };
  readonly account?: {
    /**
     * Server-only secret used to derive the AES key that encrypts account PII
     * at rest. Missing/short ⇒ the account feature is `unavailable` (fail
     * closed; PII is never persisted plainly).
     */
    readonly encryptionSecret: string;
    /**
     * SEPARATE secret deriving the biometric-reference at-rest AES key. When
     * absent the biometric feature fails closed (never enrolls/stores).
     */
    readonly biometricEncryptionSecret: string;
    /** Absolute or CWD-relative path to the SQLite database file. */
    readonly dbPath: string;
    /** True when a real SMS gateway is configured (else SMS OTP is unavailable). */
    readonly smsConfigured: boolean;
    /** True when a real WhatsApp gateway API is configured (else unavailable). */
    readonly whatsappConfigured: boolean;
    /** True when a real Google OAuth client is configured (else unavailable). */
    readonly googleConfigured: boolean;
    /** Real SMS gateway adapter settings (J.4). */
    readonly sms?: import('./account/sms-provider').SmsProviderConfig;
    /** Real WhatsApp Cloud API adapter settings (J.4). */
    readonly whatsapp?: import('./account/whatsapp-provider').WhatsAppProviderConfig;
    /** Real Google OAuth2 settings (J.4). */
    readonly googleOauth?: {
      readonly enabled: boolean;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly redirectUri: string;
      readonly oauthAuthorizeEndpoint?: string;
      readonly oauthTokenEndpoint?: string;
      readonly oauthUserinfoEndpoint?: string;
      readonly jwksUri?: string;
      readonly issuer?: string;
      readonly timeoutMs: number;
      readonly stateTtlMs?: number;
    };
    /** Session cookie TTL in ms (default 24h). */
    readonly sessionTtlMs: number;
    /** Whether to set the Secure flag on session cookies (default true). */
    readonly sessionSecure: boolean;
    /**
     * Session cookie SameSite policy (Lax | Strict | None).
     *
     * Default Lax keeps the local-development behavior. Production serves the
     * app from a Vercel origin and the API from a Railway origin — that is a
     * CROSS-SITE request, so the cookie must be SameSite=None (+ Secure, which
     * is forced on) for it to be stored and sent by the browser.
     */
    readonly sessionSameSite?: 'Lax' | 'Strict' | 'None';
  };
  /**
   * Registration-service configuration (Part 1 new stepper). Empty credential
   * values make the corresponding provider `unavailable` (fail closed) — the
   * stepper reports honestly and never fabricates a pass.
   */
  readonly registration?: {
    /** Aadhaar document OCR (Surepass-style). Empty ⇒ OCR step unavailable. */
    readonly aadhaarOcr: {
      readonly providerName: string;
      readonly apiToken: string;
      readonly baseUrl: string;
      readonly ocrPath: string;
      readonly timeoutMs: number;
    };
    /** India Post pincode resolution (defaults to api.postalpincode.in). */
    readonly pincode: {
      readonly baseUrl?: string;
      readonly timeoutMs?: number;
      readonly maxRetries?: number;
      readonly retryBaseDelayMs?: number;
    };
    /** Reverse geocoding (defaults to nominatim.openstreetmap.org). */
    readonly geocoding: {
      readonly baseUrl?: string;
      readonly timeoutMs?: number;
    };
    /** Extra disposable-email domains (comma-separated env). */
    readonly disposableEmailExtraDomains: string;
    /** Max raw bytes accepted for an uploaded Aadhaar document. */
    readonly aadhaarDocumentMaxBytes: number;
    /** Max raw bytes accepted for the passport photo. */
    readonly photoMaxBytes: number;
    /** Registration session lifetime. */
    readonly sessionTtlMs: number;
  };
}

function intEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Server port resolution.
 *
 * 1. VERIFY_SERVER_PORT   — explicit override (local development, docs).
 * 2. PORT                 — injected by platforms (Railway/Render/Fly/Vercel).
 * 3. 8787                 — local default.
 */
function readPort(env: NodeJS.ProcessEnv): number {
  const raw = (env.VERIFY_SERVER_PORT || env.PORT || '').trim();
  if (!raw) return 8787;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8787;
}

/** Coerce ACCOUNT_SESSION_SAMESITE; anything outside Lax|Strict|None → Lax. */
function readSessionSameSite(env: NodeJS.ProcessEnv): 'Lax' | 'Strict' | 'None' {
  const v = env.ACCOUNT_SESSION_SAMESITE?.trim();
  if (v === 'Strict' || v === 'None') return v;
  return 'Lax';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const originsRaw = env.VERIFY_SERVER_ALLOWED_ORIGIN ?? 'http://localhost:3000';
  const allowedOrigins = originsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const smtpHost = env.SMTP_HOST?.trim() ?? '';
  const smtpUser = env.SMTP_USER?.trim() ?? '';
  const smtpPass = env.SMTP_PASS ?? '';

  const otpHashSecret = env.OTP_HASH_SECRET ?? '';
  const sessionSameSite = readSessionSameSite(env);

  return {
    port: readPort(env),
    allowedOrigins,
    // A single trusted reverse-proxy edge enabled explicitly (never default).
    trustProxy: env.VERIFY_SERVER_TRUST_PROXY?.trim() === 'true',
    email: {
      // Real delivery requires host + credentials + an explicit From.
      configured: Boolean(smtpHost && smtpUser && smtpPass && env.EMAIL_FROM),
      host: smtpHost,
      port: intEnv('SMTP_PORT', 587, env),
      secure: env.SMTP_SECURE === 'true',
      user: smtpUser,
      pass: smtpPass,
      from: env.EMAIL_FROM?.trim() ?? '',
    },
    otp: {
      hashSecret: otpHashSecret,
      ttlMs: intEnv('EMAIL_OTP_TTL_MINUTES', 10, env) * 60 * 1000,
      maxAttempts: intEnv('EMAIL_OTP_MAX_ATTEMPTS', 5, env),
      resendCooldownMs: intEnv('EMAIL_OTP_RESEND_COOLDOWN_SECONDS', 60, env) * 1000,
      maxSendsPerEmailPerHour: intEnv('EMAIL_OTP_MAX_SENDS_PER_HOUR', 5, env),
      maxSendsPerIpPerHour: intEnv('VERIFY_IP_MAX_SENDS_PER_HOUR', 20, env),
    },
    account: {
      encryptionSecret: env.ACCOUNT_ENC_SECRET?.trim() ?? '',
      biometricEncryptionSecret: env.ACCOUNT_BIOMETRIC_ENC_SECRET?.trim() ?? '',
      dbPath: env.ACCOUNT_DB_PATH?.trim() ?? '',
      smsConfigured: env.SMS_GATEWAY_PROVIDER?.trim() !== '',
      whatsappConfigured: env.WHATSAPP_GATEWAY_API_TOKEN?.trim() !== '',
      googleConfigured: env.GOOGLE_CLIENT_ID?.trim() !== '' && env.GOOGLE_CLIENT_SECRET?.trim() !== '',
      sms: {
        provider: env.SMS_GATEWAY_PROVIDER?.trim() ?? '',
        twilio:
          env.SMS_GATEWAY_PROVIDER?.trim() === 'twilio'
            ? {
                accountSid: env.SMS_TWILIO_ACCOUNT_SID?.trim() ?? '',
                authToken: env.SMS_TWILIO_AUTH_TOKEN ?? '',
                fromNumber: env.SMS_TWILIO_FROM?.trim() ?? '',
              }
            : undefined,
        genericHttp:
          env.SMS_GATEWAY_PROVIDER?.trim() === 'generic-http'
            ? {
                url: env.SMS_HTTP_URL?.trim() ?? '',
                token: env.SMS_HTTP_TOKEN ?? '',
                timeoutMs: intEnv('SMS_HTTP_TIMEOUT_MS', 10000, env),
              }
            : undefined,
        timeoutMs: intEnv('SMS_TIMEOUT_MS', 10000, env),
      },
      whatsapp: {
        apiToken: env.WHATSAPP_GATEWAY_API_TOKEN?.trim() ?? '',
        phoneNumberId: env.WHATSAPP_GATEWAY_PHONE_NUMBER_ID?.trim() ?? '',
        baseUrl: env.WHATSAPP_GATEWAY_BASE_URL?.trim() || undefined,
        apiVersion: env.WHATSAPP_GATEWAY_API_VERSION?.trim() || undefined,
        timeoutMs: intEnv('WHATSAPP_TIMEOUT_MS', 10000, env),
      },
      googleOauth: {
        enabled: env.GOOGLE_OAUTH_ENABLED?.trim() !== 'false',
        clientId: env.GOOGLE_CLIENT_ID?.trim() ?? '',
        clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
        redirectUri: env.GOOGLE_REDIRECT_URI?.trim() ?? '',
        oauthAuthorizeEndpoint:
          env.GOOGLE_AUTH_ENDPOINT?.trim() || 'https://accounts.google.com/o/oauth2/v2/auth',
        oauthTokenEndpoint:
          env.GOOGLE_TOKEN_ENDPOINT?.trim() || 'https://oauth2.googleapis.com/token',
        oauthUserinfoEndpoint:
          env.GOOGLE_USERINFO_ENDPOINT?.trim() || 'https://openidconnect.googleapis.com/v1/userinfo',
        jwksUri: env.GOOGLE_JWKS_ENDPOINT?.trim() || 'https://www.googleapis.com/oauth2/v3/certs',
        issuer: env.GOOGLE_ISSUER?.trim() || 'https://accounts.google.com',
        timeoutMs: intEnv('GOOGLE_OAUTH_TIMEOUT_MS', 8000, env),
        stateTtlMs: intEnv('GOOGLE_STATE_TTL_MINUTES', 10, env) * 60 * 1000,
      },
      sessionTtlMs: intEnv('ACCOUNT_SESSION_TTL_HOURS', 24, env) * 60 * 60 * 1000,
      // SameSite=None cookies are only honored over HTTPS — force Secure on.
      sessionSecure:
        sessionSameSite === 'None' ? true : env.ACCOUNT_SESSION_SECURE !== 'false',
      sessionSameSite,
    },
    aadhaarKyc: {
      providerName: env.AADHAAR_KYC_PROVIDER?.trim() ?? '',
      apiToken: env.AADHAAR_KYC_API_TOKEN?.trim() ?? '',
      baseUrl: env.AADHAAR_KYC_BASE_URL?.trim() ?? '',
      mobileLinkPath:
        env.AADHAAR_KYC_MOBILE_LINK_PATH?.trim() ?? '/api/v1/mobile-to-aadhaar/',
      challengePath: env.AADHAAR_KYC_CHALLENGE_PATH?.trim() || undefined,
      submitPath: env.AADHAAR_KYC_SUBMIT_PATH?.trim() || undefined,
      authScheme:
        env.AADHAAR_KYC_AUTH_SCHEME?.trim().toLowerCase() === 'bearer' ? 'bearer' : 'token',
      timeoutMs: intEnv('AADHAAR_KYC_TIMEOUT_MS', 20000, env),
    },
    registry: {
      officerToken: env.REGISTRY_OFFICER_API_TOKEN ?? '',
    },
    officer: {
      registrationCode: env.OFFICER_REGISTRATION_CODE?.trim() ?? '',
    },
    registration: {
      aadhaarOcr: {
        providerName: env.AADHAAR_OCR_PROVIDER?.trim() ?? '',
        apiToken: env.AADHAAR_OCR_API_TOKEN?.trim() ?? '',
        baseUrl: env.AADHAAR_OCR_BASE_URL?.trim() ?? '',
        ocrPath: env.AADHAAR_OCR_PATH?.trim() ?? '',
        timeoutMs: intEnv('AADHAAR_OCR_TIMEOUT_MS', 20000, env),
      },
      pincode: {
        baseUrl: env.PINCODE_BASE_URL?.trim() || undefined,
        timeoutMs: intEnv('PINCODE_TIMEOUT_MS', 8000, env),
        maxRetries: intEnv('PINCODE_MAX_RETRIES', 2, env),
        retryBaseDelayMs: intEnv('PINCODE_RETRY_BASE_DELAY_MS', 350, env),
      },
      geocoding: {
        baseUrl: env.GEOCODING_BASE_URL?.trim() || undefined,
        timeoutMs: intEnv('GEOCODING_TIMEOUT_MS', 8000, env),
      },
      disposableEmailExtraDomains: env.DISPOSABLE_EMAIL_BLOCK_LIST ?? '',
      aadhaarDocumentMaxBytes: intEnv('AADHAAR_DOCUMENT_MAX_BYTES', 10 * 1024 * 1024, env),
      photoMaxBytes: intEnv('REGISTRATION_PHOTO_MAX_BYTES', 8 * 1024 * 1024, env),
      sessionTtlMs: intEnv('REGISTRATION_SESSION_TTL_MINUTES', 120, env) * 60 * 1000,
    },
  };
}
