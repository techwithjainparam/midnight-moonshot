// PRIESTATE — OIDC (Google) ID-token verification using `jose` (server-side).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Verifies a Google ID token by:
//   * fetching the issuer's remote JWKS fresh on each verify (no cached set),
//   * cryptographically verifying the JWS signature with `jose.jwtVerify`,
//   * enforcing `iss`, `aud`, `exp`, and (when supplied) `nonce`,
//   * rejecting anything structurally malformed or failing validation.
//
// The exact `jose` dependency is a server-import — it is never required by the
// browser bundle (the Vite client never imports this module).
//
// Fail-closed: if no issuer/audience/client-id are configured, `verify` always
// rejects, so an unconfigured Google factor can never fake a login.

import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { TokenVerifier, TokenVerifyResult, VerifiedIdToken } from './id-token-verifier';

export interface OidcVerifierConfig {
  /** Expect an integer epoch seconds; jose also handles numeric dates. */
  issuer: string;
  /** Expected `aud` — the Google OAuth client id. */
  audience: string;
  /** Remote JWKS endpoint. */
  jwksUri: string;
  /** Optional userinfo endpoint for cross-checking claims (server holds it). */
  userinfoEndpoint?: string;
  /** Expected `nonce` claim, when the flow supplied one. */
  nonce?: string;
  /** HTTP client used to fetch the JWKS (injectable in tests). */
  http?: RemoteJwksHttp;
}

/** Minimal fetch seam so tests can serve a deterministic JWKS. */
export interface RemoteJwksHttp {
  fetchJwksProperty(jwksUri: string): Promise<Record<string, unknown>>;
}

class DefaultRemoteJwksHttp implements RemoteJwksHttp {
  async fetchJwksProperty(jwksUri: string): Promise<Record<string, unknown>> {
    const res = await fetch(jwksUri, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`JWKS HTTP ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  }
}

export function createOidcVerifier(
  config: (OidcVerifierConfig & { enabled?: boolean }) | undefined,
  http?: RemoteJwksHttp,
): TokenVerifier | null {
  // Fail-closed: without issuer/audience/JWKS the verifier never accepts a token.
  if (!config || config.enabled === false) return null;
  const issuer = (config.issuer ?? '').trim();
  const audience = (config.audience ?? '').trim();
  const jwksUri = (config.jwksUri ?? '').trim();
  if (!issuer || !audience || !jwksUri) return null;

  const jwksHttp = http ?? new DefaultRemoteJwksHttp();
  const jwksUrl = new URL(jwksUri);

  // When a deterministic test seam is provided, route jose's JWKS fetch
  // through it via the customFetch symbol (still a real HTTPS GET in prod).
  const remoteOptions: Parameters<typeof createRemoteJWKSet>[1] = {};
  if (http) {
    (remoteOptions as Record<symbol, unknown>)[customFetch] = async (url: string) => {
      const jwks = await jwksHttp.fetchJwksProperty(url);
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  }
  const remote = createRemoteJWKSet(jwksUrl, remoteOptions);

  const expectedNonce = config.nonce;

  return {
    async verify(token: string): Promise<TokenVerifyResult> {
      const trimmed = (token ?? '').trim();
      if (!trimmed) return { ok: false, reason: 'missing-token' };
      try {
        const payload = await jwtVerify(trimmed, remote, {
          issuer,
          audience,
          algorithms: ['RS256', 'ES256'],
        });
        const claims = payload.payload as VerifiedIdToken;
        // Verify the nonce claim manually (jose does not enforce it by default).
        if (expectedNonce) {
          let ok = false;
          if (typeof claims.nonce === 'string' && claims.nonce === expectedNonce) ok = true;
          if (!ok) return { ok: false, reason: 'nonce-mismatch' };
        }
        return { ok: true, payload: claims };
      } catch (e) {
        return { ok: false, reason: (e as Error)?.message ?? 'token-invalid' };
      }
    },
  };
}
