// PRIESTATE — ContactVerificationProvider (server-side implementation).
//
// REAL email OTP verification:
//   sendEmailOtp(email)    → issues a server-generated code and delivers
//                            it to the user's inbox via the configured
//                            Mailer (production: authenticated SMTP).
//   verifyEmailOtp(email, code) → checks the user-entered code against
//                            the hashed, expiring record server-side.
//
// Guarantees enforced here (never in the browser):
//   * the raw OTP never leaves this module except into the Mailer,
//   * it is stored only as an HMAC hash with TTL/attempt/cooldown/rate
//     limits (see ./lib/otp-service.ts),
//   * when no mail transport is configured the provider reports
//     `unavailable` — it NEVER fakes a successful delivery.

import type { Mailer } from '../lib/mailer';
import { otpEmailHtml, otpEmailText } from '../lib/mailer';
import { OtpService } from '../lib/otp-service';
import { normalizeEmail } from '../lib/validation';

export interface EmailOtpChallenge {
  readonly expiresAt: number;
  /** Epoch ms before which another send is rejected (resend cooldown). */
  readonly resendAvailableAt: number;
}

export type SendEmailOtpResult =
  | { ok: true; challenge: EmailOtpChallenge }
  | {
      ok: false;
      reason: 'unavailable' | 'invalid-email' | 'cooldown' | 'rate-limited' | 'provider-error';
      message?: string;
      retryAfterMs?: number;
    };

export type VerifyEmailOtpResult =
  | { ok: true; verifiedAt: string }
  | { ok: false; reason: 'unavailable' | 'invalid-email' | 'expired' | 'invalid' | 'too-many-attempts' };

export interface ContactVerificationProviderOptions {
  readonly mailer: Mailer | null;
  readonly otpService: OtpService;
  /** OTP lifetime in whole minutes — used in the email copy. */
  readonly ttlMinutes?: number;
}

export class SmtpEmailContactProvider {
  readonly name = 'smtp-email-otp';

  private readonly mailer: Mailer | null;
  private readonly otp: OtpService;
  private readonly ttlMinutes: number;

  constructor(options: ContactVerificationProviderOptions) {
    this.mailer = options.mailer;
    this.otp = options.otpService;
    this.ttlMinutes = options.ttlMinutes ?? Math.max(1, Math.round(options.otpService.ttlMs / 60_000));
  }

  get configured(): boolean {
    return this.mailer !== null;
  }

  async sendEmailOtp(emailRaw: string): Promise<SendEmailOtpResult> {
    if (!this.mailer) {
      return { ok: false, reason: 'unavailable', message: 'Verification service unavailable.' };
    }
    const email = normalizeEmail(emailRaw);
    if (!email) {
      return { ok: false, reason: 'invalid-email', message: 'Enter a valid email address.' };
    }

    const issued = this.otp.issue(OtpService.keyFor('email', email));
    if (!issued.ok) {
      return issued.reason === 'cooldown'
        ? { ok: false, reason: 'cooldown', retryAfterMs: issued.retryAfterMs,
            message: `Please wait before requesting another code.` }
        : { ok: false, reason: 'rate-limited', retryAfterMs: issued.retryAfterMs,
            message: 'Too many codes requested for this address. Try again later.' };
    }

    try {
      await this.mailer.send({
        to: email,
        subject: 'PRIESTATE verification code',
        text: otpEmailText(issued.code, this.ttlMinutes),
        html: otpEmailHtml(issued.code, this.ttlMinutes),
      });
    } catch {
      // Delivery failure must not leak transport details; the code stays
      // valid but the client may retry after the cooldown.
      return { ok: false, reason: 'provider-error', message: 'Could not send the verification email. Try again shortly.' };
    }

    return { ok: true, challenge: { expiresAt: issued.expiresAt, resendAvailableAt: issued.resendAvailableAt } };
  }

  async verifyEmailOtp(emailRaw: string, code: string): Promise<VerifyEmailOtpResult> {
    const email = normalizeEmail(emailRaw);
    if (!email) return { ok: false, reason: 'invalid-email' };
    const result = this.otp.verify(OtpService.keyFor('email', email), code);
    if (!result.ok) return result;
    return { ok: true, verifiedAt: new Date().toISOString() };
  }
}
