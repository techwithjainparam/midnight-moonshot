// PRIESTATE — Authorized KYC provider adapter (Aadhaar-linked mobile).
//
// Talks to a REAL, authorized identity/KYC vendor over HTTPS. The
// adapter is vendor-agnostic and is configured entirely through
// server-side environment variables:
//
//   AADHAAR_KYC_PROVIDER     logical name recorded in receipts
//   AADHAAR_KYC_API_TOKEN    the vendor API token/key (SERVER ONLY)
//   AADHAAR_KYC_BASE_URL     e.g. https://kyc.surepass.io
//   AADHAAR_KYC_MOBILE_LINK_PATH   direct link-check endpoint
//                                    (Surepass-style: POST {mobile_number})
//   AADHAAR_KYC_AUTH_SCHEME  'token' | 'bearer' (Authorization header)
//
// Two canonical interaction styles are supported:
//
// 1. DIRECT LINK CHECK — POST the mobile to `mobileLinkPath`; the vendor
//    consults its UIDAI-authorized data source and answers whether the
//    mobile is linked to an Aadhaar. Response booleans are read from
//    common vendor fields (`data.registered`, `data.linked`,
//    `data.is_linked`, `data.aadhaar_linked`, …). An ambiguous response
//    FAILS CLOSED as a provider error — never reported as verified.
//
// 2. OTP CHALLENGE — if `AADHAAR_KYC_CHALLENGE_PATH` +
//    `AADHAAR_KYC_SUBMIT_PATH` are configured, start calls the challenge
//    endpoint (vendor sends an OTP to the REGISTERED mobile) and complete
//    submits it. The link result again fails closed on ambiguity.
//
// If no credentials are configured the adapter reports `unavailable`.
// It NEVER fabricates success.

import { randomUUID } from 'node:crypto';
import type {
  AadhaarMobileReceipt,
  CompleteAadhaarMobileResult,
  IdentityVerificationProvider,
  StartAadhaarMobileResult,
} from './identity-provider-types';
import { normalizeIndianMobile } from '../lib/validation';

export interface HttpKycProviderConfig {
  readonly providerName: string;
  readonly apiToken: string;
  readonly baseUrl: string;
  readonly mobileLinkPath?: string;
  readonly challengePath?: string;
  readonly submitPath?: string;
  readonly authScheme: 'token' | 'bearer';
  readonly timeoutMs: number;
}

export function kycProviderFromConfig(cfg: {
  providerName: string;
  apiToken: string;
  baseUrl: string;
  mobileLinkPath: string;
  timeoutMs: number;
  challengePath?: string;
  submitPath?: string;
  authScheme?: 'token' | 'bearer';
}): HttpAadhaarKycProvider | null {
  const hasDirectLink = Boolean(cfg.apiToken && cfg.baseUrl);
  if (!hasDirectLink) return null;
  return new HttpAadhaarKycProvider({
    providerName: cfg.providerName || 'http-kyc',
    apiToken: cfg.apiToken,
    baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
    mobileLinkPath: cfg.mobileLinkPath,
    challengePath: cfg.challengePath,
    submitPath: cfg.submitPath,
    authScheme: cfg.authScheme ?? 'token',
    timeoutMs: cfg.timeoutMs,
  });
}

interface ChallengeSession {
  readonly mobile: string;
  readonly providerTxnId: string | null;
  readonly expiresAt: number;
  attempts: number;
}

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_CHALLENGE_ATTEMPTS = 5;

export class HttpAadhaarKycProvider implements IdentityVerificationProvider {
  readonly name: string;

  private readonly cfg: Required<Pick<HttpKycProviderConfig, 'apiToken' | 'baseUrl'>> & HttpKycProviderConfig;
  private readonly sessions = new Map<string, ChallengeSession>();

  constructor(cfg: HttpKycProviderConfig) {
    this.name = cfg.providerName;
    this.cfg = {
      ...cfg,
      mobileLinkPath: cfg.mobileLinkPath ?? '/api/v1/mobile-to-aadhaar/',
      challengePath: cfg.challengePath,
      submitPath: cfg.submitPath,
      authScheme: cfg.authScheme ?? 'token',
      timeoutMs: cfg.timeoutMs ?? 20_000,
    };
  }

  get available(): boolean {
    // Direct link-check capability is the minimum for "available".
    return Boolean(this.cfg.apiToken && this.cfg.baseUrl && this.cfg.mobileLinkPath);
  }

  async startAadhaarMobileVerification(mobileRaw: string): Promise<StartAadhaarMobileResult> {
    const mobile = normalizeIndianMobile(mobileRaw);
    if (!mobile) {
      return { ok: false, reason: 'invalid-mobile', message: 'Enter a valid Indian mobile number.' };
    }

    // OTP-challenge style when configured; otherwise direct link check.
    if (this.cfg.challengePath && this.cfg.submitPath) {
      return this.startChallengeFlow(mobile);
    }
    return this.directLinkCheck(mobile);
  }

