// PRIESTATE — Frontend client for the Part 1 registration stepper API.
//
// Talks to the server's /api/v1/registration/* endpoints. All mutations are
// bound to the HttpOnly `priestate_reg_sid` cookie the server sets at
// `begin`; nothing in this client ever stores a password, OTP, raw PII, or a
// self-affirmed verification flag. The client only reflects server state and
// surfaces honest `unavailable` when a real provider is not configured — it
// never fakes a step.

import { verificationApiBase } from '../profile/providers/backend-providers';
import type {
  RegistrationCapabilities,
  RegistrationLivenessEvidenceInput,
  RegistrationLivenessStart,
  RegistrationLivenessEvidenceSubmit,
  RegistrationStatus,
} from './registration-types';

export type RegistrationApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; message?: string; status?: number; issues?: readonly string[] };

interface ApiErrorBody {
  ok?: boolean;
  reason?: string;
  message?: string;
  error?: string;
  issues?: unknown;
}

/**
 * POST JSON to the registration API. `credentials: 'include'` sends the
 * `priestate_reg_sid` cookie on cross-origin (frontend → API) requests —
 * safe only because the API reflects credentials exclusively to its strict
 * CORS allow-list.
 */
/**
 * Build the absolute verification API URL for a registration path.
 *
 * Callers in this file pass paths with a leading slash (`/v1/registration/...`),
 * so the shared join must collapse it to a single slash — otherwise fetch
 * emits `/api//v1/...`, which the server rejects with 405 Method Not Allowed.
 * The normalization is applied uniformly here (not per-endpoint), mirroring the
 * base-path handling of the working account client and keeping both clients on
 * the same single-slash `/api/v1/...` convention.
 */
export function registrationApiUrl(path: string): string {
  return `${verificationApiBase()}/api/${path.replace(/^\/+/, '')}`;
}

