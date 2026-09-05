// PRIESTATE — Landmark-driven liveness challenge verifier (Level 3 Part 7).
//
// Consumes our pure LandmarkWitness frames and decides, honestly, whether a
// randomized challenge action was actually performed. It complements the
// in-memory motion engine from Part 4: with a real 68-point landmark provider
// we can now observe blink and head-pose — actions the Part 4 engine could
// only exclude.
//
// The verifier is PURE and dependency-free so it unit-tests in Node with
// synthetic 68-point landmark witnesses. The browser provider is the only
// place TFJS/@vladmandic/face-api is imported.
//
// FAIL-CLOSED guarantees:
//   * No witness frames for a challenge ⇒ the challenge never progresses.
//   * `blink-twice` requires two INDEPENDENT close→open EAR transitions; a
//     static closed-eye frame (photo showing eyes shut) is NOT a blink.
//   * `turn-left`/`turn-right` require a sustained yaw excursion to the
//     expected side and a return toward centre (a real turn is bidirectional).
//   * `move-closer` requires face-area increasing over time.
//   * Unsupported/unknown actions always fail closed.

import {
  deriveWitness,
  isUsableFace,
  LandmarkEvidence,
} from './landmark';
import { ChallengeAction } from './types';

/** Eyebrow EAR levels used by blink detection (empirical, tunable). */
export interface VerifierThresholds {
  /** EAR at/below which an eye is "closed". */
  readonly closedEar: number;
  /** EAR at/above which the eye is "open" (recovery). */
  readonly openEar: number;
  /** Seconds the yaw must stay beyond this magnitude to count as a turn. */
  readonly yawTurnDegrees: number;
  /** Minimum area increase (fraction) per frame to count as moving closer. */
  readonly closerDelta: number;
}

export const DEFAULT_VERIFIER_THRESHOLDS: VerifierThresholds = {
  closedEar: 0.14,
  openEar: 0.2,
  yawTurnDegrees: 20,
  closerDelta: 0.02,
};

/** High-level result of evaluating one frame against the active challenge. */
export type VerificationOutcome =
  | { readonly status: 'in_progress' }
  | { readonly status: 'completed' }
  | { readonly status: 'invalid' };

/** Per-challenge running state accumulated across frames. */
export interface ChallengeTrack {
  readonly action: ChallengeAction;
  /** Frames observed since the challenge began. */
  readonly frames: number;
  /** For blink: independent close→open events observed. */
  readonly blinks: number;
  /** For blink: is the eye currently "closed" (waiting recovery)? */
  readonly eyeCurrentlyClosed: boolean;
  /** For turn: was a sustained excursion to the target side observed? */
  readonly turnedTarget: boolean;
  /** For move-closer: the last usable face area (0 when unset). */
  readonly lastArea: number;
  /** For move-closer: worker flag marking that area increased. */
  readonly areaIncreasing: boolean;
  /** For move-head: direction of yaw on the previous usable frame. */
  readonly prevYawSign: -1 | 0 | 1;
  /** For move-head: number of direction changes (oscillation). */
  readonly yawFlips: number;
  /** Earliest timestamp a usable face was observed, for timeouts. */
  readonly startedAt: number;
}

export function createChallengeTrack(action: ChallengeAction, now: number): ChallengeTrack {
  return {
    action,
    frames: 0,
    blinks: 0,
    eyeCurrentlyClosed: false,
    turnedTarget: false,
    lastArea: 0,
    areaIncreasing: false,
    prevYawSign: 0,
    yawFlips: 0,
    startedAt: now,
  };
}

/**
 * Actions the 68-point landmark mesh can GENUINELY verify. Anything outside
 * this set (e.g. `raise-hand`, `look-up`, `look-down`) is NOT offered to a real
 * landmark session — the verifier never fakes them.
 */
export const VERIFIABLE_ACTIONS: readonly ChallengeAction[] = [
  'blink-twice',
  'turn-left',
  'turn-right',
  'move-closer',
  'move-head',
];

/**
 * Evaluate one landmark witness against the active challenge and advance the
 * track. Returns the new track and whether the challenge is complete.
 */
