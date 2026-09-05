// PRIVESTATE — Real face-landmark observation model (Level 3 Part 7).
//
// Dependency-free, pure data model + geometric analysis for landmark-driven
// liveness. The SELECTED browser provider (@vladmandic/face-api, Landmark68 /
// TinyLandmark68) produces 68-point landmarks in the standard dlib scheme:
//
//   0-16 jawline; 17-26 left brow; 27-35 nose; 36-41 left eye; 42-47 right
//   eye; 48-59 mouth outer; 60-67 mouth inner.
//
// This module consumes ONLY normalised, dimensionless geometry (landmark
// coordinates in 0..1 image space) — never raw pixels. It computes the signals
// the liveness challenges need:
//   * face present + exactly-one usable face (quality/size/position gate),
//   * head-yaw proxy (lateral head turn) from the nose invert axis,
//   * blink detection from the Eye Aspect Ratio (EAR) of the two eyes.
//
// CAPABILITY HONESTY: we compute only what the 68-point mesh genuinely yields.
// A mouth-open/raise-hand action is NOT derivable here, so the challenge
// capability gate must NOT offer it.

/** A single normalised 2D landmark coordinate, x and y in 0..1. */
export interface LandmarkPoint {
  readonly x: number;
  readonly y: number;
}

/** A detected face with its 68 landmarks (normalised coordinate space). */
export interface FaceLandmarkFrame {
  /** 0..1 normalised bounding box of the face within the frame. */
  readonly box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  /** Detector confidence 0..1 (e.g. TinyFaceDetector score). */
  readonly detectionScore: number;
  /** Exactly 68 landmarks, or fewer when the model returned fewer. */
  readonly landmarks: readonly LandmarkPoint[];
  /** Number of faces the detector reported in this frame. */
  readonly faceCount: number;
}

/** A single frame of landmark evidence fed into the challenge verifier. */
export interface LandmarkEvidence {
  /** The primary (highest-confidence) face + landmarks for this frame. */
  readonly frame: FaceLandmarkFrame | null;
  /** Raw witness values the verifier needs (may be pre-computed). */
  readonly witness: LandmarkWitness | null;
}

/** Derived, dimensional analysis of one frame's landmarks. */
export interface LandmarkWitness {
  /** Mean Eye-Aspect-Ratio across both eyes (open≈0.3, blink dips <0.15). */
  readonly meanEar: number;
  /** Head-yaw proxy in degrees (>0 = turned to subject's left, <0 right). */
  readonly yawDegrees: number;
  /** Approx. face area fraction of the frame (0..1). */
  readonly faceArea: number;
  /** Whether a full 68-landmark mesh was recovered. */
  readonly hasFullLandmarks: boolean;
  /** Whether landmark inference produced a valid, non-degenerate result. */
  readonly valid: boolean;
}

/** Landmark indices per the dlib 68-point scheme. */
export const LANDMARK = {
  L_EYE: [36, 37, 38, 39, 40, 41],
  R_EYE: [42, 43, 44, 45, 46, 47],
  NOSE_MID: 27,
  NOSE_TIP: 30,
  CHIN: 8,
} as const;

/**
 * Eye Aspect Ratio (EAR) for a 6-point eye contour. EAR is near-zero when the
 * eye is closed and rises (approx 0.2-0.35) when open. A real blink is a rapid
 * EAR dip followed by recovery.
 */
export function eyeAspectRatio(eye: readonly LandmarkPoint[]): number {
  if (eye.length < 6) return 0;
  const d1 = dist(eye[1], eye[5]);
  const d2 = dist(eye[2], eye[4]);
  const d3 = dist(eye[0], eye[3]);
  if (d3 <= 1e-9) return 1; // degenerate horizontal span → treat as open
  return (d1 + d2) / (2 * d3);
}

/** Compute the mean EAR from a 68-landmark frame. */
export function meanEyeAspectRatio(lm: readonly LandmarkPoint[]): number {
  if (lm.length < 48) return 0;
  const l = LANDMARK.L_EYE.map((i) => lm[i]);
  const r = LANDMARK.R_EYE.map((i) => lm[i]);
  return (eyeAspectRatio(l) + eyeAspectRatio(r)) / 2;
}

/**
 * Head-yaw proxy in degrees from the midline landmarks.
 *
 * Uses the horizontal offset of the nose tip relative to the nose-mid/chin
 * axis. Positive returns indicate the head turned toward the subject's LEFT
 * (nose appears left of centre of the mesh); negative toward the right. This
 * is a geometry proxy, NOT a full 3D pose; callers should use a threshold and
 * treat values near 0 as "facing centre".
 */
export function headYawDegrees(lm: readonly LandmarkPoint[]): number {
  if (lm.length < 31) return 0;
  const mid = lm[LANDMARK.NOSE_MID];
  const tip = lm[LANDMARK.NOSE_TIP];
  const chin = lm[LANDMARK.CHIN];
  // Center x of face = midpoint between nose-mid and chin.
  const cx = (mid.x + chin.x) / 2;
  // Deviation of the nose tip from center, normalised by a width estimate.
  const widthEstimate = Math.max(1e-6, Math.abs(chin.x - mid.x) * 2);
  const dev = (tip.x - cx) / widthEstimate;
  return clamp(dev * 90, -90, 90);
}

/** Approx. face area fraction (normalised). */
export function faceArea(lm: readonly LandmarkPoint[], box: FaceLandmarkFrame['box']): number {
  // Use bounding-box area when landmarks are incomplete.
  if (lm.length < 8) return clamp(box.width * box.height, 0, 1);
  const xs = lm.map((p) => p.x);
  const ys = lm.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  return clamp(w * h, 0, 1);
}

/** Derive a full witness from a frame's landmarks. */
export function deriveWitness(frame: FaceLandmarkFrame | null): LandmarkWitness | null {
  if (!frame || frame.landmarks.length < 48 || frame.detectionScore < 0.5) return null;
  const lm = frame.landmarks;
  return {
    meanEar: meanEyeAspectRatio(lm),
    yawDegrees: headYawDegrees(lm),
    faceArea: faceArea(lm, frame.box),
    hasFullLandmarks: lm.length >= 68,
    valid: true,
  };
}

/** Exactly-one-usable-face gate. Fails closed on zero/multiple faces. */
export function isUsableFace(frame: FaceLandmarkFrame | null): boolean {
  if (!frame) return false;
  if (frame.faceCount !== 1) return false;
  if (frame.detectionScore < 0.5) return false;
  if (frame.landmarks.length < 48) return false;
  const area = clamp(frame.box.width * frame.box.height, 0, 1);
  if (area < 0.02 || area > 0.95) return false; // too small or too big
  return true;
}

function dist(a: LandmarkPoint, b: LandmarkPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}