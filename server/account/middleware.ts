// PRIESTATE — Express-compatible auth middleware for session validation.
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Reads the `priestate_sid` cookie, looks up the session, and attaches the
// authenticated user to `req.user` if valid.  If the session is missing or
// invalid, the request is rejected with 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SESSION_COOKIE_NAME, SessionService, type Session } from './session.js';

export { SESSION_COOKIE_NAME }; // re-export for convenience

export interface AuthenticatedUser {
  readonly accountId: string;
  /** Null until the account's Midnight wallet is associated. */
  readonly walletAddress: string | null;
}

/** Augmented request type carrying the authenticated user. */
export interface AuthenticatedRequest extends IncomingMessage {
  user?: AuthenticatedUser;
  session?: Session;
}

export type AuthMiddleware = (
  req: AuthenticatedRequest,
  res: ServerResponse,
  next: () => void,
) => void;

/**
 * Create an Express-like middleware that validates the session cookie.
 *
 * If valid, `req.user` and `req.session` are populated and `next()` is called.
 * If invalid/missing, a 401 JSON response is sent and `next()` is NOT called.
 */
export function requireSession(sessions: SessionService): AuthMiddleware {
  return (req, res, next) => {
    const cookieHeader = req.headers.cookie ?? '';
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`).exec(cookieHeader);
    const token = match ? match[1] : null;

    if (!token || typeof token !== 'string') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required.' }));
      return;
    }

    const session = sessions.get(token);
    if (!session) {
      // Expired or invalid token — clear the cookie.
      res.setHeader('Set-Cookie', SessionService.clearCookieHeader());
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session expired or invalid.' }));
      return;
    }

    req.user = {
      accountId: session.accountId,
      walletAddress: session.walletAddress,
    };
    req.session = session;
    next();
  };
}