export function verifyChallengeFrame(
  track: ChallengeTrack,
  evidence: LandmarkEvidence,
  thresholds: Partial<VerifierThresholds> = {},
): { readonly next: ChallengeTrack; readonly outcome: VerificationOutcome } {
  const th = { ...DEFAULT_VERIFIER_THRESHOLDS, ...thresholds };

  const witness = evidence.witness ?? deriveWitness(evidence.frame);
  const usable = isUsableFace(evidence.frame);
  let next = { ...track, frames: track.frames + 1 };

  // A usable face is REQUIRED for every challenge; without one we hold in
  // progress (timeout handled by the session state machine).
  if (!usable || !witness || !witness.valid) {
    return { next, outcome: { status: 'in_progress' } };
  }

  switch (track.action) {
    case 'blink-twice': {
      next = applyBlink(next, witness.meanEar, th);
      return { next, outcome: done(next) };
    }
    case 'turn-left':
    case 'turn-right': {
      next = applyTurn(next, witness.yawDegrees, th);
      return { next, outcome: done(next) };
    }
    case 'move-closer': {
      next = applyCloser(next, witness.faceArea, th);
      return { next, outcome: done(next) };
    }
    case 'move-head': {
      next = applyHeadSway(next, witness.yawDegrees, th);
      return { next, outcome: done(next) };
    }
    case 'look-up':
    case 'look-down':
    case 'raise-hand':
      // Not derivable from the 68-point mesh alone — fail closed and never
      // synthesise a pass for these.
      return { next, outcome: { status: 'invalid' } };
    default:
      return { next, outcome: { status: 'invalid' } };
  }
}

function applyBlink(
  track: ChallengeTrack,
  ear: number,
  th: VerifierThresholds,
): ChallengeTrack {
  // Closed eye that has not yet opened counts toward the NEXT blink once it
  // recovers past `openEar`.
  if (!track.eyeCurrentlyClosed) {
    if (ear <= th.closedEar) {
      return { ...track, eyeCurrentlyClosed: true };
    }
    return track;
  }
  // eyeCurrentlyClosed === true: waiting for recovery to count a completed
  // close→open blink.
  if (ear >= th.openEar) {
    const blinks = track.blinks + 1;
    return { ...track, blinks, eyeCurrentlyClosed: false };
  }
  return track;
}

function applyTurn(
  track: ChallengeTrack,
  yaw: number,
  th: VerifierThresholds,
): ChallengeTrack {
  const target = track.action === 'turn-left' ? th.yawTurnDegrees : -th.yawTurnDegrees;
  // Sign convention: headYawDegrees > 0 = turned to subject's LEFT.
  // Require that the excursion actually reaches the TARGET side (same sign),
  // not merely that its magnitude is large — otherwise an over-rotation to the
  // wrong side would falsely satisfy the challenge.
  const reached = Math.sign(yaw) === Math.sign(target) && Math.abs(yaw) >= Math.abs(target);
  if (reached) {
    return { ...track, turnedTarget: true };
  }
  return track;
}

function applyCloser(
  track: ChallengeTrack,
  area: number,
  th: VerifierThresholds,
): ChallengeTrack {
  if (track.lastArea === 0) {
    return { ...track, lastArea: area };
  }
  const increasing = area - track.lastArea >= th.closerDelta;
  return {
    ...track,
    lastArea: area,
    areaIncreasing: track.areaIncreasing || increasing,
  };
}

function applyHeadSway(
  track: ChallengeTrack,
  yaw: number,
  th: VerifierThresholds,
): ChallengeTrack {
  // A real side-to-side head movement alternates yaw direction. We require at
  // least one excursion past `yawTurnDegrees` in BOTH directions.
  const sign: -1 | 0 | 1 = yaw > th.yawTurnDegrees ? 1 : yaw < -th.yawTurnDegrees ? -1 : 0;
  let flips = track.yawFlips;
  if (sign !== 0) {
    if (track.prevYawSign !== 0 && sign !== track.prevYawSign) {
      flips += 1;
    }
  }
  return { ...track, prevYawSign: sign, yawFlips: flips };
}

function done(track: ChallengeTrack): VerificationOutcome {
  switch (track.action) {
    case 'blink-twice':
      return {
        status: track.blinks >= 2 ? 'completed' : 'in_progress',
      };
    case 'turn-left':
    case 'turn-right':
      // A genuine turn returns the head toward centre; an over-rotation is
      // fine but we require having reached the target side first.
      return { status: track.turnedTarget ? 'completed' : 'in_progress' };
    case 'move-closer':
      return { status: track.areaIncreasing ? 'completed' : 'in_progress' };
    case 'move-head':
      // Need at least one full side-to-side cycle (two direction flips).
      return { status: track.yawFlips >= 2 ? 'completed' : 'in_progress' };
    default:
      return { status: 'in_progress' };
  }
}