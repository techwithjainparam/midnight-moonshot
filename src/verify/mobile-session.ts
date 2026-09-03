// PRIESTATE — Desktop→mobile identity verification fallback (Level 3).
//
// When the desktop has no usable camera, the UI offers "Continue verification
// on phone": a short-lived, single-use session link (shown as a URL the user
// can scan/key in). The link carries only an opaque session token + wallet
// address — NO PII (no Aadhaar, no photo, no DOB) is ever placed in the QR or
// the URL. The mobile side re-uses the same IdentityVerificationPage flow.

import { randomHex } from './randomBytes';

export interface MobileSession {
  readonly token: string;
  readonly walletAddress: string;
  readonly expiresAt: number;
  used: boolean;
}

const TTL_MS = 5 * 60 * 1000;

const sessions = new Map<string, MobileSession>();

/**
 * Create a single-use, short-lived carry-over session for a wallet. The
 * token is random (128-bit) and stores nothing sensitive.
 */
export function createMobileSession(walletAddress: string): MobileSession {
  const token = randomHex(16);
  const session: MobileSession = {
    token,
    walletAddress,
    expiresAt: Date.now() + TTL_MS,
    used: false,
  };
  sessions.set(token, session);
  return session;
}

/** The carry-over URL (only token + wallet, no PII). */
export function mobileSessionUrl(session: MobileSession, base = location.origin): string {
  const q = new URLSearchParams({ mobileSession: session.token, wallet: session.walletAddress });
  return `${base}/identity-verification?${q.toString()}`;
}

/**
 * Consume a session token exactly once. Returns the wallet address (and marks
 * it used) only when the token exists, is unexpired, and not already consumed.
 * Never returns PII.
 */
export function redeemMobileSession(token: string): { ok: true; walletAddress: string } | { ok: false; reason: 'expired' | 'used' | 'invalid' } {
  const session = sessions.get(token);
  if (!session) return { ok: false, reason: 'invalid' };
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return { ok: false, reason: 'expired' };
  }
  if (session.used) return { ok: false, reason: 'used' };
  session.used = true;
  return { ok: true, walletAddress: session.walletAddress };
}

export function isMobileSessionExpired(session: MobileSession): boolean {
  return Date.now() > session.expiresAt;
}
