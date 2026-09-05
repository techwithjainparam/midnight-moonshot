// PRIVESTATE Level-3 — REAL landmark liveness: the 68-point mesh verifier and
// the fail-closed browser provider boundary (Part 7).
//
// Guards that "real liveness" is genuinely signal-driven:
//   * blink-twice requires two real close→open EAR dips,
//   * turn-left/right requires a real yaw excursion to the target side,
//   * move-closer requires a real face-area increase,
//   * move-head requires real direction flips,
//   * look-up / look-down / raise-hand FAIL CLOSED (never faked into a pass),
//   * the provider boundary returns null / reduced capability when the real
//     face-api module is unavailable, so nothing is ever simulated.
//
// Nothing here touches the DOM, the Midnight contract, or the deployed wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createChallengeTrack,
  verifyChallengeFrame,
  VERIFIABLE_ACTIONS,
  DEFAULT_VERIFIER_THRESHOLDS,
} from '../src/liveness/landmark-verifier';
import type { ChallengeTrack } from '../src/liveness/landmark-verifier';
import {
  UNLOADED_BIOMETRIC_CAPABILITIES,
  UNDETECTABLE_CAPABILITIES,
  realLandmarkProvider,
} from '../src/liveness/landmark-provider';
import type { LandmarkWitness, FaceLandmarkFrame } from '../src/liveness/landmark';

/** Build a usable witness (valid face, open eyes, facing centre, mid area). */
function witness(overrides: Partial<LandmarkWitness> = {}): LandmarkWitness {
  return {
    meanEar: 0.3,
    yawDegrees: 0,
    faceArea: 0.1,
    hasFullLandmarks: true,
    valid: true,
    ...overrides,
  };
}

/**
 * A generic USABLE synthetic frame (single face, confident, in-range area).
 * The verifier gates on `isUsableFace(frame)` but reads the real signals from
 * `evidence.witness`, so the landmark geometry here only needs to satisfy the
 * usability gate — it never needs to be a real face.
 */
function usableFrame(): FaceLandmarkFrame {
  return {
    box: { left: 0.3, top: 0.2, width: 0.4, height: 0.4 },
    detectionScore: 0.95,
    landmarks: Array.from({ length: 68 }, () => ({ x: 0.5, y: 0.5 })),
    faceCount: 1,
  };
}

/**
 * A frame whose derived witness is funneled via `evidence.witness`, paired with
 * a usable synthetic frame so the usability gate passes.
 */
function ev(w: LandmarkWitness) {
  return { frame: usableFrame(), witness: w };
}

/** Drive one action through the supplied witness frames, returning the track. */
function runFrames(
  action: string,
  frames: readonly LandmarkWitness[],
): { track: ChallengeTrack; outcomes: readonly string[] } {
  const track = createChallengeTrack(action as ChallengeTrack['action'], 0);
  const outcomes: string[] = [];
  let t = track;
  for (const f of frames) {
    const r = verifyChallengeFrame(t, ev(f), {});
    t = r.next;
    outcomes.push(r.outcome.status);
  }
  return { track: t, outcomes };
}

test('blink-twice requires TWO real close->open EAR dips', () => {
  const eyeClosed: LandmarkWitness = witness({ meanEar: DEFAULT_VERIFIER_THRESHOLDS.closedEar - 0.02 });
  const eyeOpen: LandmarkWitness = witness({ meanEar: DEFAULT_VERIFIER_THRESHOLDS.openEar + 0.02 });
  // One blink is not enough.
  const one = runFrames('blink-twice', [eyeClosed, eyeOpen]);
  assert.equal(one.track.blinks, 1);
  assert.notEqual(one.outcomes[one.outcomes.length - 1], 'completed');
  // Two blinks complete the challenge.
  const two = runFrames('blink-twice', [eyeClosed, eyeOpen, eyeClosed, eyeOpen]);
  assert.equal(two.track.blinks, 2);
  assert.equal(two.outcomes[two.outcomes.length - 1], 'completed');
});

test('blink never completes from a sustained closed state (no double count)', () => {
  const eyeClosed: LandmarkWitness = witness({ meanEar: DEFAULT_VERIFIER_THRESHOLDS.closedEar - 0.02 });
  const held = runFrames('blink-twice', [eyeClosed, eyeClosed, eyeClosed, eyeClosed]);
  assert.equal(held.track.blinks, 0);
});

test('turn-left requires a real yaw excursion to the LEFT side', () => {
  const left: LandmarkWitness = witness({ yawDegrees: DEFAULT_VERIFIER_THRESHOLDS.yawTurnDegrees + 5 });
  const r = runFrames('turn-left', [{ ...witness(), yawDegrees: 0 }, left, left]);
  assert.equal(r.track.turnedTarget, true);
  assert.equal(r.outcomes[r.outcomes.length - 1], 'completed');
});

