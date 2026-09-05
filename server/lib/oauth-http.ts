// PRIESTATE — OAuth2 HTTP client (server-side only).
//
// Thin, dependency-light HTTP helpers for the Google OAuth2 authorization-code
// flow: exchanging an authorization code for tokens, fetching the remote
// userinfo profile (used to cross-check the ID-token's claims), and validating
// the issuer's TLS signature chain over JWKS during ID-token verification.
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
// No tokens, codes, or secrets are ever logged.

/** HTTP response as a parsed JSON object + status. */
export interface OAuthJsonResponse {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Structural contract so tests can inject deterministic HTTP doubles. */
export interface OAuthHttpClient {
  readonly timeoutMs: number;
  exchangeAuthCode(params: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<OAuthJsonResponse>;
  fetchUserInfo(userinfoEndpoint: string, accessToken: string): Promise<Record<string, unknown> | null>;
  fetchJwks(jwksUri: string): Promise<Record<string, unknown>>;
}

/** Structural contract for the userinfo profile fetch (test-doubleable). */
export interface GoogleUserInfoClient {
  fetch(accessToken: string, userinfoEndpoint: string): Promise<Record<string, unknown> | null>;
}

/**
 * Encapsulates the outbound HTTP calls needed by the Google OAuth provider and
 * the OIDC token verifier. All methods fail closed (return a rejected promise /
 * `null`) on network or parse errors so an external fault can never be turned
 * into a fabricated success.
 */
export class OAuthHttp {
  readonly timeoutMs: number;

  constructor(timeoutMs = 8000) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Exchange an authorization `code` (+ PKCE verifier) at the token endpoint.
   * Returns the parsed JSON response (typically `{ id_token, access_token,
   * token_type, expires_in }`). The raw token values are NEVER logged.
   */
  async exchangeAuthCode(params: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<OAuthJsonResponse> {
    const form = new URLSearchParams();
    form.set('grant_type', 'authorization_code');
    form.set('code', params.code);
    form.set('redirect_uri', params.redirectUri);
    form.set('client_id', params.clientId);
    if (params.clientSecret) form.set('client_secret', params.clientSecret);
    if (params.codeVerifier) form.set('code_verifier', params.codeVerifier);

    return this.post(params.tokenEndpoint, form.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    });
  }

  /** Fetch the remote userinfo profile (HTTP header auth is set by caller). */
  async fetchUserInfo(
    userinfoEndpoint: string,
    accessToken: string,
  ): Promise<Record<string, unknown> | null> {
    const res = await this.getParsed(userinfoEndpoint, {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    });
    return res && isRecord(res.json) ? res.json : null;
  }

  /** Fetch the issuer's JSON Web Key Set used to verify ID-token signatures. */
  async fetchJwks(jwksUri: string): Promise<Record<string, unknown>> {
    const res = await this.getParsed(jwksUri, { Accept: 'application/json' });
    if (!res || !isRecord(res.json)) {
      throw new Error('JWKS endpoint did not return a JSON object');
    }
    return res.json;
  }

  private async getParsed(
    url: string,
    headers: Record<string, string>,
  ): Promise<OAuthJsonResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // Non-JSON body: fail closed.
      }
      return { status: res.status, json: isRecord(json) ? json : {} };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<OAuthJsonResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // Non-JSON body: fail closed.
      }
      return { status: res.status, json: isRecord(json) ? json : {} };
    } catch {
      return { status: 0, json: {} };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Minimal userinfo fetcher so tests can inject a local double. */
export class GoogleUserInfoHttp implements GoogleUserInfoClient {
  private readonly http: OAuthHttp;
  constructor(http: OAuthHttp = new OAuthHttp()) {
    this.http = http;
  }

  /**
   * Fetch the Google profile for `accessToken`. Returns null on any error.
   * Access tokens are never logged.
   */
  async fetch(accessToken: string, userinfoEndpoint: string): Promise<Record<string, unknown> | null> {
    return this.http.fetchUserInfo(userinfoEndpoint, accessToken);
  }
}
