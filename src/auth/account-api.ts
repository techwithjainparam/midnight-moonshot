// PRIESTATE — Frontend client for the Level 3 account API.
//
// Talks to the verification server's /api/v1/account/* endpoints. The client
// NEVER sends raw PII it should not (the server is the boundary) and NEVER
// persists passwords or OTP codes. When the server reports a capability as
// unavailable (no real SMS/WhatsApp/Google gateway configured), this client
// surfaces an honest `unavailable` state — it never fakes a factor.

import { verificationApiBase } from '../profile/providers/backend-providers';
import type { AccountCapabilities, LoginSnapshot, PublicAccountView, RegistrationSnapshot } from './account-types';

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

export function completeGoogle(walletAddress: string, authCode: string): Promise<AccountApiResult<{ account: PublicAccountView }>> {
  return api('/v1/account/google/complete', { walletAddress, authCode });
}

/** Begin a secure Google sign-in, returning the state + nonce challenge. */
export function beginGoogle(walletAddress: string): Promise<
  AccountApiResult<{ ok: true; state: string; nonce: string; authUrl: string }>
> {
  return api('/v1/account/google/begin', { walletAddress });
}

/**
 * Complete a secure Google sign-in with the challenge state + nonce. The
 * nonce is echoed back from the in-app client — never placed in a URL.
 */
export function completeGoogleWithState(
  walletAddress: string,
  params: { state: string; nonce: string; code: string },
): Promise<AccountApiResult<{ account: PublicAccountView }>> {
  return api('/v1/account/google/complete', { ...params, authCode: params.code, walletAddress });
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

export function markIdentityVerified(walletAddress: string, confirmed: boolean): Promise<AccountApiResult<{ account: PublicAccountView }>> {
  return api('/v1/account/identity-verified', { walletAddress, confirmed });
}

export function loginAccount(
  walletAddress: string,
  password: string,
): Promise<AccountApiResult<{ session: { accountId: string } }>> {
  return api('/v1/account/login', { walletAddress, password });
}
