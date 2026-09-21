// PRIESTATE — Forgot-password recovery (server-side only).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Reset flow — the server verifies THREE gates IN ORDER, and only after all
// three pass may a new password be set for the wallet:
//
//   1. E-mail OTP  — the address must be the account's VERIFIED registration
//                    e-mail (checked against the encrypted account PII on the
//                    server). Disposable domains are rejected.
//   2. Liveness    — the same real, random challenge stream the registration
//                    flow uses (blink, head movement, hand up, finger count,
//                    spoken phrase), validated in order on the server.
//   3. Biometric   — the account's enrolled biometric reference must MATCH a
//                    live embedding (real cosine similarity, single-use token,
//                    version-bound). This proves ownership of the account.
//
// Only then is the password re-hashed (fresh salt, scrypt) and every existing
// session destroyed.
//
// Anti-enumeration: `begin` returns the SAME response whether or not an
// account exists for the e-mail/wallet pair — an unregistered pair simply
// gets NO code delivered and no recoverable session. Resets bind to the
// wallet, so a would-be attacker still cannot complete the biometric gate.
//
// Nothing here ever reaches the Midnight ledger.

import { normalizeEmail } from '../lib/validation.js';
import { maskEmail, passwordIssues } from '../account/model.js';
import type { AccountService } from '../account/service.js';
import type { DisposableEmailChecker } from '../services/disposable-email.js';
import type { Mailer } from '../lib/mailer.js';
import { otpEmailHtml, otpEmailText } from '../lib/mailer.js';
import { OtpService } from '../lib/otp-service.js';
import type { LivenessService, LivenessEvidenceInput } from './liveness.js';
import type {
  ForgotPasswordSession,
  ForgotPasswordSessionStore,
} from './session-store.js';

export type ForgotPasswordFailure = {
  readonly ok: false;
  readonly reason:
    | 'unavailable'
    | 'not-found'
    | 'bad-state'
    | 'invalid-input'
    | 'provider-error'
    | 'mismatch'
    | 'no-reference'
    | 'revoked';
  readonly message?: string;
  readonly issues?: readonly string[];
};

export type ForgotPasswordResult<T> = { ok: true; value: T } | ForgotPasswordFailure;

export interface ForgotPasswordServiceOptions {
  readonly store: ForgotPasswordSessionStore;
  readonly accounts: AccountService;
  readonly mailer: Mailer | null;
  readonly otp: { readonly hashSecret: string };
  readonly liveness: LivenessService;
  readonly disposableEmail: DisposableEmailChecker;
  readonly sessionTtlMs?: number;
  readonly now?: () => number;
}

const WALLET_RE = /^0x[a-fA-F0-9]{64}$/;

export class ForgotPasswordService {
  private readonly store: ForgotPasswordSessionStore;
  private readonly accounts: AccountService;
  private readonly mailer: Mailer | null;
  private readonly emailOtp: OtpService;
  private readonly liveness: LivenessService;
  private readonly disposableEmail: DisposableEmailChecker;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;

  constructor(options: ForgotPasswordServiceOptions) {
    this.store = options.store;
    this.accounts = options.accounts;
    this.mailer = options.mailer;
    this.liveness = options.liveness;
    this.disposableEmail = options.disposableEmail;
    this.sessionTtlMs = options.sessionTtlMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.emailOtp = new OtpService({ hashSecret: options.otp.hashSecret, now: options.now });
  }

  get emailConfigured(): boolean {
    return this.mailer !== null;
  }

