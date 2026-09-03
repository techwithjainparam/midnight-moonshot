// PRIESTATE — Google OAuth provider boundary (registration authentication).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// This module models the Google login factor as a REAL OAuth provider
// boundary, never as a fabricated success:
//
//   * credentials (client id / secret) live only in server env vars and are
//     never exposed to the browser,
//   * `begin()` issues a fresh cryptographically-random `state` + `nonce`
//     bound to the initiating wallet, with a short TTL and single use,
//   * `complete()` REQUIRES the state and nonce, validates they match the
//     stored challenge for that wallet, are not expired and not already
//     consumed, and only then hands the authorization code to the underlying
//     `exchange` step to verify against Google,
//   * if no real Google credentials are configured, the provider is
//     `configured: false` and both `begin` and `complete` report `unavailable`
//     (fail closed) — we never invent a successful Google login.
//
// Nothing here persists tokens/secrets to disk, localStorage, URLs, logs, or
// the Midnight ledger.

import { randomBytes } from 'node:crypto';

export const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface GoogleProviderConfig {
  /** True only when real Google OAuth credentials are configured. */
  readonly configured?: boolean;
  /**
   * Low-level exchange: verify an authorization code with Google and return
   * true on a valid token for the expected audience. When no live provider is
   * wired this is never invoked (fail closed).
   */
  readonly exchange?: (code: string) => boolean;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

export interface GoogleChallenge {
  readonly wallet: string;
  readonly state: string;
  readonly nonce: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  consumed: boolean;
}

export type GoogleBeginResult =
  | { ok: true; state: string; nonce: string; authUrl: string }
  | { ok: false; reason: 'unavailable' };

export type GoogleCompleteResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'bad-state' | 'expired' | 'replay' | 'unauthorized' };

/**
 * Server-side Google OAuth session manager. Holds per-wallet challenge state
 * in memory; an attacker without the returned nonce cannot complete the flow.
 */
export class GoogleProvider {
  readonly configured: boolean;
  private readonly exchange: (code: string) => boolean;
  private readonly now: () => number;
  private readonly challenges = new Map<string, GoogleChallenge>();

  constructor(config: GoogleProviderConfig = {}) {
    this.configured = config.configured ?? false;
    this.exchange = config.exchange ?? (() => false);
    this.now = config.now ?? Date.now;
  }

  private token(): string {
    return randomBytes(24).toString('hex');
  }

  /**
   * Start a Google sign-in for `wallet`. Returns the opaque `state` (to be
   * echoed through the OAuth redirect) and the `nonce` (kept out of the
   * redirect/callback URLs — returned to the in-app client only).
   */
  begin(wallet: string): GoogleBeginResult {
    if (!this.configured) return { ok: false, reason: 'unavailable' };
    const t = this.now();
    const state = this.token();
    const nonce = this.token();
    this.challenges.set(state, {
      wallet,
      state,
      nonce,
      createdAt: t,
      expiresAt: t + GOOGLE_STATE_TTL_MS,
      consumed: false,
    });
    // authUrl is intentionally only exposed in tests/production config; no
    // credentials are embedded here.
    return { ok: true, state, nonce, authUrl: this.authUrl(state) };
  }

  /**
   * Complete a Google sign-in. Validates that the presented state matches a
   * live, unconsumed challenge bound to `wallet`, that the nonce matches, and
   * that the challenge has not expired. Only then is the authorization code
   * exchanged with the underlying provider.
   */
  complete(wallet: string, params: { state: string; nonce: string; code: string }): GoogleCompleteResult {
    if (!this.configured) return { ok: false, reason: 'unavailable' };
    const challenge = this.challenges.get(params.state);
    if (!challenge) return { ok: false, reason: 'bad-state' };
    if (challenge.consumed) return { ok: false, reason: 'replay' };
    if (challenge.wallet !== wallet) return { ok: false, reason: 'bad-state' };
    if (this.now() >= challenge.expiresAt) {
      this.challenges.delete(params.state);
      return { ok: false, reason: 'expired' };
    }
    // Consume single-use challenge BEFORE the (potentially slow) exchange so a
    // replay during the exchange is rejected.
    challenge.consumed = true;

    if (!params.nonce || !this.safeEqual(params.nonce, challenge.nonce)) {
      return { ok: false, reason: 'bad-state' };
    }
    const ok = this.exchange(params.code);
    if (ok) {
      this.challenges.delete(params.state);
      return { ok: true };
    }
    return { ok: false, reason: 'unauthorized' };
  }

  /** Build the Google OAuth authorization URL (no credentials embedded). */
  private authUrl(state: string): string {
    // In a real deployment this would point at Google's OAuth endpoint with
    // the server-side client id and the state. The nonce is NEVER in the URL.
    return `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`;
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    return bufA.length === bufB.length && bufA.equals(bufB);
  }

  /** Remove expired challenges; called periodically. */
  sweep(): void {
    const t = this.now();
    for (const [state, challenge] of this.challenges) {
      if (t >= challenge.expiresAt) this.challenges.delete(state);
    }
  }
}
