// PRIESTATE — Frontend verification provider abstractions.
//
//   ContactVerificationProvider   → EMAIL ownership proof
//     sendEmailOtp() / verifyEmailOtp()
//
//   IdentityVerificationProvider  → AADHAAR-LINKED MOBILE proof
//     startAadhaarMobileVerification() / verifyAadhaarMobileVerification()
//
// Both are backed by the PRIESTATE verification server. The browser
// NEVER sees an OTP, an API key, or any KYC credential — it only ever
// learns whether verification succeeded and the receipt metadata.
// Providers never fabricate success: when the backend or its upstream
// providers are not configured they report `unavailable` and the UI
// shows the honest "currently unavailable" state.

export const VERIFICATION_UNAVAILABLE_MESSAGE = 'Verification service unavailable.';
export const DEMO_MODE_SENT_MESSAGE = 'Demo verification code sent — use 123456 to verify.';
export const AADHAAR_UNAVAILABLE_MESSAGE =
  'Aadhaar-linked mobile verification is not available in this demo.';

// ── Email (contact) ─────────────────────────────────────────────────

export interface EmailOtpChallenge {
  readonly expiresAt: number;
  /** Epoch ms before which "Resend" will be rejected server-side. */
  readonly resendAvailableAt: number;
}

export type SendEmailOtpResult =
  | { ok: true; challenge: EmailOtpChallenge; demoMode?: boolean }
  | {
      ok: false;
      reason: 'unavailable' | 'invalid-email' | 'cooldown' | 'rate-limited' | 'provider-error';
      message?: string;
      retryAfterMs?: number;
    };

export type VerifyEmailOtpResult =
  | { ok: true; verifiedAt: string }
  | { ok: false; reason: 'unavailable' | 'invalid-email' | 'expired' | 'invalid' | 'too-many-attempts'; message?: string };

export interface ContactVerificationProvider {
  sendEmailOtp(email: string): Promise<SendEmailOtpResult>;
  verifyEmailOtp(email: string, code: string): Promise<VerifyEmailOtpResult>;
}

// ── Aadhaar-linked mobile (identity) ────────────────────────────────

/** Server-issued receipt — no Aadhaar numbers, only traceability IDs. */
export interface AadhaarMobileReceipt {
  readonly providerVerificationId: string;
  readonly mobile: string;
  readonly verificationStatus: 'VERIFIED';
  readonly verifiedAt: string;
}

export type StartAadhaarMobileResult =
  | { ok: true; mode: 'verified'; receipt: AadhaarMobileReceipt }
  | { ok: true; mode: 'not-linked'; message: string }
  | { ok: true; mode: 'otp-challenge'; session: { id: string; expiresAt: number }; message: string }
  | {
      ok: false;
      reason: 'unavailable' | 'invalid-mobile' | 'provider-error' | 'rate-limited';
      message?: string;
      retryAfterMs?: number;
    };

export type CompleteAadhaarMobileResult =
  | { ok: true; mode: 'verified'; receipt: AadhaarMobileReceipt }
  | { ok: true; mode: 'not-linked'; message: string }
  | {
      ok: false;
      reason:
        | 'unavailable'
        | 'invalid-session'
        | 'expired'
        | 'invalid-code'
        | 'too-many-attempts'
        | 'provider-error'
        | 'rate-limited';
      message?: string;
    };

export interface IdentityVerificationProvider {
  startAadhaarMobileVerification(mobile: string): Promise<StartAadhaarMobileResult>;
  verifyAadhaarMobileVerification(input: { sessionId: string; code: string }): Promise<CompleteAadhaarMobileResult>;
}
