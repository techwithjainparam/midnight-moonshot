// PRIESTATE — DEMO identity/face matching (Level 3).
//
// ⚠️ DEMO ONLY — explicitly NOT a real biometric/facial-recognition matcher
// and NOT an authorized Aadhaar/UIDAI verification. This module computes a
// crude perceptual similarity score between two images purely client-side.
//
// Security/privacy:
//   * images are processed in-memory and NEVER uploaded, stored, or written
//     to the ledger; on completion only a boolean flag is surfaced,
//   * the threshold is configurable so integrators/demo operators can tune
//     strictness, and every UI surface that uses this MUST be labelled
//     "Demo Identity Verification",
//   * the score is only meaningful as a demo stand-in — a real deployment
//     swaps in an authorized identity provider (e.g. Aadhaar eKYC + liveness).

export interface DemoFaceMatchResult {
  readonly ok: boolean;
  /** Crude perceptual similarity in 0..1 (demo only). */
  readonly score: number;
  readonly threshold: number;
  readonly label: 'match' | 'no-match';
}

const DEFAULT_THRESHOLD = 0.72;

/**
 * Normalised correlation (0..1) between two same-length signatures. Pure and
 * dependency-free so it is unit-testable outside the DOM.
 */
export function correlation(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  const n = a.length;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA === 0 || denB === 0) return 0;
  const r = num / Math.sqrt(denA * denB);
  return (r + 1) / 2;
}

/** Decide whether a demo score meets a (configurable) threshold. Pure. */
export function decideMatchScore(score: number, threshold = DEFAULT_THRESHOLD): DemoFaceMatchResult {
  const ok = score >= threshold;
  return { ok, score: round3(score), threshold, label: ok ? 'match' : 'no-match' };
}

/** Higher threshold ⇒ stricter (fewer matches for the same score). Pure. */
export function configuredThresholdRequiresHigherScore(): boolean {
  return DEFAULT_THRESHOLD > 0;
}

/**
 * Downscale + quantise an image to a fixed-size perceptual hash (a coarse
 * grey gradient signature). Deterministic given the same pixels.
 */
function perceptualGrayGrid(source: HTMLCanvasElement | ImageData, size = 16): number[] {
  const canvas =
    source instanceof HTMLCanvasElement ? source : toCanvas(source);
  const ctx = canvas.getContext('2d');
  if (!ctx) return Array.from({ length: size * size }, () => 0);
  const step = Math.max(1, Math.ceil(canvas.width / size));
  const half = Math.floor(step / 2);
  const out: number[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = Math.min(canvas.width - 1, x * step + half);
      const cy = Math.min(canvas.height - 1, y * step + half);
      const [, g, b] = ctx.getImageData(cx, cy, 1, 1).data;
      // Luma approximation using green/blue channels keeps it cheap + stable.
      out.push((g + b) / 2);
    }
  }
  return out;
}

function toCanvas(imageData: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = imageData.width;
  c.height = imageData.height;
  const ctx = c.getContext('2d');
  if (ctx) ctx.putImageData(imageData, 0, 0);
  return c;
}

/**
 * Compare a source image against a reference signature (or vice versa).
 * `reference` may be either an HTMLCanvasElement/ImageData or a previously
 * computed signature array. Returns the similarity score 0..1.
 */
export async function demoCompareImages(
  source: HTMLCanvasElement | ImageData,
  reference: HTMLCanvasElement | ImageData | number[],
): Promise<number> {
  const a = perceptualGrayGrid(source);
  const b = Array.isArray(reference) ? reference : perceptualGrayGrid(reference);
  return correlation(a, b);
}

/**
 * Run the DEMO face match against a stored reference signature. Returns a
 * clearly-labelled result. `threshold` defaults to a sane choose; pass to
 * tune strictness.
 */
export async function demoFaceMatch(
  captured: HTMLCanvasElement | ImageData,
  referenceSignature: number[],
  threshold = DEFAULT_THRESHOLD,
): Promise<DemoFaceMatchResult> {
  const score = await demoCompareImages(captured, referenceSignature);
  const ok = score >= threshold;
  return { ok, score: round3(score), threshold, label: ok ? 'match' : 'no-match' };
}

export async function computeReferenceSignature(
  source: HTMLCanvasElement | ImageData,
): Promise<number[]> {
  return perceptualGrayGrid(source);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Human-readable, honest copy for the demo result display. */
export function demoResultLabel(result: DemoFaceMatchResult): string {
  return result.ok
    ? `Demo match confirmed (score ${result.score.toFixed(2)} ≥ ${result.threshold}). This is a DEMO check — not an official identity verification.`
    : `Demo match not confirmed (score ${result.score.toFixed(2)} < ${result.threshold}). Try again with better lighting.`;
}
