// PRIESTATE — Frontend client for the Level 3 account API.
//
// Talks to the verification server's /api/v1/account/* endpoints. The client
// NEVER sends raw PII it should not (the server is the boundary) and NEVER
// persists passwords or OTP codes. When the server reports a capability as
// unavailable (no real SMS/WhatsApp/Google gateway configured), this client
// surfaces an honest `unavailable` state — it never fakes a factor.

import { verificationApiBase } from '../profile/providers/backend-providers';
import type { AccountCapabilities, FaceVerificationSnapshot, LoginSnapshot, PublicAccountView, RegistrationSnapshot } from './account-types';

export type AccountApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; message?: string; status?: number };

interface ApiErrorBody {
  ok?: boolean;
  reason?: string;
  message?: string;
  error?: string;
}

async function api<T>(path: string, body: unknown): Promise<AccountApiResult<T>> {
  const apiBase = verificationApiBase();
  try {
    const res = await fetch(`${apiBase}/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let payload: Record<string, unknown> | null = null;
    try {
      payload = (await res.json()) as Record<string, unknown>;
    } catch {
      payload = null;
    }
    if (!res.ok || payload === null || payload.ok !== true) {
      const err = (payload ?? {}) as ApiErrorBody;
      return {
        ok: false,
        reason: err.reason ?? err.error ?? 'request-failed',
        message: err.message,
        status: res.status,
      };
    }
    return { ok: true, data: payload as unknown as T };
  } catch {
    return { ok: false, reason: 'network-error', message: 'Could not reach the verification server.' };
  }
}

/** Fetch which account factors the server has configured. */
export async function fetchAccountCapabilities(): Promise<AccountApiResult<AccountCapabilities>> {
  const apiBase = verificationApiBase();
  try {
    const res = await fetch(`${apiBase}/api/v1/account/capabilities`);
    const payload = (await res.json()) as Record<string, unknown>;
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    return {
      ok: true,
      data: {
        smsConfigured: payload.smsConfigured === true,
        whatsappConfigured: payload.whatsappConfigured === true,
        googleConfigured: payload.googleConfigured === true,
        faceVerificationConfigured: payload.faceVerificationConfigured === true,
      },
    };
  } catch {
    return { ok: false, reason: 'network-error', message: 'Could not reach the verification server.' };
  }
}

export interface RegisterPayload {
  readonly walletAddress: string;
  readonly fullName: string;
  readonly aadhaarNumber: string;
  readonly addressOnAadhaar?: string;
  readonly pincode?: string;
  readonly dateOfBirth: string;
  readonly mobile: string;
  readonly password: string;
  readonly passwordConfirm: string;
}

export function registerAccount(payload: RegisterPayload): Promise<AccountApiResult<{ account: PublicAccountView }>> {
  return api('/v1/account/register', payload);
}

export function sendSmsOtp(walletAddress: string): Promise<AccountApiResult<{ ok: true; channel: 'sms'; expiresAt: number }>> {
  return api('/v1/account/otp-sms/send', { walletAddress });
}

export function verifySmsOtp(walletAddress: string, code: string): Promise<AccountApiResult<{ ok: true; channel: 'sms' }>> {
  return api('/v1/account/otp-sms/verify', { walletAddress, code });
}

export function sendWhatsappOtp(walletAddress: string): Promise<AccountApiResult<{ ok: true; channel: 'whatsapp'; expiresAt: number }>> {
  return api('/v1/account/otp-whatsapp/send', { walletAddress });
}

export function verifyWhatsappOtp(walletAddress: string, code: string): Promise<AccountApiResult<{ ok: true; channel: 'whatsapp' }>> {
  return api('/v1/account/otp-whatsapp/verify', { walletAddress, code });
}

/** Begin a secure Google sign-in, returning the state + nonce challenge + real OAuth URL. */
export function beginGoogle(walletAddress: string): Promise<
  AccountApiResult<{ ok: true; state: string; nonce: string; authUrl: string }>
> {
  return api('/v1/account/google/begin', { walletAddress });
}

/**
 * Complete a secure Google sign-in with the challenge state + nonce. The
 * client NEVER sends an authorization code: the code is exchanged and
 * verified entirely server-side at the callback route. The nonce is echoed
 * back from the in-app client — never placed in a URL or persisted locally.
 * The server only accepts a challenge that survived a verified OAuth redirect.
 */
export function completeGoogleWithState(
  walletAddress: string,
  params: { state: string; nonce: string },
): Promise<AccountApiResult<{ account: PublicAccountView }>> {
  return api('/v1/account/google/complete', { ...params, walletAddress });
}

export interface AccountExistence {
  readonly exists: boolean;
  readonly registration: RegistrationSnapshot | null;
  /** Safe login factor snapshot (null for an unknown wallet). */
  readonly login: LoginSnapshot | null;
}

/** Authoritative existence + registration-state check for a wallet. */
export function checkAccountExists(walletAddress: string): Promise<AccountApiResult<AccountExistence>> {
  return api('/v1/account/exists', { walletAddress });
}

/** Safe, server-authoritative login factor snapshot for a wallet. */
export function fetchLoginState(walletAddress: string): Promise<AccountApiResult<{ exists: boolean; login: LoginSnapshot | null }>> {
  return api('/v1/account/login/state', { walletAddress });
}

/**
 * Server-authoritative LOGIN FACE-VERIFICATION stage snapshot for a wallet
 * (Level 3 Part 6). Fail-closed: the server accepts NO self-affirmed "matched"
 * boolean and returns only booleans — never a face, embedding, or biometric
 * value.
 */
export function fetchFaceVerificationState(
  walletAddress: string,
): Promise<AccountApiResult<{ faceVerification: FaceVerificationSnapshot }>> {
  return api('/v1/account/login/face-verification', { walletAddress });
}

/**
 * ⚠️ REMOVED (Part 8): the old `markIdentityVerified` accepted a bare
 * `confirmed:true` and the server set `identityVerified` with NO server-computed
 * evidence. That trust-everything path was removed. There is NO client function
 * that sets `identityVerified` from a boolean anymore — it can only be enabled
 * through real server-side biometric enrollment (see the *Biometric* functions
 * below). This stub is intentionally ABSENT.
 */

/**
 * POST /api/v1/account/biometric/enrollment/begin
 * Begin server-side biometric reference enrollment for the connected account.
 * Returns a single-use, short-TTL enrollment token (never the identity flag).
 */
export async function beginBiometricEnrollment(): Promise<
  AccountApiResult<{ token: string; expiresInMs: number }>
> {
  return api('/v1/account/biometric/enrollment/begin', {});
}

/**
 * POST /api/v1/account/biometric/enrollment/complete
 * Complete enrollment: the server consumes the single-use token, derives +
 * encrypts the reference embedding, and — as the ONLY path — sets
 * `identityVerified=true`. It never trusts a client `matched`/`score`.
 */
export type EnrollmentEmbedding = readonly number[];
export async function completeBiometricEnrollment(
  input: { token: string; consent: boolean; embeddings: readonly EnrollmentEmbedding[] },
): Promise<
  AccountApiResult<{ referenceVersion: number; enrollmentState: 'enrolled'; identityVerified: boolean }>
> {
  return api('/v1/account/biometric/enrollment/complete', input);
}

/**
 * POST /api/v1/account/biometric/verification/begin
 * Issue a single-use, wallet- AND reference-version-bound token used for
 * server-authoritative login face matching.
 */
export async function beginBiometricVerification(
  walletAddress: string,
): Promise<
  AccountApiResult<{ token: string; referenceVersion: number; expiresInMs: number }>
> {
  return api('/v1/account/biometric/verification/begin', { walletAddress });
}

/**
 * POST /api/v1/account/biometric/verification/complete
 * Server-authoritative login face match: the server decrypts the stored
 * reference and compares the live embedding to derive the verdict. Any
 * client-supplied `matched`/`score` is ignored.
 */
export interface BiometricVerdictResult {
  ok: boolean;
  verdict: 'matched' | 'mismatch' | 'insufficient_quality' | 'no_reference'
    | 'reference_revoked' | 'session_invalid' | 'provider_unavailable' | 'error';
  score?: number;
  referenceVersion?: number;
}
export async function completeBiometricVerification(
  input: { verificationToken: string; liveEmbedding: readonly number[] },
): Promise<AccountApiResult<BiometricVerdictResult>> {
  return api('/v1/account/biometric/verification/complete', input);
}

/**
 * Submit COMBINED registration identity evidence (real landmark liveness + live
 * browser location) to the server-authoritative boundary. The server refuses a
 * bare boolean and validates liveness + freshness/accuracy/range of the
 * location fix; raw coordinates are never stored or echoed back.
 */
export interface IdentityEvidencePayload {
  readonly context: 'registration' | 'login';
  readonly livenessPassed: boolean;
  readonly location: {
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly accuracyMeters: number | null;
    readonly timestampMs: number;
    readonly nonce: string;
  };
}

export function submitIdentityEvidence(
  walletAddress: string,
  identityEvidence: IdentityEvidencePayload,
): Promise<AccountApiResult<{ ok: true; accepted: boolean; receivedAtMs: number }>> {
  return api('/v1/account/identity-evidence', { walletAddress, identityEvidence });
}

export function loginAccount(
  walletAddress: string,
  password: string,
): Promise<AccountApiResult<{ session: { accountId: string } }>> {
  return api('/v1/account/login', { walletAddress, password });
}
