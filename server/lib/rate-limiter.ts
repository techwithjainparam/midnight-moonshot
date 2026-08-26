// PRIESTATE — Simple rolling-window rate limiter (per key).
//
// Used to cap expensive operations (OTP email delivery, paid KYC API
// calls) per contact value and per client IP. In-memory by design for
// this single-process deployment; swap for a Redis-backed implementation
// when scaling horizontally.

export interface RateLimiterOptions {
  readonly maxEvents: number;
  readonly windowMs: number;
  readonly now?: () => number;
}

export class RateLimiter {
  private readonly events = new Map<string, number[]>();
  private readonly maxEvents: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.maxEvents = options.maxEvents;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record an event for `key`. Returns whether it is allowed and, when
   * rejected, how long until capacity frees up.
   */
  take(key: string): { allowed: boolean; retryAfterMs: number } {
    const t = this.now();
    const stamps = (this.events.get(key) ?? []).filter((s) => t - s < this.windowMs);
    if (stamps.length >= this.maxEvents) {
      const retryAfterMs = Math.max(0, stamps[0] + this.windowMs - t);
      this.events.set(key, stamps);
      return { allowed: false, retryAfterMs };
    }
    stamps.push(t);
    this.events.set(key, stamps);
    return { allowed: true, retryAfterMs: 0 };
  }

  sweep(): void {
    const t = this.now();
    for (const [key, stamps] of this.events) {
      const alive = stamps.filter((s) => t - s < this.windowMs);
      if (alive.length === 0) this.events.delete(key);
      else this.events.set(key, alive);
    }
  }

  clear(): void {
    this.events.clear();
  }
}
