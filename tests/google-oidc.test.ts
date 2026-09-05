// PRIESTATE — REAL OIDC/JWKS ID-token verification tests (J.4).
//
// These tests use the REAL `jose` library with REAL generated keypairs and a
// REAL JWKS to prove the production `createOidcVerifier` cryptographically
// validates Google ID tokens and fails closed on any tampering, expiry,
// audience/issuer mismatch, wrong signing key, wrong nonce, or unsupported
// algorithm. The final test drives the REAL `GoogleProvider` through a complete
// begin → OAuth redirect (code exchange) → complete flow whose ID token is
// signed by a real key and verified against a real JWKS — exactly what the
// server does in production, without any public network dependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createHmac } from 'node:crypto';
import { createOidcVerifier, type RemoteJwksHttp } from '../server/lib/identity-provider-oidc';
import { GoogleProvider } from '../server/account/google-provider';
import type { GoogleUserInfoClient, OAuthHttpClient } from '../server/lib/oauth-http';

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = 'priestate-client-id-123.apps.googleusercontent.com';
const JWKS_URI = 'https://accounts.google.com/.well-known/openid-configuration/jwks';
const SUBJECT = 'google-subject-42';
const KID = 'jwks-key-1';

interface Keypair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  jwk: JWK;
}

async function makeKeypair(alg: 'RS256' | 'ES256' = 'RS256'): Promise<Keypair> {
  const { publicKey, privateKey } = await generateKeyPair(alg);
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.use = 'sig';
  jwk.alg = alg;
  return { publicKey, privateKey, jwk };
}

function jwksStub(key: JWK): RemoteJwksHttp {
  return {
    fetchJwksProperty: async () => ({ keys: [key] }),
  };
}

interface SignOptions {
  iss?: string;
  aud?: string;
  sub?: string;
  nonce?: string;
  expInSec?: number;
  alg?: string;
  kid?: string;
}

async function signToken(privateKey: CryptoKey, opts: SignOptions = {}): Promise<string> {
  const alg = opts.alg ?? 'RS256';
  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, string | undefined> = { alg };
  if (opts.kid) header.kid = opts.kid;
  const jwt = new SignJWT(opts.nonce ? { nonce: opts.nonce } : {})
    .setProtectedHeader(header as { alg: string } & Record<string, string>)
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject(opts.sub ?? SUBJECT)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expInSec ?? 3600));
  return jwt.sign(privateKey);
}

/** Re-encode a valid token with a mutated payload (invalidates the signature). */
function mutatePayload(token: string, fn: (p: Record<string, unknown>) => Record<string, unknown>): string {
  const [head, payload, sig] = token.split('.');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  const next = fn(parsed);
  const nextEncoded = Buffer.from(JSON.stringify(next)).toString('base64url');
  return `${head}.${nextEncoded}.${sig}`;
}

// ── Verifier fail-closed configuration ──────────────────────────

test('createOidcVerifier is fail-closed without full configuration', () => {
  assert.equal(createOidcVerifier(undefined), null);
  assert.equal(createOidcVerifier({ enabled: false, issuer: 'x', audience: 'y', jwksUri: 'z' }), null);
  assert.equal(createOidcVerifier({ enabled: true, issuer: '', audience: 'y', jwksUri: 'z' }), null);
  assert.equal(createOidcVerifier({ enabled: true, issuer: 'x', audience: '', jwksUri: 'z' }), null);
  assert.equal(createOidcVerifier({ enabled: true, issuer: 'x', audience: 'y', jwksUri: '' }), null);
});

// ── Positive + negative signature/claims verification ──────────

test('a real RS256-signed ID token verifies against a real JWKS', async () => {
  const { privateKey, jwk } = await makeKeypair();
  const verifier = createOidcVerifier(
    { enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI },
    jwksStub(jwk),
  )!;
  const token = await signToken(privateKey);
  const result = await verifier.verify(token);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.iss, ISSUER);
    assert.equal(result.payload.aud, AUDIENCE);
    assert.equal(result.payload.sub, SUBJECT);
  }
});

