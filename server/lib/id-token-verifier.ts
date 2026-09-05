// PRIESTATE — ID-token verifier interface (server-side only).
//
// A `TokenVerifier` turns a raw Google ID token into a validated set of claims
// ONLY after cryptographically verifying the signature against the issuer's
// remote JWKS and checking the required claims. It never trusts a decoded JWT;
// any malformed, expired, wrong-audience, or wrong-issuer token is rejected.
//
// Implementations must be fail-closed and must never log or persist tokens.

export interface VerifiedIdToken {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | string[];
  readonly exp: number;
  readonly iat: number;
  readonly nonce?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly at_hash?: string;
  readonly [claim: string]: unknown;
}

export type TokenVerifyResult =
  | { ok: true; payload: VerifiedIdToken }
  | { ok: false; reason: string };

export interface TokenVerifier {
  /**
   * Verify an ID token against the configured issuer/audience and return its
   * validated claims. Returns `{ ok:false }` for any invalid, expired, or
   * mismatched token.
   */
  verify(token: string): Promise<TokenVerifyResult>;
}
