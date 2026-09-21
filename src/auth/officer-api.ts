// PRIESTATE — Frontend client for the server-backed officer credential API.
//
// Talks to /api/v1/officer/auth/* endpoints. Uses SEPARATE
// `priestate_officer_sid` HttpOnly cookie (the server sets it), so
// credentials: 'include' sends it on cross-origin requests.
//
// Nothing here stores passwords, tokens, or PII — the session is entirely
// server-side, and this client never self-asserts an officer role.

import { verificationApiBase } from '../profile/providers/backend-providers';

export type OfficerApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; message?: string; status?: number };

interface ApiErrorBody {
  ok?: boolean;
  reason?: string;
  message?: string;
  error?: string;
}

export interface PublicOfficerView {
  readonly officerId: string;
  readonly displayName: string;
  readonly createdAt: number;
}

export interface OfficerCapabilities {
  readonly registrationAvailable: boolean;
  readonly loginAvailable: boolean;
}

async function api<T>(path: string, body?: unknown): Promise<OfficerApiResult<T>> {
  const apiBase = verificationApiBase();
  try {
    const opts: RequestInit = {
      method: body !== undefined ? 'POST' : 'GET',
      credentials: 'include',
    };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${apiBase}/api/v1/officer/auth${path}`, opts);
    let payload: Record<string, unknown> | null = null;
    try { payload = (await res.json()) as Record<string, unknown>; } catch { payload = null; }
    if (!res.ok || payload === null || payload.ok !== true) {
      const err = (payload ?? {}) as ApiErrorBody;
      return { ok: false, reason: err.reason ?? err.error ?? 'request-failed', message: err.message, status: res.status };
    }
    return { ok: true, data: payload as unknown as T };
  } catch {
    return { ok: false, reason: 'network-error', message: 'Could not reach the verification server.' };
  }
}

/** Fetch officer capabilities (registration available / login available). */
export function fetchOfficerCapabilities(): Promise<OfficerApiResult<{ capabilities: OfficerCapabilities }>> {
  return api('/capabilities');
}

/** Current server-backed officer (or 401). */
export function fetchOfficerMe(): Promise<OfficerApiResult<{ officer: PublicOfficerView; capabilities: OfficerCapabilities }>> {
  return api('/me');
}

export interface OfficerRegisterPayload {
  readonly displayName: string;
  readonly password: string;
  readonly passwordConfirm: string;
  readonly registrationCode: string;
}

export function registerOfficer(payload: OfficerRegisterPayload): Promise<
  OfficerApiResult<{ officer: PublicOfficerView; capabilities: OfficerCapabilities }>
> {
  return api('/register', payload);
}

export function loginOfficer(displayName: string, password: string): Promise<
  OfficerApiResult<{ officer: PublicOfficerView; capabilities: OfficerCapabilities }>
> {
  return api('/login', { displayName, password });
}

export function logoutOfficer(): Promise<OfficerApiResult<{ ok: true }>> {
  return api('/logout');
}