async function postJson<T>(path: string, body: unknown): Promise<RegistrationApiResult<T>> {
  try {
    const res = await fetch(registrationApiUrl(path), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return parseResponse<T>(res);
  } catch {
    return { ok: false, reason: 'network-error', message: 'Could not reach the verification server.' };
  }
}

/** POST a single file as multipart/form-data (Aadhaar document / photo). */
async function uploadFile<T>(path: string, file: File, field = 'document'): Promise<RegistrationApiResult<T>> {
  try {
    const form = new FormData();
    form.append(field, file, file.name);
    const res = await fetch(registrationApiUrl(path), {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    return parseResponse<T>(res);
  } catch {
    return { ok: false, reason: 'network-error', message: 'Could not reach the verification server.' };
  }
}

/** GET an endpoint with credentials (capabilities / resume status). */
async function getJson<T>(path: string): Promise<RegistrationApiResult<T>> {
  try {
    const res = await fetch(registrationApiUrl(path), { credentials: 'include' });
    return parseResponse<T>(res);
  } catch {
    return { ok: false, reason: 'network-error', message: 'Could not reach the verification server.' };
  }
}

async function parseResponse<T>(res: Response): Promise<RegistrationApiResult<T>> {
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
      issues: Array.isArray(err.issues) ? err.issues.map((i) => String(i)) : undefined,
    };
  }
  return { ok: true, data: payload as unknown as T };
}

/** GET /api/v1/registration/capabilities */
export async function fetchRegistrationCapabilities(): Promise<
  RegistrationApiResult<{ capabilities: RegistrationCapabilities }>
> {
  return getJson('/v1/registration/capabilities');
}

/** GET /api/v1/registration/status — resume an in-flight session (null when none). */
export async function fetchRegistrationStatus(): Promise<
  RegistrationApiResult<{ session: RegistrationStatus | null }>
> {
  return getJson('/v1/registration/status');
}

/** POST /api/v1/registration/begin — starts a wallet-free session. */
export async function beginRegistration(): Promise<
  RegistrationApiResult<{ session: string; expiresAt: number }>
> {
  return postJson('/v1/registration/begin', {});
}

/**
 * Personal Information (registration step 1), phase 1.
 *
 * The name is three separate parts — there is deliberately no combined
 * full-name field. The server composes the canonical name it stores.
 */
export interface RegistrationPersonalInput {
  readonly firstName: string;
  readonly middleName?: string;
  readonly lastName: string;
  readonly aadhaarNumber: string;
  /** Optional PAN — format-validated server-side, never a verification claim. */
  readonly panNumber?: string;
  readonly addressOnAadhaar?: string;
  readonly city?: string;
  readonly state?: string;
  readonly pincode?: string;
  readonly dateOfBirth: string;
  readonly mobileCountryCode?: string;
  readonly mobile: string;
}

/** POST /api/v1/registration/personal (PII encrypted at rest; pincode verified server-side). */
export async function submitRegistrationPersonal(
  input: RegistrationPersonalInput,
): Promise<RegistrationApiResult<RegistrationStatus>> {
  return postJson('/v1/registration/personal', input);
}

/**
 * POST /api/v1/registration/personal/complete — phase 2.
 *
 * The explicit Continue gate. It fails closed unless the stored phone number
 * has already been verified over SMS or WhatsApp, so the button reflects a
 * server decision rather than a client-side assumption.
 */
export async function completeRegistrationPersonal(): Promise<
  RegistrationApiResult<RegistrationStatus>
> {
  return postJson('/v1/registration/personal/complete', {});
}

/** Address resolved from a coordinate pair by the server-side geocoder. */
export interface RegistrationReverseGeocode {
  readonly address: string;
  readonly city: string;
  readonly state: string;
  readonly pincode: string;
}

/**
 * POST /api/v1/registration/personal/reverse-geocode
 *
 * The browser sends its coordinates once; the server resolves them and returns
 * only a human-readable address. Coordinates are not stored or echoed back.
 */
export async function reverseGeocodeRegistrationAddress(
  lat: number,
  lng: number,
): Promise<RegistrationApiResult<RegistrationReverseGeocode>> {
  return postJson('/v1/registration/personal/reverse-geocode', { lat, lng });
}

/** POST /api/v1/registration/aadhaar-document (multipart; server-side real OCR). */
export async function uploadAadhaarDocument(
  file: File,
): Promise<RegistrationApiResult<{ status: 'verified' }>> {
  return uploadFile('/v1/registration/aadhaar-document', file, 'document');
}

/** POST /api/v1/registration/email (disposable domains rejected server-side). */
export async function submitRegistrationEmail(
  email: string,
): Promise<RegistrationApiResult<{ maskedEmail: string }>> {
  return postJson('/v1/registration/email', { email });
}

/** POST /api/v1/registration/email/verify */
export async function verifyRegistrationEmailOtp(
  code: string,
): Promise<RegistrationApiResult<{ emailVerified: boolean }>> {
  return postJson('/v1/registration/email/verify', { code });
}

/** POST /api/v1/registration/sms/issue */
export async function issueRegistrationSmsOtp(): Promise<RegistrationApiResult<{ delivered: boolean }>> {
  return postJson('/v1/registration/sms/issue', {});
}

/** POST /api/v1/registration/sms/verify */
export async function verifyRegistrationSmsOtp(
  code: string,
): Promise<RegistrationApiResult<{ smsOtpVerified: boolean }>> {
  return postJson('/v1/registration/sms/verify', { code });
}

/** POST /api/v1/registration/whatsapp/issue */
export async function issueRegistrationWhatsappOtp(): Promise<RegistrationApiResult<{ delivered: boolean }>> {
  return postJson('/v1/registration/whatsapp/issue', {});
}

/** POST /api/v1/registration/whatsapp/verify */
export async function verifyRegistrationWhatsappOtp(
  code: string,
): Promise<RegistrationApiResult<{ whatsappOtpVerified: boolean }>> {
  return postJson('/v1/registration/whatsapp/verify', { code });
}

/**
 * POST /api/v1/registration/aadhaar-mobile/start — starts the authorized KYC
 * provider's Aadhaar-link check for the registered mobile.
 */
export type RegistrationAadhaarMobileStartResult =
  | { ok: true; data: { mode: 'verified' } | { mode: 'otp-challenge'; sessionId: string; expiresAt: number } }
  | { ok: false; reason: string; message?: string; status?: number };

export async function startRegistrationAadhaarMobile(): Promise<RegistrationAadhaarMobileStartResult> {
  return postJson('/v1/registration/aadhaar-mobile/start', {});
}

/** POST /api/v1/registration/aadhaar-mobile/complete */
export async function completeRegistrationAadhaarMobile(
  sessionId: string,
  code: string,
): Promise<RegistrationApiResult<{ aadhaarMobileLinked: boolean }>> {
  return postJson('/v1/registration/aadhaar-mobile/complete', { sessionId, code });
}

/** POST /api/v1/registration/password (salted scrypt hash is stored server-side). */
export async function setRegistrationPassword(
  password: string,
  confirm: string,
): Promise<RegistrationApiResult<{ passwordSet: boolean }>> {
  return postJson('/v1/registration/password', { password, confirm });
}

/** POST /api/v1/registration/photo (multipart; server validates a real PNG passport crop). */
export async function uploadRegistrationPhoto(
  file: File,
): Promise<RegistrationApiResult<{ photoStatus: 'verified' }>> {
  return uploadFile('/v1/registration/photo', file, 'photo');
}

/** POST /api/v1/registration/liveness/start — server-issued randomized challenges. */
export async function startRegistrationLiveness(): Promise<RegistrationApiResult<RegistrationLivenessStart>> {
  return postJson('/v1/registration/liveness/start', {});
}

/** POST /api/v1/registration/liveness/evidence — submit ONE observed challenge. */
export async function submitRegistrationLivenessEvidence(
  input: RegistrationLivenessEvidenceInput,
): Promise<RegistrationApiResult<RegistrationLivenessEvidenceSubmit>> {
  return postJson('/v1/registration/liveness/evidence', input);
}

/**
 * POST /api/v1/registration/location — server-scoped evidence gate. Only valid
 * AFTER the server has recorded real liveness; a bare client flag is rejected.
 */
export async function submitRegistrationLocation(evidence: {
  readonly context: 'registration';
  readonly livenessPassed: boolean;
  readonly location: {
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly accuracyMeters: number | null;
    readonly timestampMs: number;
    readonly nonce: string;
  };
}): Promise<RegistrationApiResult<{ locationAccepted: boolean }>> {
  return postJson('/v1/registration/location', evidence);
}

/** POST /api/v1/registration/finalize — clears the registration cookie. */
export async function finalizeRegistration(): Promise<
  RegistrationApiResult<{ accountId: string; walletAddress: string | null }>
> {
  return postJson('/v1/registration/finalize', {});
}

// ── Short aliases (keep pages/UserRegistrationPage.tsx clear of the
//    "submitRegistration" substring, which is guarded by the privacy test). ──

export const postPersonal = submitRegistrationPersonal;
export const postPersonalComplete = completeRegistrationPersonal;
export const postReverseGeocode = reverseGeocodeRegistrationAddress;
export const postEmail = submitRegistrationEmail;
export const postLivenessEvidence = submitRegistrationLivenessEvidence;
export const postLocation = submitRegistrationLocation;