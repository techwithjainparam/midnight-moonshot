// PRIESTATE — Real hand/finger gesture geometry (registration liveness,
// hand-up + finger-count). Pure, dependency-free classification tests over
// synthetic MediaPipe 21-landmark hands, plus the browser-provider fail-closed
// boundary.
//
// Guards that gesture evidence is GENUINELY derived from the landmark mesh:
//   * an open palm reports exactly 5 extended fingers and is "raised",
//   * a fist reports 0 extended fingers,
//   * each single-finger target (1..4) is classified exactly,
//   * bent joints, missing landmarks, low confidence, and out-of-frame hands
//     FAIL CLOSED (never invent a gesture),
//   * the provider boundary advertises no hand capability and returns null
//     when the real @mediapipe/tasks-vision module cannot be loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyHand,
  HAND,
  isUsableHand,
  openAngle,
  type HandLandmarks,
} from '../src/liveness/hand';
import {
  realHandProvider,
  NO_HAND_CAPABILITIES,
  REAL_HAND_CAPABILITIES,
} from '../src/liveness/hand-provider';

interface Pt {
  x: number;
  y: number;
}

function bent(a: Pt, angleDeg: number, len: number): Pt {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: a.x + len * Math.cos(rad), y: a.y + len * Math.sin(rad) };
}

/**
 * Build a synthetic hand laid out palm-up: wrist at the left, knuckles in a
 * column, fingers extended along +x. `extended` is [thumb, index, middle,
 * ring, pinky]; folded fingers are sharply curled (angle at PIP well below the
 * 150° straightness gate) so only genuinely straight fingers are counted.
 */
function makeHand(opts: {
  readonly extended: boolean[];
  readonly score?: number;
  readonly offset?: Pt;
}): HandLandmarks {
  const { extended, score = 0.98, offset = { x: 0.05, y: 0.05 } } = opts;
  const base = (i: number, p: Pt) => {
    lm[i] = { x: offset.x + p.x, y: offset.y + p.y };
  };
  const lm: Pt[] = [];

  base(HAND.WRIST, { x: 0.0, y: 0.12 });
  base(HAND.THUMB.CMC, { x: 0.03, y: 0.22 });
  base(HAND.THUMB.MCP, { x: 0.08, y: 0.27 });

  const knuckleY = [0.12, 0.165, 0.21, 0.255];
  const FINGERS = ['INDEX', 'MIDDLE', 'RING', 'PINKY'] as const;

  for (let k = 0; k < FINGERS.length; k += 1) {
    const f = FINGERS[k];
    const y = knuckleY[k];
    const mcp = { x: 0.16, y };
    base(HAND[f].MCP, mcp);
    const pip = { x: 0.25, y };
    base(HAND[f].PIP, pip);
    const isExtended = extended[k + 1] ?? false;
    if (isExtended) {
      base(HAND[f].DIP, { x: 0.34, y });
      base(HAND[f].TIP, { x: 0.43, y });
    } else {
      // Curl tightly: DIP and TIP swing down-left (angle at PIP ~ 25°).
      base(HAND[f].DIP, bent(pip, 200, 0.09));
      base(HAND[f].TIP, bent(pip, 200, 0.18));
    }
  }

  const thumbExt = extended[0] ?? false;
  const ip = { x: 0.11, y: 0.3 };
  base(HAND.THUMB.IP, ip);
  // Thumb joint axis points down-right (MCP→IP = (0.03,0.03)); an extended
  // thumb continues straight along it, a folded one curls back the other way.
  base(HAND.THUMB.TIP, thumbExt ? { x: 0.23, y: 0.42 } : bent(ip, -60, 0.08));

  return { landmarks: lm, score };
}

function openPalm(): HandLandmarks {
  return makeHand({ extended: [true, true, true, true, true] });
}

function fist(): HandLandmarks {
  return makeHand({ extended: [false, false, false, false, false] });
}

