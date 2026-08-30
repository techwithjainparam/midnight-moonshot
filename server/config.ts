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
  readonly account?: {
    /**
     * Server-only secret used to derive the AES key that encrypts account PII
     * at rest. Missing/short ⇒ the account feature is `unavailable` (fail
     * closed; PII is never persisted plainly).
     */
    readonly encryptionSecret: string;
    /** True when a real SMS gateway is configured (else SMS OTP is unavailable). */
    readonly smsConfigured: boolean;
    /** True when a real WhatsApp gateway API is configured (else unavailable). */
    readonly whatsappConfigured: boolean;
    /** True when a real Google OAuth client is configured (else unavailable). */
    readonly googleConfigured: boolean;
  };
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

  return {
    port: intEnv('VERIFY_SERVER_PORT', 8787),
    allowedOrigins,
    email: {
      // Real delivery requires host + credentials + an explicit From.
      configured: Boolean(smtpHost && smtpUser && smtpPass && env.EMAIL_FROM),
      host: smtpHost,
      port: intEnv('SMTP_PORT', 587),
      secure: env.SMTP_SECURE === 'true',
      user: smtpUser,
      pass: smtpPass,
      from: env.EMAIL_FROM?.trim() ?? '',
    },
    otp: {
      hashSecret: otpHashSecret,
      ttlMs: intEnv('EMAIL_OTP_TTL_MINUTES', 10) * 60 * 1000,
      maxAttempts: intEnv('EMAIL_OTP_MAX_ATTEMPTS', 5),
      resendCooldownMs: intEnv('EMAIL_OTP_RESEND_COOLDOWN_SECONDS', 60) * 1000,
      maxSendsPerEmailPerHour: intEnv('EMAIL_OTP_MAX_SENDS_PER_HOUR', 5),
      maxSendsPerIpPerHour: intEnv('VERIFY_IP_MAX_SENDS_PER_HOUR', 20),
    },
    account: {
      encryptionSecret: env.ACCOUNT_ENC_SECRET?.trim() ?? '',
      smsConfigured: env.SMS_GATEWAY_PROVIDER?.trim() !== '',
      whatsappConfigured: env.WHATSAPP_GATEWAY_API_TOKEN?.trim() !== '',
      googleConfigured: env.GOOGLE_CLIENT_ID?.trim() !== '' && env.GOOGLE_CLIENT_SECRET?.trim() !== '',
    },
    aadhaarKyc: {
      providerName: env.AADHAAR_KYC_PROVIDER?.trim() ?? '',
      apiToken: env.AADHAAR_KYC_API_TOKEN?.trim() ?? '',
      baseUrl: env.AADHAAR_KYC_BASE_URL?.trim() ?? '',
      mobileLinkPath:
        env.AADHAAR_KYC_MOBILE_LINK_PATH?.trim() ?? '/api/v1/mobile-to-aadhaar/',
      timeoutMs: intEnv('AADHAAR_KYC_TIMEOUT_MS', 20000),
    },
    registry: {
      officerToken: env.REGISTRY_OFFICER_API_TOKEN ?? '',
    },
  };
}
