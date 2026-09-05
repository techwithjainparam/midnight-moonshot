import { EMBEDDING_DIM, l2Normalize } from '../server/account/biometric';

/**
 * Deterministic, USABLE face-embedding vectors for tests (Part 8).
 *
 * These are plain 128-d number arrays that pass `isUsableEmbedding` (correct
 * length + finite + a real L2 norm) and can be compared with real cosine
 * similarity, so the pure matching/enrollment/verify server logic is exercised
 * WITHOUT needing the ~6 MB FaceNet model or a browser.
 *
 * `referenceVector` is the "enrolled" face. `sameFaceVector` is a small,
 * correlated perturbation of it (high cosine similarity ⇒ matches). 
 * `differentFaceVector` points the opposite way (low similarity ⇒ mismatches).
 * They share one global seed so any test can reproduce a deterministic verdict.
 */
export const EMBEDDING_DIM_128 = EMBEDDING_DIM;

function seededVector(seed: number, flip: number): readonly number[] {
  const v = new Array<number>(EMBEDDING_DIM);
  let x = seed;
  const next = (): number => {
    x = (1103515245 * x + 12345) % 2147483648;
    return (x / 2147483648) * 2 - 1;
  };
  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    v[i] = flip * next();
  }
  return v;
}

function normalized(v: readonly number[]): readonly number[] {
  const norm = l2Normalize(v);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/**
 * The canonical enrollment reference (unit-length, usable).
 */
export const referenceVector: readonly number[] = normalized(seededVector(42, 1));

/**
 * A live capture of the SAME face: the reference plus a tiny deterministic
 * perturbation, re-normalized. Cosine similarity to `referenceVector` is near 1
 * and clearly above the match threshold.
 */
export const sameFaceVector: readonly number[] = normalized(
  referenceVector.map((x, i) => x + 0.02 * ((i % 7) - 3) / 6),
);

/**
 * A live capture of a DIFFERENT face: the anti-reference. Cosine similarity to
 * `referenceVector` is far below the match threshold.
 */
export const differentFaceVector: readonly number[] = normalized(seededVector(1337, -1));

/**
 * A sparse/large set of enrollment captures for `deriveEnrollmentReference`
 * (a few correlated samplings of the reference face).
 */
export function enrollmentVectors(count = 4): readonly (readonly number[])[] {
  const out: (readonly number[])[] = [];
  for (let k = 0; k < count; k += 1) {
    out.push(
      normalized(
        referenceVector.map((x, i) => x + 0.005 * ((i * (k + 1)) % 11 - 5)),
      ),
    );
  }
  return out;
}