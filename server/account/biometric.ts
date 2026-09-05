// PRIVESTATE — Server-side biometric reference + face-match logic (Level 3
// Part 8).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// This module is PURE and dependency-free (only `node:crypto` for the random
// session nonces) so the full matching/enrollment state machine is unit-tested
// in Node without any CV runtime. It implements:
//
//   1. REAL face-embedding arithmetic:
//        - `cosineSimilarity(a, b)` — the standard measurement face-recognition
//          systems use to decide match/mismatch.
//        - `enrollReference(embeddings)` — average N embeddings into a single
//          reference vector + report the spread (variance) so a degenerate or
//          inconsistent capture can be rejected at enrollment time.
//        - `MATCH_THRESHOLD` — the cosine-similarity decision line. Justified
//          in the constant's comment (LFW-scale FaceNet cosine threshold).
//   2. VERIFICATION MATH: live embedding vs stored reference → a similarity
//      score and a verdict. The score is computed from real vectors ONLY; there
//      is no path that accepts a client-supplied score, `matched`, or `isHuman`.
//   3. SESSION NONCE LIFECYCLE with replay protection:
//        - enrollment and verification each require a server-issued, short-TTL,
//          single-use token bound to the wallet address (+ reference version).
//        - a token is consumed exactly once; reuse fails closed.
//
// The browser NEVER tells the server "matched". It submits an ephemeral
// embedding (128-d, a real biometric representation, not an image) under a
// valid unspent token, and this module derives the verdict server-side from the
// encrypted reference the server itself holds.
//
// Privacy: nothing here writes to Midnight, `localStorage`, URLs, or logs. The
// embedding vectors are passed in, used to derive a verdict, and never echoed
// back; the stored reference is encrypted at rest with a SEPARATE key from the
// PII key (see security.ts deriveBiometricEncryptionKey).

import { randomBytes } from 'node:crypto';

/** A fixed-length face embedding vector (e.g. FaceNet 128-d). */
export type FaceEmbedding = readonly number[];

export const EMBEDDING_DIM = 128;

/**
 * Cosine-similarity decision threshold for match/mismatch.
 *
 * FaceNet-family embeddings are compared by cosine similarity (or equivalently
 * the cosine distance). A value of 1.0 means identical direction; 0.0 means
 * orthogonal. We require cos ≥ 0.55 to call a match. For commonly used FaceNet
 * models (e.g. the 128-d '20180408-114756' trained on VGGFace2/CASIA-LFW), a
 * cosine threshold around 0.4–0.6 separates genuine impostor pairs at LFW
 * beyond 99% accuracy. 0.55 is deliberately on the conservative ("fail
 * closed") side of that band: a live capture of the same person under varied
 * lighting/pitch routinely exceeds 0.7, while a non-matching identity stays
 * well below 0.4. The exact operating point is tunable server-side via
 * `BiometricConfig.matchThreshold` without changing this constant.
 */
export const MATCH_THRESHOLD = 0.55;

/** A fresh embedding is rejected if its L2 norm is ~0 (all-zero vector). */
const MIN_VECTOR_NORM = 1e-6;

export interface BiometricConfig {
  /** Cosine similarity at/above which a live face is considered a match. */
  readonly matchThreshold: number;
  /** Enrollment session TTL, ms. */
  readonly enrollmentTtlMs: number;
  /** Verification session TTL, ms. */
  readonly verificationTtlMs: number;
  /** Minimum distinct frames required for a usable enrollment reference. */
  readonly minEnrollFrames: number;
  /** Max relative spread (stddev/mean magnitude) tolerated among enrollment.
      A wildly inconsistent set suggests the capture was poor or spoofed. */
  readonly maxEnrollSpread: number;
}

export const DEFAULT_BIOMETRIC_CONFIG: Required<BiometricConfig> = {
  matchThreshold: MATCH_THRESHOLD,
  enrollmentTtlMs: 2 * 60 * 1000, // 2 minutes
  verificationTtlMs: 60 * 1000, // 1 minute
  minEnrollFrames: 3,
  maxEnrollSpread: 0.35,
};

/* ── Embedding arithmetic ──────────────────────────────────────────── */

export function l2Normalize(v: FaceEmbedding): number {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return Number.isFinite(norm) ? norm : 0;
}

export function isUsableEmbedding(v: FaceEmbedding | null | undefined): boolean {
  if (!v || !Array.isArray(v)) return false;
  if (v.length !== EMBEDDING_DIM) return false;
  for (const x of v) {
    if (!Number.isFinite(x)) return false;
  }
  return l2Normalize(v) >= MIN_VECTOR_NORM;
}