  /**
   * Anti-enumeration: ALWAYS answers `started` with a masked e-mail. A code is
   * only actually sent when the wallet + e-mail pair matches a VERIFIED,
   * identity-complete account (so the biometric gate can be satisfied later).
   */
  async begin(
    walletAddress: string,
    emailRaw: string,
  ): Promise<ForgotPasswordResult<{ status: 'started'; maskedEmail: string }>> {
    if (!WALLET_RE.test(walletAddress)) {
      return { ok: false, reason: 'invalid-input', issues: ['A valid wallet address is required.'] };
    }
    const email = normalizeEmail(emailRaw);
    if (!email) return { ok: false, reason: 'invalid-input', issues: ['Enter a valid email address.'] };
    const disposable = this.disposableEmail.check(email);
    if (disposable.blocked) {
      return { ok: false, reason: 'invalid-input', issues: ['Disposable email addresses are not accepted.'] };
    }
    const maskedEmail = maskEmail(email);
    if (!this.mailer) return { ok: false, reason: 'unavailable', message: 'Password recovery is not configured.' };

    const match = this.accounts.findAccountByEmail(email);
    // Uniform response whether the pair exists or not (no account oracle).
    if (!match || match.walletAddress !== walletAddress) {
      return { ok: true, value: { status: 'started', maskedEmail } };
    }

    const issued = this.emailOtp.beginIssue(OtpService.keyFor('forgot-email', walletAddress));
    if (!issued.ok) {
      return {
        ok: false,
        reason: 'provider-error',
        message: issued.reason === 'cooldown'
          ? 'Please wait before requesting another code.'
          : 'Too many codes requested. Try again later.',
      };
    }

    try {
      await this.mailer.send({
        to: email,
        subject: 'PRIESTATE password reset code',
        text: otpEmailText(issued.code, Math.max(1, Math.round(this.emailOtp.ttlMs / 60_000))),
        html: otpEmailHtml(issued.code, Math.max(1, Math.round(this.emailOtp.ttlMs / 60_000))),
      });
    } catch {
      return { ok: false, reason: 'provider-error', message: 'Could not send the reset email. Try again shortly.' };
    }
    const committed = this.emailOtp.commitIssue(
      OtpService.keyFor('forgot-email', walletAddress),
      issued.code,
      issued.expiresAt,
    );
    if (!committed.ok) return { ok: false, reason: 'provider-error', message: 'Too many codes requested. Try again later.' };

    const now = this.now();
    this.store.destroy(walletAddress);
    const session: ForgotPasswordSession = {
      walletAddress,
      emailVerified: false,
      livenessPassed: false,
      biometricVerified: false,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    };
    this.store.create(session);
    return { ok: true, value: { status: 'started', maskedEmail } };
  }

  verifyEmailOtp(walletAddress: string, code: string): ForgotPasswordResult<{ emailVerified: boolean }> {
    const session = this.mustLoad(walletAddress);
    if (session === null) return { ok: false, reason: 'not-found' };
    const result = this.emailOtp.verify(OtpService.keyFor('forgot-email', walletAddress), code);
    if (!result.ok) {
      if (result.reason === 'invalid') {
        return { ok: false, reason: 'invalid-input', issues: ['That code is incorrect. Try again.'] };
      }
      return { ok: false, reason: 'bad-state', message: 'That code expired or was used too many times. Request a new one.' };
    }
    this.store.update(walletAddress, { emailVerified: true });
    return { ok: true, value: { emailVerified: true } };
  }

  livenessStart(
    walletAddress: string,
  ): ForgotPasswordResult<{ challenges: readonly import('./liveness.js').LivenessChallenge[]; expiresInMs: number }> {
    const session = this.mustLoad(walletAddress);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (!session.emailVerified) return { ok: false, reason: 'bad-state', message: 'Verify your email first.' };
    if (session.livenessPassed) {
      return { ok: false, reason: 'bad-state', message: 'Liveness was already completed.' };
    }
    const started = this.liveness.start(`forgot:${walletAddress}`);
    return { ok: true, value: { challenges: started.challenges, expiresInMs: started.expiresInMs } };
  }

  livenessEvidence(
    walletAddress: string,
    input: LivenessEvidenceInput,
  ): ForgotPasswordResult<{ progress: import('./liveness.js').LivenessProgress; livenessPassed: boolean }> {
    const session = this.mustLoad(walletAddress);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (!session.emailVerified) return { ok: false, reason: 'bad-state', message: 'Verify your email first.' };
    const result = this.liveness.evidence(`forgot:${walletAddress}`, input);
    if (!result.ok) {
      const message = this.livenessMessage(result.verdict ?? 'invalid');
      return { ok: false, reason: message === 'Retry the current challenge.' ? 'bad-state' : 'mismatch', message };
    }
    if (result.progress.done) {
      this.store.update(walletAddress, { livenessPassed: true });
    }
    return { ok: true, value: { progress: result.progress, livenessPassed: result.progress.done } };
  }

