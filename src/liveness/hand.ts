// PRIESTATE — Real hand/finger gesture observation model (registration liveness,
// hand-up + finger-count challenges).
//
// Dependency-free, pure geometric analysis of MediaPipe Hands' 21-landmark hand
// mesh, normalised to 0..1 image space. It answers exactly what the server's
// hand challenges need, from REAL model output — never fabricated:
//
//   * finger-count: how many fingers are genuinely extended (thumb..pinky),
//   * raised: whether one hand is present, confident, and fully in frame,
//     sustained over time by the caller before any evidence is submitted.
//
// MediaPipe Hands landmark indices (21-point scheme, all 0..1 normalised):
//
//   0 wrist | 1-4 thumb (CMC, MCP, IP, TIP) | 5-8 index (MCP, PIP, DIP, TIP)
//   9-12 middle | 13-16 ring | 17-20 pinky
//
// EXTENSION TEST: a finger is considered extended when its joints are nearly
// straight — measured as the interior "opening" angle at each controlling joint
// (PIP and DIP for index/middle/ring/pinky; IP for the thumb). Straight ≈ 180°;
// curled fingers drive the angle down. Anything degenerate or below the
// threshold counts as folded, so the classifier fails toward fewer fingers —
// the server still range-validates the submitted count.
//
// HONESTY: this module only interprets geometry it is handed. If no landmarks
// arrive (no hand, low confidence, model not loaded) the caller gets a
// fail-closed `null` — there is no default "it must be a hand" branch.

import type { LandmarkPoint } from './landmark';

/** MediaPipe Hands 21-point landmark indices. */
export const HAND = {
  WRIST: 0,
  THUMB: { CMC: 1, MCP: 2, IP: 3, TIP: 4 },
  INDEX: { MCP: 5, PIP: 6, DIP: 7, TIP: 8 },
  MIDDLE: { MCP: 9, PIP: 10, DIP: 11, TIP: 12 },
  RING: { MCP: 13, PIP: 14, DIP: 15, TIP: 16 },
  PINKY: { MCP: 17, PIP: 18, DIP: 19, TIP: 20 },
} as const;

/** A real hand detection, as produced by the MediaPipe provider. */
export interface HandLandmarks {
  /** Exactly (or at least) the 21 MediaPipe hand landmarks, 0..1 normalised. */
  readonly landmarks: readonly LandmarkPoint[];
  /** Model confidence 0..1 for the detected hand. */
  readonly score: number;
}

/** Classification of a single detected hand frame. */
export interface HandObservation {
  /** Number of extended fingers, 0..5 in order [thumb, index, middle, ring, pinky]. */
  readonly count: number;
  /** True when one hand is confidently present and fully inside the frame. */
  readonly raised: boolean;
  /** Confidence 0..1 of the underlying detection. */
  readonly score: number;
  /** Per-finger extension, [thumb, index, middle, ring, pinky]. */
  readonly fingers: readonly [boolean, boolean, boolean, boolean, boolean];
}

/** Extension-angle thresholds (degrees). Straight ≈ 180°; below → folded. */
export const HAND_THRESHOLDS = {
  /** Index/middle/ring/pinky: joint opening angle at PIP and DIP. */
  fingerStraightDegrees: 150,
  /** Thumb: opening angle at the IP joint (tolerates the thumb's natural bend). */
  thumbStraightDegrees: 140,
  /** Minimum model confidence to treat a hand as a genuine detection. */
  minScore: 0.5,
  /** Hand must be well inside the frame to count as "raised/fully visible". */
  frameMargin: 0.03,
  /** Minimum palm span (fraction of frame) to reject degenerate detections. */
  minSpan: 0.04,
} as const;

/**
 * Classify one hand frame. Returns `null` (never a "default hand") when the
 * landmarks are missing, degenerate, or below the confidence gate.
 */