test('a mutated payload is rejected (signature no longer validates)', async () => {
  const { privateKey, jwk } = await makeKeypair();
  const verifier = createOidcVerifier(
    { enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI },
    jwksStub(jwk),
  )!;
  const token = await signToken(privateKey);
  const tampered = mutatePayload(token, (p) => ({ ...p, sub: 'attacker-subject' }));
  const result = await verifier.verify(tampered);
  assert.equal(result.ok, false);
});

test('a token signed by an attacker key NOT in the JWKS is rejected even with matching claims', async () => {
  const { jwk } = await makeKeypair();
  const attacker = await makeKeypair();
  const verifier = createOidcVerifier(
    { enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI },
    jwksStub(jwk),
  )!;
  const forged = await signToken(attacker.privateKey, { kid: KID });
  assert.equal((await verifier.verify(forged)).ok, false);
});

test('an expired token is rejected', async () => {
  const { privateKey, jwk } = await makeKeypair();
  const verifier = createOidcVerifier(
    { enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI },
    jwksStub(jwk),
  )!;
  const expired = await signToken(privateKey, { expInSec: -120 });
  assert.equal((await verifier.verify(expired)).ok, false);
});

test('a wrong-audience token is rejected', async () => {
  const { privateKey, jwk } = await makeKeypair();
  const verifier = createOidcVerifier(
    { enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI },
    jwksStub(jwk),
  )!;
  const wrong = await signToken(privateKey, { aud: 'some-other-client-id' });
  assert.equal((await verifier.verify(wrong)).ok, false);
});

test('a wrong-issuer token is rejected', async () => {
  const { privateKey, jwk } = await makeKeypair();
  const verifier = createOidcVerifier(
    { enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI },
    jwksStub(jwk),
  )!;
  const wrong = await signToken(privateKey, { iss: 'https://evil.example.com' });
  assert.equal((await verifier.verify(wrong)).ok, false);
});

test('nonce is enforced when the verifier expects one', async () => {
  const { privateKey, jwk } = await makeKeypair();
  const verifier = createOidcVerifier(
    { enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI, nonce: 'expected-nonce-123' },
    jwksStub(jwk),
  )!;
  const mismatch = await signToken(privateKey, { nonce: 'other-nonce' });
  assert.equal((await verifier.verify(mismatch)).ok, false);
  const match = await signToken(privateKey, { nonce: 'expected-nonce-123' });
  assert.equal((await verifier.verify(match)).ok, true);
});

test('a valid ES256-signed token is accepted; an HS256-forged symmetric token is rejected', async () => {
  const { privateKey, jwk } = await makeKeypair('ES256');
  const verifier = createOidcVerifier(
    { enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI },
    jwksStub(jwk),
  )!;
  const es256 = await signToken(privateKey, { alg: 'ES256', kid: KID });
  assert.equal((await verifier.verify(es256)).ok, true);

  // An unsupported symmetric algo (HS256) never validates client-issued tokens.
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: SUBJECT, iat: now, exp: now + 3600 })).toString('base64url');
  const signature = createHmac('sha256', 'shared-secret').update(`${head}.${payload}`).digest('base64url');
  const hs256 = `${head}.${payload}.${signature}`;
  assert.equal((await verifier.verify(hs256)).ok, false);
});

// ── Full REAL GoogleProvider flow with a real keypair + JWKS ────

async function makeFlowProvider(over?: { mint?: (nonce: string) => Promise<string> }) {
  const { privateKey, jwk } = await makeKeypair('RS256');
  const verifier = createOidcVerifier(
    { enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI },
    jwksStub(jwk),
  )!;
  let mintedNonce = '';
  const httpDouble: OAuthHttpClient = {
    timeoutMs: 2000,
    exchangeAuthCode: async () => {
      const idToken = over?.mint
        ? await over.mint(mintedNonce)
        : await signToken(privateKey, { nonce: mintedNonce });
      return { status: 200, json: { access_token: 'access-token-1', token_type: 'Bearer', expires_in: 3600, id_token: idToken } };
    },
    fetchUserInfo: async () => ({ sub: SUBJECT, email_verified: true }),
    fetchJwks: async () => ({ keys: [jwk] }),
  };
  const userInfo: GoogleUserInfoClient = {
    fetch: async () => ({ sub: SUBJECT, email_verified: true }),
  };
  const provider = new GoogleProvider({
    configured: true,
    authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    clientId: AUDIENCE,
    clientSecret: 'super-secret',
    redirectUri: 'http://localhost:8787/api/v1/account/google/callback',
    tokenVerifier: verifier,
    http: httpDouble,
    userInfo,
  });
  return { provider, setNonce: (n: string) => { mintedNonce = n; } };
}