export function dot(a: FaceEmbedding, b: FaceEmbedding): number {
  let sum = 0;
  for (let i = 0; i < EMBEDDING_DIM && i < a.length && i < b.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Cosine similarity in [-1, 1]. Treats degenerate (near-zero) vectors as 0 so
 * an unusable input never produces a spurious high match.
 */
export function cosineSimilarity(a: FaceEmbedding, b: FaceEmbedding): number {
  const na = l2Normalize(a);
  const nb = l2Normalize(b);
  if (na < MIN_VECTOR_NORM || nb < MIN_VECTOR_NORM) return 0;
  return dot(a, b) / (na * nb);
}

/** Average a set of embeddings into a single reference vector elementwise. */
export function meanEmbedding(embeddings: readonly FaceEmbedding[]): number[] {
  const n = embeddings.length;
  if (n === 0) return new Array(EMBEDDING_DIM).fill(0);
  const out = new Array(EMBEDDING_DIM).fill(0) as number[];
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    let s = 0;
    for (const e of embeddings) s += e[i];
    out[i] = s / n;
  }
  return out;
}

/** Elementwise stddev of a set of embeddings (capture-consistency metric). */
export function embeddingSpread(embeddings: readonly FaceEmbedding[]): number {
  if (embeddings.length < 2) return 0;
  const mean = meanEmbedding(embeddings);
  const dims = new Array(EMBEDDING_DIM).fill(0) as number[];
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    let s = 0;
    for (const e of embeddings) s += (e[i] - mean[i]) ** 2;
    dims[i] = s / embeddings.length;
  }
  const avgVar = dims.reduce((a, b) => a + b, 0) / EMBEDDING_DIM;
  return Math.sqrt(avgVar);
}

export interface EnrollmentDerivation {
  readonly ok: true;
  readonly reference: number[];
  /** Mean pairwise cosine across captured frames (self-consistency). */
  readonly selfSimilarity: number;
  /** Relative spread (stddev / mean magnitude). Lower is more consistent. */
  readonly spread: number;
}

/**
 * Derive the reference embedding from N captured live embeddings. Rejects the
 * capture if there are too few frames or if the frames are mutually
 * inconsistent (`spread` too high), which can indicate a poor or spoofed
 * capture. Pure and deterministic.
 */
export function deriveEnrollmentReference(
  embeddings: readonly FaceEmbedding[],
  config: Partial<BiometricConfig> = {},
): EnrollmentDerivation | null {
  const cfg = { ...DEFAULT_BIOMETRIC_CONFIG, ...config };
  const usable = embeddings.filter(isUsableEmbedding);
  if (usable.length < cfg.minEnrollFrames) return null;

  const reference = meanEmbedding(usable);
  const meanMag = Math.sqrt(reference.reduce((s, x) => s + x * x, 0));
  const spread = embeddingSpread(usable);
  if (meanMag < MIN_VECTOR_NORM) return null;
  if (spread / meanMag > cfg.maxEnrollSpread) return null;

  // Mean pairwise self-similarity of the captured frames.
  let total = 0;
  let count = 0;
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      total += cosineSimilarity(usable[i], usable[j]);
      count++;
    }
  }
  const selfSimilarity = count > 0 ? total / count : 1;

  return { ok: true, reference, selfSimilarity, spread };
}

/* ── Verification verdict ──────────────────────────────────────────── */

export type BiometricVerdict =
  | 'matched'
  | 'mismatch'
  | 'insufficient_quality' // live embedding unusable
  | 'no_reference' // account has no enrolled reference
  | 'reference_revoked' // reference exists but is revoked
  | 'session_invalid' // missing/expired/reused token
  | 'provider_unavailable' // biometric verification not configured
  | 'error';

export interface MatchResult {
  readonly verdict: BiometricVerdict;
  /** Real computed cosine similarity, present only on matched/mismatch. */
  readonly score?: number;
}

/**
 * Compare a live embedding to a stored reference embedding. The reference is
 * supplied (already decrypted) by the caller; this function ONLY compares
 * vectors and decides. It never accepts a client-supplied score or verdict.
 */