test('turn-left does NOT trigger from a RIGHT yaw excursion', () => {
  const right: LandmarkWitness = witness({ yawDegrees: -(DEFAULT_VERIFIER_THRESHOLDS.yawTurnDegrees + 5) });
  const r = runFrames('turn-left', [right, right]);
  assert.equal(r.track.turnedTarget, false);
  assert.notEqual(r.outcomes[r.outcomes.length - 1], 'completed');
});

test('turn-right requires yaw excursion to the RIGHT side', () => {
  const right: LandmarkWitness = witness({ yawDegrees: -(DEFAULT_VERIFIER_THRESHOLDS.yawTurnDegrees + 5) });
  const left: LandmarkWitness = witness({ yawDegrees: DEFAULT_VERIFIER_THRESHOLDS.yawTurnDegrees + 5 });
  const rOk = runFrames('turn-right', [{ ...witness(), yawDegrees: 0 }, right, right]);
  assert.equal(rOk.outcomes[rOk.outcomes.length - 1], 'completed');
  const rFail = runFrames('turn-right', [left, left]);
  assert.notEqual(rFail.outcomes[rFail.outcomes.length - 1], 'completed');
});

test('move-closer requires a real face-area increase', () => {
  const small: LandmarkWitness = witness({ faceArea: 0.05 });
  const big: LandmarkWitness = witness({ faceArea: 0.2 });
  const r = runFrames('move-closer', [small, big]);
  assert.equal(r.track.areaIncreasing, true);
  assert.equal(r.outcomes[r.outcomes.length - 1], 'completed');
});

test('move-closer fails when the face shrinks or stays still', () => {
  const a = witness({ faceArea: 0.2 });
  const smaller: LandmarkWitness = witness({ faceArea: 0.05 });
  const still = runFrames('move-closer', [a, a, a]);
  assert.notEqual(still.outcomes[still.outcomes.length - 1], 'completed');
  const shrinking = runFrames('move-closer', [a, smaller]);
  assert.notEqual(shrinking.outcomes[shrinking.outcomes.length - 1], 'completed');
});

test('move-head requires direction flips (side-to-side motion)', () => {
  const left: LandmarkWitness = witness({ yawDegrees: 30 });
  const right: LandmarkWitness = witness({ yawDegrees: -30 });
  const r = runFrames('move-head', [left, right]);
  assert.equal(r.track.yawFlips, 1);
  assert.notEqual(r.outcomes[r.outcomes.length - 1], 'completed');
  const full = runFrames('move-head', [left, right, left]);
  assert.equal(full.track.yawFlips, 2);
  assert.equal(full.outcomes[full.outcomes.length - 1], 'completed');
});

test('look-up / look-down / raise-hand FAIL CLOSED (never faked)', () => {
  for (const action of ['look-up', 'look-down', 'raise-hand']) {
    const r = runFrames(action as ChallengeTrack['action'], [witness()]);
    assert.equal(r.outcomes[r.outcomes.length - 1], 'invalid', `${action} must be invalid`);
  }
});

test('VERIFIABLE_ACTIONS contains exactly the real, derivable actions', () => {
  assert.deepEqual(VERIFIABLE_ACTIONS.slice().sort(), [
    'blink-twice',
    'move-closer',
    'move-head',
    'turn-left',
    'turn-right',
  ]);
  assert.ok(!VERIFIABLE_ACTIONS.includes('look-up'));
  assert.ok(!VERIFIABLE_ACTIONS.includes('look-down'));
  assert.ok(!VERIFIABLE_ACTIONS.includes('raise-hand'));
});

test('realLandmarkProvider fails CLOSED when the module cannot be loaded', async () => {
  // Simulate an environment where the real face-api module import throws.
  const throwingModule: () => Promise<never> = () =>
    Promise.resolve().then(() => {
      throw new Error('module unavailable');
    });
  const provider = await realLandmarkProvider(throwingModule);
  assert.ok(provider);
  await provider.loadModels();
  // Capabilities must NOT advertise biometric/face detection when unloaded.
  assert.equal(provider.capabilities.faceDetection, false);
  assert.equal(provider.capabilities.biometricActions, false);
  // detect() returns null (no landmarks), never a fabricated result.
  const raw = { width: 64, height: 64, rgb: new Uint8Array(64 * 64 * 3) };
  const detected = await provider.detect(raw);
  assert.equal(detected, null);
});

test('capability constants are mutually consistent (no self-asserted success)', () => {
  // A motion-only actor must NOT claim landmark biometric capabilities.
  assert.equal(UNLOADED_BIOMETRIC_CAPABILITIES.faceDetection, false);
  assert.equal(UNLOADED_BIOMETRIC_CAPABILITIES.motion, true);
  // A fully-undetectable actor claims nothing.
  assert.equal(UNDETECTABLE_CAPABILITIES.motion, false);
  assert.equal(UNDETECTABLE_CAPABILITIES.faceDetection, false);
  assert.equal(UNDETECTABLE_CAPABILITIES.biometricActions, false);
});