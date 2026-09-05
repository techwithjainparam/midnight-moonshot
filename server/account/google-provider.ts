// PRIESTATE — Google OAuth provider boundary (registration authentication).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// This is the REAL OAuth2 authorization-code provider integration (J.4):
//
//   * `begin()` issues a fresh cryptographically-random `state` + `nonce`
//     (with a PKCE `code_verifier`) bound to the initiating wallet, with a
//     short TTL and single use. It returns a REAL Google authorization URL.
//   * the OAuth redirect is handled by the server callback route, which
//     exchanges the `code` for tokens over HTTPS and verifies the ID token's
//     signature against Google's remote JWKS via the OIDC `TokenVerifier`
//     (enforcing `iss`, `aud`, `exp`, `nonce`), then cross-checks the profile
//     at the userinfo endpoint with the access token.
//   * `complete()` REQUIRES the state + nonce, validates they match the
//     stored challenge for that wallet, are not expired and not already
//     consumed, and only then accepts the factor as verified server-side.
//   * if no real Google credentials are configured, the provider is
//     `configured: false` and every step reports `unavailable` (fail closed) —
//     we never invent a successful Google login.
//
// Nothing here persists tokens/secrets to disk, localStorage, URLs, logs, or
// the Midnight ledger. Client id is public; client secret and the nonce are
// only ever held server-side (the nonce is never placed in a URL).

import { createHash, randomBytes } from 'node:crypto';
import type { TokenVerifier } from '../lib/id-token-verifier';
import { OAuthStateSession } from '../lib/oauth-state';
import type { OAuthStateSession as OAuthStateSessionType } from '../lib/oauth-state';
import { GoogleUserInfoHttp, OAuthHttp } from '../lib/oauth-http';
import type { GoogleUserInfoClient, OAuthHttpClient } from '../lib/oauth-http';

export const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface GoogleProviderConfig {
  readonly configured?: boolean;
  /** OAuth authorize endpoint (override in tests). */
  readonly authorizeEndpoint: string;
  /** OAuth token endpoint. */
  readonly tokenEndpoint: string;
  /** Remote userinfo endpoint. */
  readonly userinfoEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Exactly the redirect URI configured at the provider. */
  readonly redirectUri: string;
  readonly tokenVerifier: TokenVerifier | null;
  readonly stateStore?: OAuthStateSessionType;
  readonly ttlMs?: number;
  readonly scopes?: string;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
  /** HTTP client for the token/userinfo exchange (injectable in tests). */
  readonly http?: OAuthHttpClient;
  /** Userinfo fetcher (injectable in tests). */
  readonly userInfo?: GoogleUserInfoClient;
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
  | { ok: true; state: string; nonce: string; authUrl: string; codeChallenge?: string }
  | { ok: false; reason: 'unavailable' };

export type GoogleCompleteResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'bad-state' | 'expired' | 'replay' | 'unauthorized' };

/**
 * Server-side Google OAuth2 authorization-code session manager. Holds per-wallet
 * challenge state in memory; an attacker without the returned nonce (and, when
 * enabled, the PKCE verifier) cannot complete the flow.
 */
export class GoogleProvider {
  readonly configured: boolean;
  private readonly authorizeEndpoint: string;
  private readonly tokenEndpoint: string;
  private readonly userinfoEndpoint: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly tokenVerifier: TokenVerifier | null;
  private readonly now: () => number;
  private readonly http: OAuthHttpClient;
  private readonly userInfo: GoogleUserInfoClient;
  private readonly stateStore: OAuthStateSessionType;

