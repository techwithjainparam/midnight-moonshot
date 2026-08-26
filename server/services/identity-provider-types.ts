// PRIESTATE — IdentityVerificationProvider (server-side abstraction).
//
// REAL Aadhaar-linked mobile verification. A normal SMS OTP proves
// possession of a phone number; it does NOT prove that number is linked
// to an Aadhaar identity. Only an AUTHORIZED identity/KYC provider
// (UIDAI-licensed ecosystem, e.g. Surepass / Karza / Signzy / IDfy /
// Protean) can answer "does this mobile belong to this Aadhaar?".
//
// Contract:
//   startAadhaarMobileVerification(mobile)
//     → 'verified'      provider directly confirms the link (link-check
//                       APIs), returns a receipt,
//     → 'not-linked'    provider definitively answers NO,
//     → 'otp-challenge' provider challenges the REGISTERED mobile with
//                       its own OTP; call completeAadhaarMobileVerification()
//                       with the user-entered code to finish,
//     → 'unavailable'   no authorized provider is configured — callers
//                       must show "currently unavailable" and NEVER fake
//                       success.
//
// Receipts carry only providerVerificationId + status + timestamps.
// Aadhaar numbers are never requested, never stored, never echoed.

export interface AadhaarMobileReceipt {
  readonly providerVerificationId: string;
  /** Normalized E.164 mobile that was verified. */
  readonly mobile: string;
  readonly verificationStatus: 'VERIFIED';
  readonly verifiedAt: string;
}

export type StartAadhaarMobileResult =
  | { ok: true; mode: 'verified'; receipt: AadhaarMobileReceipt }
  | { ok: true; mode: 'not-linked'; message: string }
  | {
      ok: true;
      mode: 'otp-challenge';
      session: { readonly id: string; readonly expiresAt: number };
      message: string;
    }
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
        | 'rate-limited'
        | 'invalid-mobile';
      message?: string;
      retryAfterMs?: number;
    };

export interface IdentityVerificationProvider {
  /** Stable identifier recorded in receipts for traceability. */
  readonly name: string;
  /**
   * True ONLY when real authorized-provider credentials are configured.
   * When false the API reports the feature as unavailable; it never
   * falls back to a mock in production flows.
   */
  readonly available: boolean;
  startAadhaarMobileVerification(mobileRaw: string): Promise<StartAadhaarMobileResult>;
  verifyAadhaarMobileVerification(input: {
    sessionId: string;
    code: string;
  }): Promise<CompleteAadhaarMobileResult>;
}
