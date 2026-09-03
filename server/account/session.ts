// PRIESTATE — Server-side session management.
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Sessions use cryptographically random 32-byte tokens encoded as hex.
// No PII is included in the session token or cookie — only the opaque
// token is set.  Sessions are stored in SQLite and expire after a
// configurable TTL (default 24 hours).
//
// Cookie: SameSite=Lax, HttpOnly, Secure (when not localhost).

import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const SESSION_COOKIE_NAME = 'priestate_sid';
export const SESSION_TOKEN_BYTES = 32;

export interface Session {
  readonly sessionId: string;
  readonly accountId: string;
  readonly walletAddress: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface SessionRow {
  session_id: string;
  account_id: string;
  wallet_address: string;
  created_at: number;
  expires_at: number;
}

function rowToSession(r: SessionRow): Session {
  return {
    sessionId: r.session_id,
    accountId: r.account_id,
    walletAddress: r.wallet_address,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

export interface SessionServiceConfig {
  /** Path to the Set-Cookie / parsed cookie header. */
  readonly cookieDomain?: string;
  /** Whether to set the Secure flag (true in production over HTTPS). */
  readonly secure?: boolean;
  /** Session lifetime in ms. Default 24h. */
  readonly ttlMs?: number;
}

export class SessionService {
  private readonly ttlMs: number;
  private readonly secure: boolean;
  private readonly insertStmt: Database.Statement;
  private readonly selectStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly deleteExpiredStmt: Database.Statement;
  private readonly deleteByAccountStmt: Database.Statement;

  constructor(db: Database.Database, config: SessionServiceConfig = {}) {
    this.ttlMs = config.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.secure = config.secure ?? true;

    this.insertStmt = db.prepare(`
      INSERT INTO sessions (session_id, account_id, wallet_address, created_at, expires_at)
      VALUES (@session_id, @account_id, @wallet_address, @created_at, @expires_at)
    `);
    this.selectStmt = db.prepare(
      'SELECT * FROM sessions WHERE session_id = ?',
    );
    this.deleteStmt = db.prepare('DELETE FROM sessions WHERE session_id = ?');
    this.deleteExpiredStmt = db.prepare(
      'DELETE FROM sessions WHERE expires_at < ?',
    );
    this.deleteByAccountStmt = db.prepare(
      'DELETE FROM sessions WHERE account_id = ?',
    );
  }

  /** Create a new session, return the token and the Set-Cookie header value. */
  create(accountId: string, walletAddress: string): {
    session: Session;
    cookieHeader: string;
  } {
    const now = Date.now();
    const sessionId = randomBytes(SESSION_TOKEN_BYTES).toString('hex');
    const expiresAt = now + this.ttlMs;

    this.insertStmt.run({
      session_id: sessionId,
      account_id: accountId,
      wallet_address: walletAddress,
      created_at: now,
      expires_at: expiresAt,
    });

    const session: Session = {
      sessionId,
      accountId,
      walletAddress,
      createdAt: now,
      expiresAt,
    };

    const cookieHeader = [
      `${SESSION_COOKIE_NAME}=${sessionId}`,
      'HttpOnly',
      'Path=/',
      `SameSite=Lax`,
      this.secure ? 'Secure' : '',
      `Max-Age=${Math.floor(this.ttlMs / 1000)}`,
    ]
      .filter(Boolean)
      .join('; ');

    return { session, cookieHeader };
  }

  /** Validate a session token. Returns null if expired or not found. */
  get(sessionId: string): Session | null {
    const row = this.selectStmt.get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.deleteStmt.run(sessionId);
      return null;
    }
    return rowToSession(row);
  }

  /** Destroy a session (logout). */
  destroy(sessionId: string): void {
    this.deleteStmt.run(sessionId);
  }

  /** Destroy all sessions for a given account. */
  destroyByAccount(accountId: string): void {
    this.deleteByAccountStmt.run(accountId);
  }

  /** Purge expired sessions. Call periodically. */
  purgeExpired(): number {
    const result = this.deleteExpiredStmt.run(Date.now());
    return result.changes;
  }

  /** Build a Set-Cookie header that clears the session cookie. */
  static clearCookieHeader(secure = true): string {
    return [
      `${SESSION_COOKIE_NAME}=`,
      'HttpOnly',
      'Path=/',
      'SameSite=Lax',
      secure ? 'Secure' : '',
      'Max-Age=0',
    ]
      .filter(Boolean)
      .join('; ');
  }
}