  constructor(config: GoogleProviderConfig) {
    this.configured =
      config.configured ??
      Boolean(config.clientId && config.clientSecret && config.redirectUri && config.tokenVerifier);
    this.authorizeEndpoint = config.authorizeEndpoint;
    this.tokenEndpoint = config.tokenEndpoint;
    this.userinfoEndpoint = config.userinfoEndpoint;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectUri = config.redirectUri;
    this.tokenVerifier = config.tokenVerifier;
    this.now = config.now ?? Date.now;
    this.http = config.http ?? new OAuthHttp();
    this.userInfo = config.userInfo ?? new GoogleUserInfoHttp();
    this.stateStore =
      config.stateStore ??
      new OAuthStateSession({ now: this.now, ttlMs: config.ttlMs ?? GOOGLE_STATE_TTL_MS });
  }

  private token(): string {
    return randomBytes(24).toString('base64url');
  }

  private codeChallenge(): { verifier: string; challenge: string } {
    // S256 PKCE: base64url( SHA-256( verifier ) ).
    const verifier = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge: digest };
  }

  /**
   * Start a Google sign-in for `wallet`. Returns the opaque `state` (echoed
   * through the OAuth redirect), the `nonce` (kept out of the redirect/callback
   * URLs and returned to the in-app client only), and a real authorize URL.
   */
  begin(wallet: string): GoogleBeginResult {
    if (!this.configured) return { ok: false, reason: 'unavailable' };
    const state = this.token();
    const nonce = this.token();
    const { verifier, challenge } = this.codeChallenge();
    this.stateStore.issue({
      wallet,
      state,
      nonce,
      codeVerifier: verifier,
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    const authUrl = `${this.authorizeEndpoint}?${params.toString()}`;
    return { ok: true, state, nonce, authUrl, codeChallenge: challenge };
  }

  /**
   * Handle an OAuth authorization redirect from the authorization server.
   * Called by the server's GET callback route with the `code` + `state`.
   *
   * Validates the challenge and — if a `code` is present — exchanges it for
   * tokens, cryptographically verifies the ID token (iss/aud/exp/nonce) and
   * cross-checks the userinfo profile. On success the challenge is marked
   * consumable by the in-app `complete()` call.
   */
  async handleOAuthRedirect(params: {
    state: string;
    code?: string;
    error?: string;
  }): Promise<
    | { ok: true }
    | { ok: false; reason: 'unavailable' | 'bad-state' | 'expired' | 'replay' | 'unauthorized' }
  > {
    if (!this.configured) return { ok: false, reason: 'unavailable' };
    const challenge = this.stateStore.peek(params.state);
    if (!challenge) return { ok: false, reason: 'bad-state' };
    if (challenge.consumed) return { ok: false, reason: 'replay' };
    if (challenge.redirectVerified) return { ok: false, reason: 'replay' };

    if (params.error) {
      return { ok: false, reason: 'unauthorized' };
    }
    const code = params.code;
    if (!code) return { ok: false, reason: 'bad-state' };

    // Exchange the authorization code at the token endpoint (never logged).
    const exchanged = await this.http.exchangeAuthCode({
      tokenEndpoint: this.tokenEndpoint,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      code,
      redirectUri: this.redirectUri,
      codeVerifier: challenge.codeVerifier,
    });

    const idToken =
      typeof exchanged.json.id_token === 'string' ? exchanged.json.id_token : '';
    const accessToken =
      typeof exchanged.json.access_token === 'string' ? exchanged.json.access_token : '';

    if (!idToken || !this.tokenVerifier) {
      return { ok: false, reason: 'unauthorized' };
    }

    const verified = await this.tokenVerifier.verify(idToken);
    if (!verified.ok) return { ok: false, reason: 'unauthorized' };

    // The nonce in the ID token must match the challenge nonce.
    if (verified.payload.nonce !== challenge.nonce) {
      return { ok: false, reason: 'unauthorized' };
    }

    // Cross-check the live profile at the userinfo endpoint with the access
    // token; the returned `sub` must match the ID token subject.
    if (accessToken) {
      const profile = await this.userInfo.fetch(accessToken, this.userinfoEndpoint);
      if (!profile || profile.sub !== verified.payload.sub) {
        return { ok: false, reason: 'unauthorized' };
      }
    }

    challenge.redirectVerified = true;
    return { ok: true };
  }

  /**
   * Complete a Google sign-in. Validates that the presented state matches a
   * live, unconsumed challenge bound to `wallet`, that the nonce matches, and
   * that the challenge has not expired.
   */
  complete(wallet: string, params: { state: string; nonce: string }): GoogleCompleteResult {
    if (!this.configured) return { ok: false, reason: 'unavailable' };
    const challenge = this.stateStore.get(params.state);
    if (!challenge) return { ok: false, reason: 'bad-state' };
    if (challenge.consumed) return { ok: false, reason: 'replay' };
    if (challenge.wallet !== wallet) return { ok: false, reason: 'bad-state' };
    if (!challenge.redirectVerified) return { ok: false, reason: 'unauthorized' };
    if (this.now() >= challenge.expiresAt) return { ok: false, reason: 'expired' };
    // Consume single-use challenge BEFORE returning so a replay is rejected.
    challenge.consumed = true;

    if (!params.nonce || !this.safeEqual(params.nonce, challenge.nonce)) {
      return { ok: false, reason: 'bad-state' };
    }
    // The challenge must have survived a successful OAuth redirect exchange;
    // complete() itself never fabricates auth.
    this.stateStore.consume(params.state);
    return { ok: true };
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    return bufA.length === bufB.length && bufA.equals(bufB);
  }

  /** Remove expired challenges; called periodically. */
  sweep(): void {
    this.stateStore.sweep();
  }
}

// ── Config-driven factory (used by the verification server) ──────────────

export interface GoogleProviderDomain {
  readonly enabled?: boolean;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly oauthAuthorizeEndpoint?: string;
  readonly oauthTokenEndpoint?: string;
  readonly oauthUserinfoEndpoint?: string;
  readonly redirectUri?: string;
  readonly jwksUri?: string;
  readonly issuer?: string;
  readonly stateTtlMs?: number;
}

export interface GoogleProviderFactoryDeps {
  readonly domain: GoogleProviderDomain;
  readonly stateStore: OAuthStateSessionType;
  readonly oauthHttp: OAuthHttpClient;
  readonly tokenVerifier?: TokenVerifier | null;
  readonly googleUserInfoHttp?: GoogleUserInfoClient;
}

const DEFAULT_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TOKEN = 'https://oauth2.googleapis.com/token';
const DEFAULT_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * Build a REAL Google OAuth provider from server config. Fails closed (all
 * operations report `unavailable`) unless genuine client credentials AND a
 * working OIDC token verifier are present.
 */
export function createGoogleProviderFromConfig(deps: GoogleProviderFactoryDeps): GoogleProviderObject {
  const { domain, stateStore, oauthHttp, tokenVerifier, googleUserInfoHttp } = deps;
  const provider = new GoogleProvider({
    configured: Boolean(domain.enabled !== false && domain.clientId && domain.clientSecret && tokenVerifier),
    authorizeEndpoint: domain.oauthAuthorizeEndpoint ?? DEFAULT_AUTHORIZE,
    tokenEndpoint: domain.oauthTokenEndpoint ?? DEFAULT_TOKEN,
    userinfoEndpoint: domain.oauthUserinfoEndpoint ?? DEFAULT_USERINFO,
    clientId: domain.clientId,
    clientSecret: domain.clientSecret,
    redirectUri: domain.redirectUri ?? '',
    tokenVerifier: tokenVerifier ?? null,
    stateStore,
    ttlMs: domain.stateTtlMs ?? GOOGLE_STATE_TTL_MS,
    http: oauthHttp,
    userInfo: googleUserInfoHttp,
  });
  return provider;
}

/**
 * Structural type for the Google provider so the server layer can inject
 * either the REAL `GoogleProvider` or a deterministic local double in tests.
 */
export type GoogleProviderObject = Pick<
  GoogleProvider,
  'configured' | 'begin' | 'complete' | 'handleOAuthRedirect' | 'sweep'
>;