// PRIESTATE — Deterministic Google OAuth test kit.
//
// Builds a REAL `GoogleProvider` whose outbound transport is a local double:
//   * a fake token endpoint that mints a dev authorization code → ID token,
//   * a `TokenVerifier` that decodes and validates the ID token claims,
//   * a fake userinfo endpoint returning the subject for cross-checks.
//
// This keeps the provider's challenge semantics (state/nonce/TTL/single-use,
// redirect-then-complete) REAL while only faking the provider-validation
// boundary — exactly the seam J.4 permits for deterministic local fixtures.
// The raw 66-hex Google signature path is separately exercised in
// `tests/google-oidc.test.ts` with a real keypair + jose.

import { randomBytes } from 'node:crypto';
import { GoogleProvider } from '../../server/account/google-provider';
import type { AccountService } from '../../server/account/service';
import type { TokenVerifier, VerifiedIdToken } from '../../server/lib/id-token-verifier';
import type { OAuthHttpClient } from '../../server/lib/oauth-http';
import type { GoogleUserInfoClient } from '../../server/lib/oauth-http';
import { OAuthStateSession } from '../../server/lib/oauth-state';

export const GOOGLE_TEST_ISSUER = 'https://accounts.google.com';
export const GOOGLE_TEST_CLIENT_ID = 'test-client-id';
export const GOOGLE_TEST_REDIRECT =
  'http://localhost:8787/api/v1/account/google/callback';

export interface GoogleTestKitOptions {
  /** When false, the token verifier rejects every ID token. */
  accept?: boolean;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  /** Force a specific userinfo `sub` (mismatch when different from subject). */
  readonly userinfoSubject?: string;
  /** When true, the userinfo cross-check always fails (null profile). */
  readonly failUserinfo?: boolean;
  readonly now?: () => number;
}

export interface GoogleTestKit {
  readonly provider: GoogleProvider;
  readonly subject: string;
  /**
   * Mint a dev authorization code for the given `nonce`. Passing it to
   * `handleOAuthRedirect` produces a valid ID-token → redirect success.
   */
  devAuthorizationCode(nonce: string): string;
  /** Flip the token-verifier accept/reject decision at runtime. */
  setAccept(accept: boolean): void;
  /**
   * Run the full link flow against an AccountService:
   * begin → dev code → OAuthRedirect → complete. Returns the public view.
   */
  link(service: AccountService, wallet: string): Promise<{ ok: boolean }>;
}

function decodeIdToken(token: string): VerifiedIdToken | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as VerifiedIdToken;
  } catch {
    return null;
  }
}

export function createGoogleTestKit(opts: GoogleTestKitOptions = {}): GoogleTestKit {
  const stateStore = new OAuthStateSession({ now: opts.now });
  const codes = new Map<string, string>(); // dev code -> nonce

  const tokenVerifier: TokenVerifier = {
    async verify(token: string) {
      if (!(opts.accept ?? true)) return { ok: false, reason: 'rejected' };
      const decoded = decodeIdToken(token);
      if (!decoded) return { ok: false, reason: 'malformed' };
      if (decoded.iss !== (opts.issuer ?? GOOGLE_TEST_ISSUER)) return { ok: false, reason: 'issuer-mismatch' };
      if (decoded.aud !== (opts.audience ?? GOOGLE_TEST_CLIENT_ID)) return { ok: false, reason: 'aud-mismatch' };
      if (typeof decoded.sub !== 'string' || !decoded.sub) return { ok: false, reason: 'no-subject' };
      return { ok: true, payload: decoded };
    },
  };

  const oauthHttp: OAuthHttpClient = {
    timeoutMs: 1000,
    async exchangeAuthCode({ code }) {
      const nonce = codes.get(code);
      if (!nonce) return { status: 400, json: {} };
      const subject = opts.subject ?? 'google-test-subject';
      const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
      const payload: VerifiedIdToken = {
        iss: opts.issuer ?? GOOGLE_TEST_ISSUER,
        sub: subject,
        aud: opts.audience ?? GOOGLE_TEST_CLIENT_ID,
        exp: nowSec + 3600,
        iat: nowSec - 5,
        nonce,
        email: 'user@example.test',
        email_verified: true,
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const idToken = `eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3QifQ.${encodedPayload}.${'a'.repeat(32)}`;
      return {
        status: 200,
        json: { id_token: idToken, access_token: 'dev-access-token', token_type: 'Bearer', expires_in: 3600 },
      };
    },
    async fetchUserInfo() {
      return null;
    },
    async fetchJwks() {
      return { keys: [] };
    },
  };

  const userInfo: GoogleUserInfoClient = {
    async fetch() {
      if (opts.failUserinfo) return null;
      return {
        sub: opts.userinfoSubject ?? opts.subject ?? 'google-test-subject',
        email: 'user@example.test',
        email_verified: true,
      };
    },
  };

  const provider = new GoogleProvider({
    configured: true,
    authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    clientId: GOOGLE_TEST_CLIENT_ID,
    clientSecret: 'test-client-secret',
    redirectUri: GOOGLE_TEST_REDIRECT,
    tokenVerifier,
    stateStore,
    http: oauthHttp,
    userInfo,
    now: opts.now,
  });

  return {
    provider,
    subject: opts.subject ?? 'google-test-subject',
    devAuthorizationCode(nonce: string): string {
      const code = randomBytes(16).toString('base64url');
      codes.set(code, nonce);
      return code;
    },
    setAccept(accept: boolean): void {
      opts.accept = accept;
    },
    async link(service: AccountService, wallet: string): Promise<{ ok: boolean }> {
      const begin = service.googleBegin(wallet);
      if (!begin.ok) return { ok: false };
      const code = this.devAuthorizationCode(begin.nonce);
      const redirect = await service.googleOAuthRedirect({ state: begin.state, code });
      if (!redirect.ok) return { ok: false };
      const complete = service.googleComplete(wallet, { state: begin.state, nonce: begin.nonce });
      return { ok: complete.ok };
    },
  };
}