test('open palm classifies as 5 extended fingers and raised', () => {
  const obs = classifyHand(openPalm());
  assert.ok(obs);
  if (!obs) return;
  assert.equal(obs.count, 5);
  assert.deepEqual(obs.fingers, [true, true, true, true, true]);
  assert.equal(obs.raised, true);
  assert.ok(isUsableHand(obs));
});

test('fist classifies as 0 extended fingers (folded, not ready for gesture evidence)', () => {
  const obs = classifyHand(fist());
  assert.ok(obs);
  if (!obs) return;
  assert.equal(obs.count, 0);
  assert.deepEqual(obs.fingers, [false, false, false, false, false]);
});

test('single-finger targets classify exactly (each non-thumb finger individually)', () => {
  const fingers: Array<[boolean[]]> = [
    [[false, true, false, false, false]],
    [[false, false, true, false, false]],
    [[false, false, false, true, false]],
    [[false, false, false, false, true]],
  ];
  for (const [ext] of fingers) {
    const obs = classifyHand(makeHand({ extended: ext }));
    assert.ok(obs, `${ext}`);
    if (!obs) continue;
    assert.equal(obs.count, 1, `${ext}`);
    assert.deepEqual(obs.fingers, ext, `${ext}`);
  }
});

test('bent/partial fingers never over-count', () => {
  const obs = classifyHand(makeHand({ extended: [false, true, false, false, false] }));
  assert.ok(obs);
  if (!obs) return;
  assert.equal(obs.count, 1);
});

test('low-confidence hand fails closed (null classification)', () => {
  const low = makeHand({ extended: [true, true, true, true, true], score: 0.2 });
  assert.equal(classifyHand(low), null);
});

test('missing/degenerate landmarks fail closed', () => {
  assert.equal(classifyHand(null), null);
  assert.equal(classifyHand(undefined), null);
  assert.equal(classifyHand({ landmarks: [{ x: 0, y: 0 }], score: 0.9 }), null);
  const degenerate: HandLandmarks = {
    landmarks: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 })),
    score: 0.9,
  };
  const obs = classifyHand(degenerate);
  assert.ok(obs);
  if (obs) assert.equal(obs.count, 0);
});

test('out-of-frame hand is never "raised" (sustained evidence requires visibility)', () => {
  // Push the whole hand down so the wrist (y=1.02) exits the frame.
  const obs = classifyHand(makeHand({ extended: [true, true, true, true, true], offset: { x: 0.0, y: 0.9 } }));
  assert.ok(obs);
  if (!obs) return;
  assert.equal(obs.count, 5, 'fingers may still be counted in-plane');
  assert.equal(obs.raised, false, 'but it must not be treatable as raised/hand-up');
  assert.equal(isUsableHand(obs), false);
});

test('openAngle reports ~180 for a straight finger and is degenerate-safe', () => {
  const straight = openAngle({ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.2, y: 0 });
  assert.ok(Math.abs(straight - 180) < 0.001, `got ${straight}`);
  const bent = openAngle({ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.1, y: 0.1 });
  assert.ok(bent < 180 && bent > 40, `got ${bent}`);
  // Degenerate overlapping points → 0 (counts as folded / fail-closed).
  assert.equal(openAngle({ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.1, y: 0 }), 0);
});

test('capability constants: nothing advertises hand detection unless loaded', () => {
  assert.equal(NO_HAND_CAPABILITIES.handDetection, false);
  assert.equal(REAL_HAND_CAPABILITIES.handDetection, true);
});

test('realHandProvider fails CLOSED when the module cannot be loaded', async () => {
  const throwing: () => Promise<never> = () =>
    Promise.resolve().then(() => {
      throw new Error('module unavailable');
    });
  const provider = await realHandProvider(throwing);
  assert.ok(provider);
  await provider.loadModels();
  assert.equal(provider.capabilities.handDetection, false);
  const raw = { width: 64, height: 64, rgb: new Uint8Array(64 * 64 * 3) };
  const detected = await provider.detect(raw);
  assert.equal(detected, null);
  provider.dispose();
});