test('full provider flow: a real-signatured ID token survives redirect + completion, then is single-use', async () => {
  const WALLET = '0x' + 'a'.repeat(64);
  const { provider, setNonce } = await makeFlowProvider();

  const begin = provider.begin(WALLET);
  assert.equal(begin.ok, true);
  setNonce(begin.nonce);

  const redirect = await provider.handleOAuthRedirect({ state: begin.state, code: 'authz-code-1' });
  assert.equal(redirect.ok, true);

  const complete = provider.complete(WALLET, { state: begin.state, nonce: begin.nonce });
  assert.equal(complete.ok, true);

  // Single-use: a second complete is rejected (the live challenge is gone, so
  // it surfaces as bad-state — equal to replay in that it fails closed).
  const replay = provider.complete(WALLET, { state: begin.state, nonce: begin.nonce });
  assert.equal(replay.ok, false);

  // A second OAuth callback on the consumed challenge fails closed (the
  // challenge is gone, so it is reported as bad-state rather than replay).
  const secondCallback = await provider.handleOAuthRedirect({ state: begin.state, code: 'authz-code-2' });
  assert.equal(secondCallback.ok, false);
});

test('an attacker-signed ID token never marks the challenge verified', async () => {
  const WALLET = '0x' + 'b'.repeat(64);
  const attacker = await makeKeypair('RS256');
  const { provider, setNonce } = await makeFlowProvider({
    mint: async (nonce) => signToken(attacker.privateKey, { nonce, kid: KID }),
  });

  const begin = provider.begin(WALLET);
  assert.equal(begin.ok, true);
  setNonce(begin.nonce);

  const redirect = await provider.handleOAuthRedirect({ state: begin.state, code: 'evil-code' });
  assert.equal(redirect.ok, false);

  // complete() cannot fabricate auth: the challenge was never server-verified.
  const complete = provider.complete(WALLET, { state: begin.state, nonce: begin.nonce });
  assert.equal(complete.ok, false);
  assert.equal(complete.ok ? '' : complete.reason, 'unauthorized');
});

test('a validly-signed token with the WRONG nonce is rejected server-side', async () => {
  const WALLET = '0x' + 'c'.repeat(64);
  const { privateKey, jwk } = await makeKeypair('RS256');
  const verifier = createOidcVerifier(
    { enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI },
    jwksStub(jwk),
  )!;
  const httpDouble: OAuthHttpClient = {
    timeoutMs: 2000,
    exchangeAuthCode: async () => ({
      status: 200,
      json: { access_token: 'access-token-1', id_token: await signToken(privateKey, { nonce: 'wrong-nonce-value' }) },
    }),
    fetchUserInfo: async () => ({ sub: SUBJECT }),
    fetchJwks: async () => ({ keys: [jwk] }),
  };
  const userInfo: GoogleUserInfoClient = { fetch: async () => ({ sub: SUBJECT }) };
  const provider = new GoogleProvider({
    configured: true,
    authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    clientId: AUDIENCE,
    clientSecret: 'x',
    redirectUri: 'http://localhost:8787/api/v1/account/google/callback',
    tokenVerifier: verifier,
    http: httpDouble,
    userInfo,
  });

  const begin = provider.begin(WALLET);
  assert.equal(begin.ok, true);

  const redirect = await provider.handleOAuthRedirect({ state: begin.state, code: 'code' });
  assert.equal(redirect.ok, false);
  assert.equal(redirect.ok ? '' : redirect.reason, 'unauthorized');

  assert.equal(provider.complete(WALLET, { state: begin.state, nonce: begin.nonce }).ok, false);
});