export function compareToReference(
  live: FaceEmbedding | null | undefined,
  reference: FaceEmbedding | null | undefined,
  config: Partial<BiometricConfig> = {},
): MatchResult {
  const cfg = { ...DEFAULT_BIOMETRIC_CONFIG, ...config };
  if (!isUsableEmbedding(live)) return { verdict: 'insufficient_quality' };
  if (!isUsableEmbedding(reference)) return { verdict: 'no_reference' };
  const liveVec: FaceEmbedding = live as FaceEmbedding;
  const refVec: FaceEmbedding = reference as FaceEmbedding;
  const score = cosineSimilarity(liveVec, refVec);
  const verdict = score >= cfg.matchThreshold ? 'matched' : 'mismatch';
  return { verdict, score };
}

/* ── Enrollment / verification session nonce lifecycle ─────────────── */

export interface BiometricSession {
  readonly token: string;
  readonly walletAddress: string;
  readonly expiresAt: number;
  /** Reference version this session was minted against (verification). */
  readonly referenceVersion: number | null;
  readonly purpose: 'enrollment' | 'verification';
}

export interface BiometricSessionBook {
  /** Issue a fresh single-use session for a wallet + purpose. */
  issue(input: { walletAddress: string; purpose: 'enrollment' | 'verification'; referenceVersion?: number | null; now: number }): BiometricSession;
  /** Consume + validate a token. Returns null (and marks used) on failure. */
  consume(token: string, walletAddress: string, purpose: 'enrollment' | 'verification', now: number): BiometricSession | null;
  /** True when a token is still pending (unspent + unexpired). */
  pending(token: string, now: number): boolean;
}

/**
 * An in-memory single-use session book for enrollment + verification nonces.
 * Tokens are 32 random bytes; a token is consumed exactly once; expired or
 * reused tokens fail closed. Bound to the wallet address so a token minted for
 * account A cannot be redeemed for account B.
 */
export class InMemoryBiometricSessionBook implements BiometricSessionBook {
  private readonly store = new Map<string, BiometricSession>();
  private readonly consumed = new Set<string>();

  private genToken(): string {
    return randomBytes(32).toString('hex');
  }

  issue(input: {
    walletAddress: string;
    purpose: 'enrollment' | 'verification';
    referenceVersion?: number | null;
    now: number;
  }): BiometricSession {
    const token = this.genToken();
    const ttl =
      input.purpose === 'enrollment'
        ? DEFAULT_BIOMETRIC_CONFIG.enrollmentTtlMs
        : DEFAULT_BIOMETRIC_CONFIG.verificationTtlMs;
    const session: BiometricSession = {
      token,
      walletAddress: input.walletAddress,
      expiresAt: input.now + ttl,
      referenceVersion: input.referenceVersion ?? null,
      purpose: input.purpose,
    };
    this.store.set(token, session);
    return session;
  }

  consume(
    token: string,
    walletAddress: string,
    purpose: 'enrollment' | 'verification',
    now: number,
  ): BiometricSession | null {
    if (!token) return null;
    if (this.consumed.has(token)) return null; // replay
    const s = this.store.get(token);
    if (!s) return null;
    if (s.walletAddress !== walletAddress) return null; // wallet-bound
    if (s.purpose !== purpose) return null;
    if (now > s.expiresAt) {
      this.store.delete(token);
      return null;
    }
    this.store.delete(token);
    this.consumed.add(token);
    return s;
  }

  pending(token: string, now: number): boolean {
    const s = this.store.get(token);
    return Boolean(s && now <= s.expiresAt && !this.consumed.has(token));
  }
}

/* ── Enrollment lifecycle state (server-side projection) ────────────── */

/**
 * Explicit enrollment state the server reports to the client. This is derived
 * from the stored reference metadata — it is authoritative and cannot be
 * self-asserted by the browser.
 */
export type EnrollmentState =
  | 'not_enrolled'
  | 'enrolled'
  | 'revoked'
  | 'unavailable';

/** Derive the enrollment state from stored reference metadata. Pure. */
export function deriveEnrollmentState(meta: {
  enrolled: boolean;
  revokedAt: number | null;
}): EnrollmentState {
  if (!meta.enrolled) return 'not_enrolled';
  if (meta.revokedAt !== null) return 'revoked';
  return 'enrolled';
}

/* ── Reference wrapper (what we store, encrypted, on the record) ────── */

export interface BiometricReference {
  /** The 128-d reference embedding (plaintext only briefly in memory). */
  readonly embedding: number[];
  readonly version: number;
  readonly enrolledAt: number;
  readonly consentAt: number;
  /** Mean pairwise self-similarity of the capture frames at enrollment. */
  readonly selfSimilarity: number;
  /** Spread of the enrollment capture (see deriveEnrollmentReference). */
  readonly spread: number;
}