// PRIESTATE — Backend-backed provider clients.
//
// The ONLY configuration the browser needs is VITE_VERIFICATION_API_URL
// (a public URL — never a credential). Every secret stays on the
// verification server; the browser only learns success/failure and the
// receipt metadata. If the API is unreachable or reports a capability as
// unconfigured, results are `unavailable` — never a fake success.

import type {
  CompleteAadhaarMobileResult,
  ContactVerificationProvider,
  IdentityVerificationProvider,
  SendEmailOtpResult,
  StartAadhaarMobileResult,
  VerifyEmailOtpResult,
} from './types';
import { AADHAAR_UNAVAILABLE_MESSAGE, VERIFICATION_UNAVAILABLE_MESSAGE } from './types';

/** Public base URL of the verification API ('' → same origin /api proxy). */
export function verificationApiBase(): string {
  // Lazy + defensive read so this module also loads outside the Vite
  // bundler (automated tests run under plain Node).
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return (env?.VITE_VERIFICATION_API_URL ?? '').replace(/\/+$/, '');
}

interface ApiErrorBody {
  ok?: boolean;
  reason?: string;
  message?: string;
  retryAfterMs?: number;
  error?: string;
}

async function apiPost(
  apiBase: string,
  path: string,
  body: unknown,
): Promise<{ status: number; data: unknown; error: ApiErrorBody | null }> {
  try {
    const res = await fetch(`${apiBase}/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let payload: unknown = null;
    try {
      payload = (await res.json()) ?? null;
    } catch {
      payload = null;
    }
    return { status: res.status, data: payload, error: payload as ApiErrorBody };
  } catch {
    // Network failure / server down → honest unavailable state.
    return { status: 0, data: null, error: null };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

// ── Email contact verification ──────────────────────────────────────

export class BackendContactVerificationProvider implements ContactVerificationProvider {
  /** Base URL of the API; defaults to the configured public URL. */
  constructor(private readonly apiBase: string = verificationApiBase()) {}

  async sendEmailOtp(email: string): Promise<SendEmailOtpResult> {
    const { status, data } = await apiPost(this.apiBase, 'v1/email/send-otp', { email });
    if (!isRecord(data) || !('ok' in data)) {
      return { ok: false, reason: 'unavailable', message: VERIFICATION_UNAVAILABLE_MESSAGE };
    }
    if (data.ok === true && typeof data.expiresAt === 'number' && typeof data.resendAvailableAt === 'number') {
      return {
        ok: true,
        challenge: { expiresAt: data.expiresAt, resendAvailableAt: data.resendAvailableAt },
      };
    }
    const reason = String(data.reason ?? '');
    const knownReasons = ['invalid-email', 'cooldown', 'rate-limited', 'provider-error'];
    return {
      ok: false,
      reason: (knownReasons.includes(reason)
        ? reason
        : status === 503 || status === 0
          ? 'unavailable'
          : 'provider-error') as Exclude<SendEmailOtpResult, { ok: true }>['reason'],
      message: typeof data.message === 'string' ? data.message : undefined,
      retryAfterMs: typeof data.retryAfterMs === 'number' ? data.retryAfterMs : undefined,
    };
  }

  async verifyEmailOtp(email: string, code: string): Promise<VerifyEmailOtpResult> {
    const { status, data } = await apiPost(this.apiBase, 'v1/email/verify-otp', { email, code });
    if (!isRecord(data) || !('ok' in data)) {
      return { ok: false, reason: 'unavailable', message: VERIFICATION_UNAVAILABLE_MESSAGE };
    }
    if (data.ok === true) {
      return { ok: true, verifiedAt: String(data.verifiedAt ?? new Date().toISOString()) };
    }
    const knownReasons = ['unavailable', 'invalid-email', 'expired', 'invalid', 'too-many-attempts'];
    const fallback = status === 503 || status === 0 ? 'unavailable' : 'invalid';
    return {
      ok: false,
      reason: (knownReasons.includes(String(data.reason))
        ? String(data.reason)
        : fallback) as Exclude<VerifyEmailOtpResult, { ok: true }>['reason'],
    };
  }
}

// ── Aadhaar-linked mobile identity verification ─────────────────────

export class BackendIdentityVerificationProvider implements IdentityVerificationProvider {
  private availability: boolean | null = null;

  constructor(private readonly apiBase: string = verificationApiBase()) {}

  /** True once /api/health reported the Aadhaar capability configured. */
  async isConfiguredOnServer(): Promise<boolean> {
    if (this.availability !== null) return this.availability;
    try {
      const res = await fetch(`${this.apiBase}/api/health`);
      if (!res.ok) throw new Error(`health ${res.status}`);
      const body: unknown = await res.json();
      this.availability =
        isRecord(body) &&
        isRecord(body.capabilities) &&
        body.capabilities.aadhaarMobile === true;
    } catch {
      this.availability = false;
    }
    return this.availability;
  }

  /** Forget cached health state (used after server config changes/tests). */
  resetAvailability(): void {
    this.availability = null;
  }

  async startAadhaarMobileVerification(mobile: string): Promise<StartAadhaarMobileResult> {
    const configured = await this.isConfiguredOnServer();
    if (!configured) return aadhaarStartUnavailable();
    const { status, data } = await apiPost(this.apiBase, 'v1/aadhaar-mobile/start', { mobile });
    if (!isRecord(data) || !('ok' in data)) return aadhaarStartUnavailable();
    if (data.ok === true) {
      // Pass-through of the wire shape (already matches StartAadhaarMobileResult).
      return data as unknown as StartAadhaarMobileResult;
    }
    const knownReasons = ['invalid-mobile', 'provider-error', 'rate-limited'];
    return {
      ok: false,
      reason: (knownReasons.includes(String(data.reason))
        ? String(data.reason)
        : status === 503 || status === 0
          ? 'unavailable'
          : 'provider-error') as Exclude<StartAadhaarMobileResult, { ok: true }>['reason'],
      message: typeof data.message === 'string' ? data.message : undefined,
      retryAfterMs: typeof data.retryAfterMs === 'number' ? data.retryAfterMs : undefined,
    };
  }

  async verifyAadhaarMobileVerification(input: { sessionId: string; code: string }): Promise<CompleteAadhaarMobileResult> {
    const configured = await this.isConfiguredOnServer();
    if (!configured) return aadhaarCompleteUnavailable();
    const { status, data } = await apiPost(this.apiBase, 'v1/aadhaar-mobile/complete', input);
    if (!isRecord(data) || !('ok' in data)) return aadhaarCompleteUnavailable();
    if (data.ok === true) {
      return data as unknown as CompleteAadhaarMobileResult;
    }
    const knownReasons = [
      'invalid-session',
      'expired',
      'invalid-code',
      'too-many-attempts',
      'provider-error',
      'rate-limited',
    ];
    return {
      ok: false,
      reason: (knownReasons.includes(String(data.reason))
        ? String(data.reason)
        : status === 503 || status === 0
          ? 'unavailable'
          : 'provider-error') as Exclude<CompleteAadhaarMobileResult, { ok: true }>['reason'],
      message: typeof data.message === 'string' ? data.message : undefined,
    };
  }
}

function aadhaarStartUnavailable(): StartAadhaarMobileResult {
  return { ok: false, reason: 'unavailable', message: AADHAAR_UNAVAILABLE_MESSAGE };
}

function aadhaarCompleteUnavailable(): CompleteAadhaarMobileResult {
  return { ok: false, reason: 'unavailable', message: AADHAAR_UNAVAILABLE_MESSAGE };
}