  biometricStart(
    walletAddress: string,
  ): ForgotPasswordResult<{ token: string; referenceVersion: number; expiresInMs: number }> {
    const session = this.mustLoad(walletAddress);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (!session.emailVerified || !session.livenessPassed) {
      return { ok: false, reason: 'bad-state', message: 'Complete email and liveness verification first.' };
    }
    const result = this.accounts.beginBiometricVerification(walletAddress);
    if (!result.ok) {
      const map: Record<string, ForgotPasswordFailure['reason']> = {
        unavailable: 'unavailable',
        'not-found': 'not-found',
        'no-reference': 'no-reference',
        revoked: 'revoked',
      };
      return { ok: false, reason: map[result.reason] ?? 'unavailable' };
    }
    return {
      ok: true,
      value: {
        token: result.token,
        referenceVersion: result.referenceVersion,
        expiresInMs: result.expiresInMs,
      },
    };
  }

  biometricVerify(
    walletAddress: string,
    input: { verificationToken: string; liveEmbedding: readonly number[] },
  ): ForgotPasswordResult<{ biometricVerified: boolean; score: number }> {
    const session = this.mustLoad(walletAddress);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (!session.emailVerified || !session.livenessPassed) {
      return { ok: false, reason: 'bad-state', message: 'Complete email and liveness verification first.' };
    }
    const result = this.accounts.verifyBiometricMatch(walletAddress, {
      verificationToken: input.verificationToken,
      liveEmbedding: input.liveEmbedding,
    });
    if (!result.ok) {
      return { ok: false, reason: 'mismatch', message: 'The live face did not match the enrolled reference.' };
    }
    if (result.verdict === 'mismatch') {
      return { ok: false, reason: 'mismatch', message: 'The live face did not match the enrolled reference.' };
    }
    this.store.update(walletAddress, { biometricVerified: true });
    return { ok: true, value: { biometricVerified: true, score: result.score } };
  }

  reset(
    walletAddress: string,
    input: { newPassword: string; confirmPassword: string },
  ): ForgotPasswordResult<{ passwordReset: boolean }> {
    const session = this.mustLoad(walletAddress);
    if (session === null) return { ok: false, reason: 'not-found' };
    if (!session.emailVerified || !session.livenessPassed || !session.biometricVerified) {
      return {
        ok: false,
        reason: 'bad-state',
        message: 'All verification steps must be completed before resetting the password.',
      };
    }
    if (input.newPassword !== input.confirmPassword) {
      return { ok: false, reason: 'invalid-input', issues: ['Passwords do not match.'] };
    }
    const pii = this.accounts.decryptPii(walletAddress);
    const issues = passwordIssues(input.newPassword, {
      mobile: pii.ok ? pii.pii.mobileE164 : '',
      aadhaarNumber: pii.ok ? pii.pii.aadhaarNumber : '',
      fullName: pii.ok ? pii.pii.fullName : '',
    });
    if (issues.length > 0) {
      return { ok: false, reason: 'invalid-input', issues: issues.map((i) => `Password needs ${i}.`) };
    }
    const result = this.accounts.resetPassword(walletAddress, input.newPassword);
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason === 'not-found' ? 'not-found' : 'unavailable',
        message: 'The password could not be reset. Try again shortly.',
      };
    }
    this.store.destroy(walletAddress);
    this.liveness.clear(`forgot:${walletAddress}`);
    return { ok: true, value: { passwordReset: true } };
  }

  purgeExpired(now: number): number {
    return this.store.purgeExpired(now);
  }

  private mustLoad(walletAddress: string): ForgotPasswordSession | null {
    const session = this.store.get(walletAddress);
    if (!session) return null;
    if (session.expiresAt < this.now()) {
      this.store.destroy(walletAddress);
      return null;
    }
    return session;
  }

  private livenessMessage(verdict: string): string {
    switch (verdict) {
      case 'phrase-mismatch':
        return 'The spoken phrase did not match. Try again.';
      case 'count-mismatch':
        return 'The finger count did not match. Try again.';
      case 'wrong-order':
        return 'Complete the current challenge first.';
      case 'duplicate':
        return 'That challenge was already completed.';
      case 'expired':
        return 'The liveness session expired. Start it again.';
      case 'not-started':
        return 'Start the liveness session first.';
      default:
        return 'Retry the current challenge.';
    }
  }
}