export function classifyHand(hand: HandLandmarks | null | undefined): HandObservation | null {
  if (!hand) return null;
  const lm = hand.landmarks;
  if (lm.length < HAND.PINKY.TIP + 1) return null;
  if (!hand.score || hand.score < HAND_THRESHOLDS.minScore) return null;

  const thumb = openAngle(lm[HAND.THUMB.MCP], lm[HAND.THUMB.IP], lm[HAND.THUMB.TIP]) >= HAND_THRESHOLDS.thumbStraightDegrees;
  const index =
    openAngle(lm[HAND.INDEX.MCP], lm[HAND.INDEX.PIP], lm[HAND.INDEX.TIP]) >= HAND_THRESHOLDS.fingerStraightDegrees &&
    openAngle(lm[HAND.INDEX.PIP], lm[HAND.INDEX.DIP], lm[HAND.INDEX.TIP]) >= HAND_THRESHOLDS.fingerStraightDegrees;
  const middle =
    openAngle(lm[HAND.MIDDLE.MCP], lm[HAND.MIDDLE.PIP], lm[HAND.MIDDLE.TIP]) >= HAND_THRESHOLDS.fingerStraightDegrees &&
    openAngle(lm[HAND.MIDDLE.PIP], lm[HAND.MIDDLE.DIP], lm[HAND.MIDDLE.TIP]) >= HAND_THRESHOLDS.fingerStraightDegrees;
  const ring =
    openAngle(lm[HAND.RING.MCP], lm[HAND.RING.PIP], lm[HAND.RING.TIP]) >= HAND_THRESHOLDS.fingerStraightDegrees &&
    openAngle(lm[HAND.RING.PIP], lm[HAND.RING.DIP], lm[HAND.RING.TIP]) >= HAND_THRESHOLDS.fingerStraightDegrees;
  const pinky =
    openAngle(lm[HAND.PINKY.MCP], lm[HAND.PINKY.PIP], lm[HAND.PINKY.TIP]) >= HAND_THRESHOLDS.fingerStraightDegrees &&
    openAngle(lm[HAND.PINKY.PIP], lm[HAND.PINKY.DIP], lm[HAND.PINKY.TIP]) >= HAND_THRESHOLDS.fingerStraightDegrees;

  const fingers: [boolean, boolean, boolean, boolean, boolean] = [thumb, index, middle, ring, pinky];
  const count = fingers.reduce<number>((n, f) => n + (f ? 1 : 0), 0);

  return {
    count,
    raised: handRaised(lm, hand.score),
    score: hand.score,
    fingers,
  };
}

/** One hand, fully inside the frame, confident and non-degenerate. */
function handRaised(lm: readonly LandmarkPoint[], score: number): boolean {
  if (score < 0.6) return false;
  const margin = HAND_THRESHOLDS.frameMargin;
  for (const p of lm) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return false;
    if (!(p.x >= margin && p.x <= 1 - margin)) return false;
    if (!(p.y >= margin && p.y <= 1 - margin)) return false;
  }
  return handSpan(lm) >= HAND_THRESHOLDS.minSpan;
}

/** Palm span: wrist→middle-TIP distance (fraction of the frame). */
export function handSpan(lm: readonly LandmarkPoint[]): number {
  const wrist = lm[HAND.WRIST];
  const tip = lm[HAND.MIDDLE.TIP];
  if (!wrist || !tip) return 0;
  return Math.hypot(wrist.x - tip.x, wrist.y - tip.y);
}

/**
 * Interior "opening" angle in degrees at `joint` between the vectors
 * `(proximal→joint)` and `(joint→distal)`. A straight finger reads ≈ 180°.
 * Returns 0 for degenerate overlapping points so folded is always the
 * fail-closed answer.
 */
export function openAngle(
  proximal: LandmarkPoint,
  joint: LandmarkPoint,
  distal: LandmarkPoint,
): number {
  const [ax, ay] = [proximal.x - joint.x, proximal.y - joint.y];
  const [bx, by] = [distal.x - joint.x, distal.y - joint.y];
  const ma = Math.hypot(ax, ay);
  const mb = Math.hypot(bx, by);
  if (ma < 1e-6 || mb < 1e-6) return 0;
  const cos = (ax * bx + ay * by) / (ma * mb);
  const clamped = Math.max(-1, Math.min(1, cos));
  return (Math.acos(clamped) * 180) / Math.PI;
}

/**
 * Convenience gate mirroring `isUsableFace`: does this observation represent a
 * real, usable hand the caller may begin accumulating evidence from?
 */
export function isUsableHand(obs: HandObservation | null | undefined): obs is HandObservation {
  return Boolean(obs && obs.score >= HAND_THRESHOLDS.minScore && obs.raised);
}