// PRIESTATE — Login face-verification state machine (Level 3 Part 6).
//
// An explicit, pure reducer (mirrors src/liveness/state-machine.ts) that
// sequences the LOGIN face-verification stage as a distinct identity step on
// top of the existing 5-factor login. It is deliberately SEPARATE from the
// motion-only liveness machine: the latter answers "live person present?", this
// one additionally drives "live face matches a registered reference?".
//
// Guard rails:
//   * There is NO event that sets "matched = true" directly. The ONLY path to
//     `identity_verified` is a `verification_result` event carrying
//     verdict === 'matched' — which only a real, capable provider with a
//     registered reference can ever produce.
//   * If the provider lacks the required face capability, OR the account has no
//     registered reference identity, the stage fails closed to
//     `verification_unavailable` — it never silently succeeds.
//   * insufficiency / no face / multiple faces / mismatch / camera / timeout
//     each fail closed and block identity_verified.
//
// Privacy: the serialized session holds only state names + a verdict string —
// never a face, embedding, image, or biometric value.

import { FaceMatchVerdict } from './face-verification';

export type LoginFaceStateName =
  | 'idle'
  | 'requesting_camera'
  | 'capability_check'
  | 'face_verification_in_progress'
  | 'identity_verified'
  // terminal failures (each retryable via a fresh session)
  | 'verification_unavailable'
  | 'insufficient_quality'
  | 'mismatch'
  | 'no_face'
  | 'multiple_faces'
  | 'camera_denied'
  | 'camera_unavailable'
  | 'provider_error'
  | 'timeout'
  | 'cancelled';

export type LoginFaceEvent =
  | { type: 'start' }
  | { type: 'camera_ready' }
  | { type: 'capabilities'; capable: boolean; hasReference: boolean }
  | { type: 'verification_result'; verdict: FaceMatchVerdict }
  | { type: 'camera_denied' }
  | { type: 'camera_unavailable' }
  | { type: 'timeout' }
  | { type: 'cancel' };

export type LoginFaceOutcome =
  | { status: 'passed' }
  | { status: 'fail'; reason: LoginFaceFailureReason };

export type LoginFaceFailureReason = Exclude<
  LoginFaceStateName,
  | 'idle'
  | 'requesting_camera'
  | 'capability_check'
  | 'face_verification_in_progress'
  | 'identity_verified'
>;

export interface LoginFaceSession {
  readonly state: LoginFaceStateName;
  /** True once a camera was acquired at least once in this attempt. */
  readonly hadCamera: boolean;
  /** The last provider verdict that ended the attempt (if any). */
  readonly lastVerdict: FaceMatchVerdict | null;
  readonly passedAt: number | null;
  readonly finalOutcome: LoginFaceOutcome | null;
}

export function createLoginFaceSession(): LoginFaceSession {
  return {
    state: 'idle',
    hadCamera: false,
    lastVerdict: null,
    passedAt: null,
    finalOutcome: null,
  };
}

function failWith(session: LoginFaceSession, reason: LoginFaceFailureReason): LoginFaceSession {
  return {
    ...session,
    state: reason,
    finalOutcome: { status: 'fail', reason },
  };
}

function isTerminal(state: LoginFaceStateName): boolean {
  switch (state) {
    case 'identity_verified':
    case 'verification_unavailable':
    case 'insufficient_quality':
    case 'mismatch':
    case 'no_face':
    case 'multiple_faces':
    case 'camera_denied':
    case 'camera_unavailable':
    case 'provider_error':
    case 'timeout':
    case 'cancelled':
      return true;
    default:
      return false;
  }
}

function mapVerdictFailure(verdict: FaceMatchVerdict): LoginFaceFailureReason {
  switch (verdict) {
    case 'mismatch':
      return 'mismatch';
    case 'insufficient_quality':
      return 'insufficient_quality';
    case 'no_face':
      return 'no_face';
    case 'multiple_faces':
      return 'multiple_faces';
    case 'provider_unavailable':
      return 'verification_unavailable';
    case 'error':
    default:
      return 'provider_error';
  }
}

/**
 * Pure transition function. `now` is a wall clock used only for the pass
 * timestamp; pass a controllable clock for deterministic tests.
 */
export function transitionLoginFace(
  session: LoginFaceSession,
  event: LoginFaceEvent,
  now: number,
): LoginFaceSession {
  if (isTerminal(session.state)) {
    // Terminal sessions are frozen; retry creates a fresh one.
    return session;
  }

  switch (session.state) {
    case 'idle':
      if (event.type === 'start') return { ...session, state: 'requesting_camera' };
      return session;

    case 'requesting_camera':
      switch (event.type) {
        case 'camera_ready':
          return { ...session, state: 'capability_check', hadCamera: true };
        case 'camera_denied':
          return failWith(session, 'camera_denied');
        case 'camera_unavailable':
          return failWith(session, 'camera_unavailable');
        case 'cancel':
          return failWith(session, 'cancelled');
        default:
          return session;
      }

    case 'capability_check':
      switch (event.type) {
        case 'capabilities': {
          // The event booleans are produced by the provider's honest
          // capability discovery. Absent capability OR absent reference → the
          // stage can never match, so it fails closed. There is no branch that
          // "skips" verification to reach identity_verified.
          if (!event.capable) return failWith(session, 'verification_unavailable');
          if (!event.hasReference) return failWith(session, 'verification_unavailable');
          return { ...session, state: 'face_verification_in_progress' };
        }
        case 'camera_unavailable':
          return failWith(session, 'camera_unavailable');
        case 'cancel':
          return failWith(session, 'cancelled');
        default:
          return session;
      }

    case 'face_verification_in_progress':
      switch (event.type) {
        case 'verification_result':
          if (event.verdict === 'matched') {
            return {
              ...session,
              state: 'identity_verified',
              lastVerdict: event.verdict,
              passedAt: now,
              finalOutcome: { status: 'passed' },
            };
          }
          return failWith(session, mapVerdictFailure(event.verdict));
        case 'timeout':
          return failWith(session, 'timeout');
        case 'camera_unavailable':
          return failWith(session, 'camera_unavailable');
        case 'cancel':
          return failWith(session, 'cancelled');
        default:
          return session;
      }

    default:
      return session;
  }
}

export { isTerminal };