  async verifyAadhaarMobileVerification(input: { sessionId: string; code: string }): Promise<CompleteAadhaarMobileResult> {
    if (!this.cfg.submitPath) {
      return { ok: false, reason: 'unavailable', message: 'Verification service unavailable.' };
    }
    const session = this.sessions.get(input.sessionId);
    if (!session) return { ok: false, reason: 'invalid-session', message: 'Start the verification again.' };
    if (Date.now() >= session.expiresAt) {
      this.sessions.delete(input.sessionId);
      return { ok: false, reason: 'expired', message: 'This verification session expired. Start again.' };
    }

    session.attempts += 1;
    if (session.attempts > MAX_CHALLENGE_ATTEMPTS) {
      this.sessions.delete(input.sessionId);
      return { ok: false, reason: 'too-many-attempts', message: 'Too many incorrect attempts. Start again.' };
    }

    let parsed: unknown;
    try {
      parsed = await this.postJson(this.cfg.submitPath, {
        transaction_id: session.providerTxnId ?? input.sessionId,
        otp: input.code.trim(),
      });
    } catch {
      return { ok: false, reason: 'provider-error', message: 'The identity provider could not be reached. Try again.' };
    }

    const verdict = interpretLinkResponse(parsed);
    this.sessions.delete(input.sessionId);
    if (verdict === null) {
      return { ok: false, reason: 'provider-error', message: 'The identity provider returned an unclear response. No verification was performed.' };
    }
    if (!verdict.linked) {
      return { ok: true, mode: 'not-linked', message: NOT_LINKED_MESSAGE };
    }
    return { ok: true, mode: 'verified', receipt: receipt(session.mobile) };
  }

  // ── internals ──────────────────────────────────────────────────────

  private async directLinkCheck(mobile: string): Promise<StartAadhaarMobileResult> {
    let parsed: unknown;
    try {
      parsed = await this.postJson(this.cfg.mobileLinkPath!, {
        mobile_number: mobile,
      });
    } catch {
      return { ok: false, reason: 'provider-error', message: 'The identity provider could not be reached. Try again.' };
    }

    const verdict = interpretLinkResponse(parsed);
    if (verdict === null) {
      return {
        ok: false,
        reason: 'provider-error',
        message: 'The identity provider returned an unclear response. No verification was performed.',
      };
    }
    if (!verdict.linked) {
      return { ok: true, mode: 'not-linked', message: NOT_LINKED_MESSAGE };
    }
    return { ok: true, mode: 'verified', receipt: receipt(mobile) };
  }

  private async startChallengeFlow(mobile: string): Promise<StartAadhaarMobileResult> {
    let parsed: unknown;
    try {
      parsed = await this.postJson(this.cfg.challengePath!, { mobile_number: mobile });
    } catch {
      return { ok: false, reason: 'provider-error', message: 'The identity provider could not be reached. Try again.' };
    }

    const txnId =
      pickString(parsed, ['transaction_id', 'request_id', 'session_id', 'data.transaction_id']) ?? randomUUID();
    const sessionId = randomUUID();
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;
    this.sessions.set(sessionId, { mobile, providerTxnId: txnId, expiresAt, attempts: 0 });
    this.sweepSessions();

    return {
      ok: true,
      mode: 'otp-challenge',
      session: { id: sessionId, expiresAt },
      message: 'An OTP was sent by the identity provider to the registered mobile.',
    };
  }

  private sweepSessions(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now >= s.expiresAt) this.sessions.delete(id);
    }
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:
            this.cfg.authScheme === 'bearer'
              ? `Bearer ${this.cfg.apiToken}`
              : `Token ${this.cfg.apiToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`KYC provider responded ${res.status}`);
      }
      return (await res.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}

const NOT_LINKED_MESSAGE =
  'The identity provider reports that this mobile number is not linked to an Aadhaar identity.';

function receipt(mobile: string): AadhaarMobileReceipt {
  return {
    providerVerificationId: `aadharmob_${randomUUID()}`,
    mobile,
    verificationStatus: 'VERIFIED',
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Read the vendor's answer from common response shapes. Returns
 * `{ linked }` only when the response UNAMBIGUOUSLY states the link
 * status; anything unclear returns null → callers fail closed.
 */
export function interpretLinkResponse(payload: unknown): { linked: boolean } | null {
  const boolFields = [
    'data.registered',
    'data.linked',
    'data.is_linked',
    'data.aadhaar_linked',
    'data.mobile_linked',
    'registered',
    'linked',
    'is_linked',
    'aadhaar_linked',
    'mobile_linked',
  ];
  for (const path of boolFields) {
    const v = pickValue(payload, path);
    if (typeof v === 'boolean') return { linked: v };
    if (typeof v === 'string') {
      const norm = v.trim().toLowerCase();
      if (['true', 'yes', '1'].includes(norm)) return { linked: true };
      if (['false', 'no', '0'].includes(norm)) return { linked: false };
    }
  }
  return null;
}

function pickValue(payload: unknown, dottedPath: string): unknown {
  let cur: unknown = payload;
  for (const part of dottedPath.split('.')) {
    if (cur !== null && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function pickString(payload: unknown, paths: readonly string[]): string | null {
  for (const p of paths) {
    const v = pickValue(payload, p);
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
