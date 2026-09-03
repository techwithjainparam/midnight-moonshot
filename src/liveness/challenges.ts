// PRIESTATE — Randomized liveness challenge library (Level 3 Part 4).
//
// Liveness is an ACTIVE, randomized sequence of observable actions — never a
// single "is a face here" boolean. The exact sequence is chosen at session
// start via a seeded RNG so it is not predictable from static UI state, but
// reproducible for tests.
//
// A challenge is only offered when the active vision engine advertises the
// capability required to observe it. If the engine cannot detect an action
// (e.g. blink/head-pose), that challenge is EXCLUDED from the sequence rather
// than being faked. This keeps every challenge genuinely verifiable and lets
// a future real provider unlock more actions without changing the UI contract.

import { ChallengeAction, LivenessChallenge, VisionCapabilities } from './types';

/** Canonical definitions for every supported liveness action. */
const CHALLENGES: readonly LivenessChallenge[] = [
  {
    id: 'blink-twice',
    action: 'blink-twice',
    instruction: 'Blink twice',
    requiredCapability: 'biometricActions',
  },
  {
    id: 'turn-left',
    action: 'turn-left',
    instruction: 'Turn your head to the left',
    requiredCapability: 'motion',
  },
  {
    id: 'turn-right',
    action: 'turn-right',
    instruction: 'Turn your head to the right',
    requiredCapability: 'motion',
  },
  {
    id: 'look-up',
    action: 'look-up',
    instruction: 'Look up',
    requiredCapability: 'motion',
  },
  {
    id: 'look-down',
    action: 'look-down',
    instruction: 'Look down',
    requiredCapability: 'motion',
  },
  {
    id: 'move-closer',
    action: 'move-closer',
    instruction: 'Move closer to the camera, then hold still',
    requiredCapability: 'motion',
  },
  {
    id: 'raise-hand',
    action: 'raise-hand',
    instruction: 'Raise one hand and wave briefly',
    requiredCapability: 'biometricActions',
  },
  {
    id: 'move-head',
    action: 'move-head',
    instruction: 'Move your head side to side',
    requiredCapability: 'motion',
  },
];

/** Whether the given action is observable by a set of vision capabilities. */
export function isChallengeSupported(action: ChallengeAction, caps: VisionCapabilities): boolean {
  const def = CHALLENGES.find((c) => c.action === action);
  if (!def) return false;
  switch (def.requiredCapability) {
    case 'biometricActions':
      return caps.biometricActions;
    case 'motion':
      return motionCapability(caps);
    case 'faceDetection':
      return caps.faceDetection;
    default:
      return false;
  }
}

function motionCapability(caps: VisionCapabilities): boolean {
  // Motion-backed actions are observable solely from frame-to-frame motion.
  return caps.motion;
}

/** Fold a capability requirement into the capabilities map for lookup. */
export function supports(caps: VisionCapabilities, requirement: string): boolean {
  switch (requirement) {
    case 'biometricActions':
      return caps.biometricActions;
    case 'faceDetection':
      return caps.faceDetection;
    case 'motion':
      return caps.motion;
    default:
      return false;
  }
}

export function challengeById(id: string): LivenessChallenge | undefined {
  return CHALLENGES.find((c) => c.id === id);
}

export function challengeForAction(action: ChallengeAction): LivenessChallenge | undefined {
  return CHALLENGES.find((c) => c.action === action);
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Build a randomized challenge sequence for a vision engine, guaranteed to be
 * fully observable by that engine's caps. Order is non-deterministic (unless
 * a seed is supplied) and never hard-coded in the UI.
 *
 * Returns the sequence (of length `count`) plus the set of actions considered
 * after filtering — the UI only ever presents supported actions.
 */
export function buildChallengeSequence(
  caps: VisionCapabilities,
  count: number,
  rand: () => number = Math.random,
  seedActions?: readonly ChallengeAction[],
): readonly LivenessChallenge[] {
  // Start from the full definition pool (or an explicit subset in tests).
  const pool = seedActions === undefined
    ? CHALLENGES.slice()
    : CHALLENGES.filter((c) => seedActions.includes(c.action));

  const supported = pool.filter((c) => isChallengeSupported(c.action, caps));
  // Deterministically de-duplicate by action while preserving support filter.
  const uniq = new Map<string, LivenessChallenge>();
  for (const c of supported) uniq.set(c.action, c);

  const eligible = [...uniq.values()];
  if (eligible.length === 0) return [];

  // Pick WITHOUT replacement so a single session never repeats an action.
  const needed = Math.min(count, eligible.length);
  return shuffle(eligible, rand).slice(0, needed);
}

/**
 * Guidance for the active challenge sequence: whether it is empty (meaning the
 * selected engine cannot observe ANY action and liveness must fail closed).
 */
export function sequenceIsEmpty(seq: readonly LivenessChallenge[]): boolean {
  return seq.length === 0;
}