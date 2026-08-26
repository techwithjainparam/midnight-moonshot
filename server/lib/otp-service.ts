// PRIESTATE — Server-side OTP service.
//
// Security properties (all enforced HERE, never in the browser):
//   * codes are generated with crypto.randomInt and stored ONLY as an
//     HMAC-SHA256 hash — the raw code exists just long enough to be
//     handed to the delivery transport,
//   * verification compares hashes in constant time,
//   * codes expire after a TTL,
//   * a code is single-use and consumed on success,
//   * wrong attempts are capped; hitting the cap invalidates the code,
//   * re-issuing for the same contact is cooldown-limited,
//   * issuance per contact per rolling hour window is capped,
//   * records are swept automatically once expired.
//
// The raw OTP is never logged and never returned from any API.

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export interface OtpIssueOk {
  readonly ok: true;
  /** The raw one-time code. Handed ONLY to the delivery transport. */
  readonly code: string;
  readonly expiresAt: number;
  /** Epoch ms before which a resend will be rejected. */
  readonly resendAvailableAt: number;
}

export type OtpIssueResult =
  | OtpIssueOk
  | { ok: false; reason: 'cooldown'; retryAfterMs: number }
  | { ok: false; reason: 'rate-limited'; retryAfterMs: number };

export type OtpVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'invalid' | 'too-many-attempts' };

export interface OtpServiceOptions {
  /** Secret used to HMAC the stored code hashes. */
  readonly hashSecret: string;
  readonly ttlMs?: number;
  readonly maxAttempts?: number;
  readonly resendCooldownMs?: number;
  /** Max issuances per key within `sendWindowMs`. */
  readonly maxSendsPerWindow?: number;
  readonly sendWindowMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

interface ActiveOtp {
  readonly codeHash: string;
  readonly expiresAt: number;
  attempts: number;
}

interface SendHistory {
  /** Epoch ms timestamps of recent sends (rolling window). */
  stamps: number[];
  /** Null when this key has never had an issuance. */
  lastSentAt: number | null;
}

export class OtpService {
  /** Namespaced storage key, e.g. OtpService.keyFor('email', 'a@b.c'). */
  static keyFor(scope: string, value: string): string {
    return `${scope}:${value.trim().toLowerCase()}`;
  }

  private readonly active = new Map<string, ActiveOtp>();
  private readonly history = new Map<string, SendHistory>();
  /** OTP lifetime in ms (exposed so the email copy can state it). */
  readonly ttlMs: number;
  private readonly hashSecret: string;
  private readonly maxAttempts: number;
  private readonly resendCooldownMs: number;
  private readonly maxSendsPerWindow: number;
  private readonly sendWindowMs: number;
  private readonly now: () => number;

  constructor(options: OtpServiceOptions) {
    if (!options.hashSecret || options.hashSecret.length < 16) {
      throw new Error(
        'OtpService requires a non-trivial hashSecret (set OTP_HASH_SECRET).',
      );
    }
    this.hashSecret = options.hashSecret;
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.resendCooldownMs = options.resendCooldownMs ?? 60 * 1000;
    this.maxSendsPerWindow = options.maxSendsPerWindow ?? 5;
    this.sendWindowMs = options.sendWindowMs ?? 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Generate + store a hashed code for `key` (e.g. "email:user@x" or
   * "ip:1.2.3.4"). Returns metadata only — never the code itself.
   */
  issue(key: string): OtpIssueResult {
    const t = this.now();
    const hist = this.history.get(key) ?? { stamps: [], lastSentAt: null };

    // Rolling-window cap.
    hist.stamps = hist.stamps.filter((s) => t - s < this.sendWindowMs);
    if (hist.stamps.length >= this.maxSendsPerWindow) {
      const oldest = hist.stamps[0];
      const retryAfterMs = Math.max(0, oldest + this.sendWindowMs - t);
      return { ok: false, reason: 'rate-limited', retryAfterMs };
    }

    // Resend cooldown.
    if (hist.lastSentAt !== null && t - hist.lastSentAt < this.resendCooldownMs) {
      const retryAfterMs = Math.max(0, hist.lastSentAt + this.resendCooldownMs - t);
      return { ok: false, reason: 'cooldown', retryAfterMs };
    }

    // 6-digit numeric code, uniformly random.
    const code = String(randomInt(100_000, 1_000_000));
    this.active.set(key, {
      codeHash: this.hashCode(key, code),
      expiresAt: t + this.ttlMs,
      attempts: 0,
    });

    hist.stamps.push(t);
    hist.lastSentAt = t;
    this.history.set(key, hist);

    const result: OtpIssueOk = {
      ok: true,
      code,
      expiresAt: t + this.ttlMs,
      resendAvailableAt: t + this.resendCooldownMs,
    };
    return result;
  }

  /** Check a user-submitted code. Enforces expiry, attempt cap, one-time use. */
  verify(key: string, submittedCode: string): OtpVerifyResult {
    const t = this.now();
    const entry = this.active.get(key);
    if (!entry) return { ok: false, reason: 'expired' };
    if (t >= entry.expiresAt) {
      this.active.delete(key);
      return { ok: false, reason: 'expired' };
    }

    entry.attempts += 1;
    if (entry.attempts > this.maxAttempts) {
      this.active.delete(key);
      return { ok: false, reason: 'too-many-attempts' };
    }

    const matches = this.safeEqual(this.hashCode(key, submittedCode.trim()), entry.codeHash);
    if (!matches) {
      if (entry.attempts >= this.maxAttempts) {
        this.active.delete(key);
        return { ok: false, reason: 'too-many-attempts' };
      }
      return { ok: false, reason: 'invalid' };
    }

    // Single-use: consume on success.
    this.active.delete(key);
    return { ok: true };
  }

  /** Remaining cooldown ms for a key (used by clients to disable Resend). */
  cooldownRemainingMs(key: string): number {
    const t = this.now();
    const hist = this.history.get(key);
    if (!hist || hist.lastSentAt === null) return 0;
    return Math.max(0, hist.lastSentAt + this.resendCooldownMs - t);
  }

  /** Drop expired entries; called periodically by the server loop. */
  sweep(): void {
    const t = this.now();
    for (const [key, entry] of this.active) {
      if (t >= entry.expiresAt) this.active.delete(key);
    }
    for (const [key, hist] of this.history) {
      if (hist.stamps.length === 0 || hist.stamps.every((s) => t - s >= this.sendWindowMs)) {
        this.history.delete(key);
      }
    }
  }

  clear(): void {
    this.active.clear();
    this.history.clear();
  }

  private hashCode(key: string, code: string): string {
    return createHmac('sha256', this.hashSecret).update(`${key}:${code}`).digest('hex');
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }
}
