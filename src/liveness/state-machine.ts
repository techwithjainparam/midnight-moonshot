// PRIESTATE — Liveness session state machine (Level 3 Part 4).
//
// Explicit, pure, and dependency-free so it is fully unit-testable outside the
// DOM. Driven exclusively by events derived from real observations:
//
//   idle → requesting_camera → camera_ready → challenge_active → liveness_passed
//
// Failure states (each with retry semantics):
//   camera_denied | camera_unavailable | vision_unavailable |
//   challenge_failed | timeout | cancelled
//
// There is no event that sets "human = true". The ONLY path to
// `liveness_passed` is completing the randomized sequence of challenges, each
// one consuming observable motion/quality evidence.

import {
  LivenessChallenge,
  LivenessConfig,
  LivenessStateName,
  FrameObservation,
} from './types';

export type LivenessEvent =
  | { type: 'start' }
  | { type: 'camera_ready' }
  | { type: 'frame'; observation: FrameObservation }
  | { type: 'quality_ok' }
  | { type: 'camera_denied' }
  | { type: 'camera_unavailable' }
  | { type: 'vision_unavailable' }
  | { type: 'challenge_failed' }
  | { type: 'timeout' }
  | { type: 'cancel' };

export type LivenessOutcome =
  | { status: 'passed' }
  | { status: 'fail'; reason: FailState };

/** Failure-only states (all terminal except those that stay camera-agnostic). */
export type FailState = Exclude<
  LivenessStateName,
  'idle' | 'requesting_camera' | 'camera_ready' | 'challenge_active' | 'liveness_passed'
>;

export interface LivenessSession {
  readonly state: LivenessStateName;
  readonly currentChallengeIndex: number;
  readonly currentAttempts: number;
  /** The full randomized challenge sequence (origin-independent). */
  readonly challenges: readonly LivenessChallenge[];
  /** True once a camera was attached and handed a usable frame stream. */
  readonly hadCamera: boolean;
  readonly passedAt: number | null;
  readonly finalOutcome: LivenessOutcome | null;
}

export const DEFAULT_LIVENESS_CONFIG: LivenessConfig = {
  challengeCount: 3,
  attemptsPerChallenge: 60,
  sessionTimeoutMs: 90_000,
};

export function createLivenessSession(
  challenges: readonly LivenessChallenge[],
): LivenessSession {
  return {
    state: 'idle',
    currentChallengeIndex: 0,
    currentAttempts: 0,
    challenges,
    hadCamera: false,
    passedAt: null,
    finalOutcome: null,
  };
}

function isTerminal(state: LivenessStateName): boolean {
  switch (state) {
    case 'liveness_passed':
    case 'camera_denied':
    case 'camera_unavailable':
    case 'vision_unavailable':
    case 'challenge_failed':
    case 'timeout':
    case 'cancelled':
      return true;
    default:
      return false;
  }
}

function failWith(
  session: LivenessSession,
  state: FailState,
): LivenessSession {
  return {
    ...session,
    state,
    finalOutcome: { status: 'fail', reason: state },
  };
}

/**
 * Pure transition function. `now` is a wall/relative clock used only for
 * timeout accounting; pass a controllable clock for deterministic tests.
 */
export function transitionLiveness(
  session: LivenessSession,
  event: LivenessEvent,
  now: number,
  config: Partial<LivenessConfig> = {},
): LivenessSession {
  const cfg = { ...DEFAULT_LIVENESS_CONFIG, ...config };

  if (session.finalOutcome) {
    // Terminal states are frozen; a fresh session is created via
    // createLivenessSession for retry, so no restart event is needed here.
    return session;
  }

  switch (session.state) {
    case 'idle':
      if (event.type === 'start') return { ...session, state: 'requesting_camera' };
      return session;

    case 'requesting_camera':
      switch (event.type) {
        case 'camera_ready':
          if (session.challenges.length === 0) return failWith(session, 'vision_unavailable');
          return { ...session, state: 'camera_ready', hadCamera: true };
        case 'camera_denied':
          return failWith(session, 'camera_denied');
        case 'camera_unavailable':
          return failWith(session, 'camera_unavailable');
        case 'vision_unavailable':
          return failWith(session, 'vision_unavailable');
        default:
          return session;
      }

    case 'camera_ready':
      switch (event.type) {
        case 'quality_ok':
          if (session.challenges.length === 0) return failWith(session, 'vision_unavailable');
          return {
            ...session,
            state: 'challenge_active',
            currentChallengeIndex: 0,
            currentAttempts: 0,
          };
        case 'camera_unavailable':
          return failWith(session, 'camera_unavailable');
        case 'vision_unavailable':
          return failWith(session, 'vision_unavailable');
        case 'cancel':
          return failWith(session, 'cancelled');
        default:
          return session;
      }

    case 'challenge_active':
      switch (event.type) {
        case 'timeout':
          return failWith(session, 'timeout');
        case 'challenge_failed':
          return failWith(session, 'challenge_failed');
        case 'camera_unavailable':
          return failWith(session, 'camera_unavailable');
        case 'cancel':
          return failWith(session, 'cancelled');
        case 'frame': {
          const nextAttempts = session.currentAttempts + 1;
          if (event.observation.motionDetected) {
            if (session.currentChallengeIndex + 1 >= session.challenges.length) {
              return {
                ...session,
                state: 'liveness_passed',
                passedAt: now,
                finalOutcome: { status: 'passed' },
              };
            }
            return {
              ...session,
              state: 'challenge_active',
              currentChallengeIndex: session.currentChallengeIndex + 1,
              currentAttempts: 0,
            };
          }
          if (nextAttempts >= cfg.attemptsPerChallenge) {
            return failWith(session, 'challenge_failed');
          }
          return { ...session, currentAttempts: nextAttempts };
        }
        default:
          return session;
      }

    default:
      return session;
  }
}

/** Convenience: a fresh session that is identical to retry-able state. */
export function retrySession(session: LivenessSession): LivenessSession {
  return createLivenessSession(session.challenges);
}

export { isTerminal };