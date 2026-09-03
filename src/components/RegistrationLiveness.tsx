// PRIESTATE — Registration liveness check (Level 3 Part 4).
//
// UNITS the pure liveness modules with the browser camera:
//   * requests camera permission explicitly and shows a live preview,
//   * walks the user through a RANDOMIZED sequence of observable motion
//     challenges,
//   * derives liveness ONLY from detected frame-to-frame motion (never a
//     fake "isHuman" boolean),
//   * fails closed on camera denied/unavailable and on unsupported challenges,
//   * stops all camera tracks on finish or unmount — no retained access,
//   * keeps every frame in memory; nothing is stored, logged, or uploaded.
//
// Honesty: this engine observes MOTION, not faces/poses/gestures. A real
// provider can advertise more capability later; the state machine and this
// component will happily drive blink/pose challenges once that exists, and
// will still fail closed otherwise.

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  IN_MEMORY_VISION_CAPABILITIES,
  analyzeFrameMotion,
  assessFrameQuality,
  type GreyFrame,
} from '../liveness/vision-provider';
import {
  buildChallengeSequence,
  sequenceIsEmpty,
} from '../liveness/challenges';
import {
  createLivenessSession,
  transitionLiveness,
  type LivenessSession,
} from '../liveness/state-machine';
import { guidanceForQuality, motionHint } from '../liveness/guidance';
import { requestCamera, type CameraHandle } from '../liveness/camera-capture';

export interface LivenessResult {
  readonly passed: boolean;
  readonly completedAt: number;
}

interface RegistrationLivenessProps {
  /** Callback with the liveness outcome (after a full pass or a failure). */
  readonly onComplete?: (result: LivenessResult) => void;
  /** Number of randomized challenges to run. */
  readonly challengeCount?: number;
}

export default function RegistrationLiveness({
  onComplete,
  challengeCount = 3,
}: RegistrationLivenessProps) {
  const [session, setSession] = useState<LivenessSession>(() =>
    createLivenessSession([]),
  );
  const [camera, setCamera] = useState<CameraHandle | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<readonly string[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const prevFrameRef = useRef<GreyFrame | null>(null);
  const pendingSessionRef = useRef<LivenessSession>(session);

  /** Build a fresh randomized sequence, or reset to an empty (fail-closed) one. */
  const freshSession = (): LivenessSession => {
    const seq = buildChallengeSequence(IN_MEMORY_VISION_CAPABILITIES, challengeCount);
    if (sequenceIsEmpty(seq)) return createLivenessSession([]);
    return createLivenessSession(seq);
  };

  const start = useCallback(async () => {
    setCameraError(null);
    setGuidance([]);
    const s = freshSession();
    setSession(transitionLiveness(s, { type: 'start' }, Date.now()));
    pendingSessionRef.current = transitionLiveness(s, { type: 'start' }, Date.now());

    try {
      const handle = await requestCamera();
      setCamera(handle);
      if (videoRef.current) {
        videoRef.current.srcObject = handle.video.srcObject;
        void videoRef.current.play?.();
      }
      const s2 = transitionLiveness(pendingSessionRef.current, { type: 'camera_ready' }, Date.now());
      setSession(s2);
      pendingSessionRef.current = s2;
    } catch (err) {
      const kind =
        err instanceof Error && (err as unknown as { kind?: string }).kind
          ? (err as unknown as { kind: 'denied' | 'unavailable' | 'unsupported' }).kind
          : 'unavailable';
      setCameraError(
        kind === 'denied'
          ? 'Camera permission was denied. Allow camera access and try again.'
          : kind === 'unsupported'
            ? 'This browser or device does not support camera capture.'
            : 'No camera is available on this device.',
      );
      const ev = kind === 'denied'
        ? ({ type: 'camera_denied' } as const)
        : ({ type: 'camera_unavailable' } as const);
      const s2 = transitionLiveness(pendingSessionRef.current, ev, Date.now());
      setSession(s2);
      pendingSessionRef.current = s2;
    }
  }, [challengeCount]);

  // Process each live frame: quality gate → challenge motion.
  const onFrame = useCallback(async () => {
    const cam = camera;
    if (!cam) return;
    const curr = cam.sample(16);
    const quality = assessFrameQuality(curr);
    setGuidance(guidanceForQuality(quality));

    let next = pendingSessionRef.current;
    if (next.state === 'camera_ready') {
      // Hold at quality gate until a usable frame is observed.
      if (!quality.usable) {
        next = transitionLiveness(next, { type: 'frame', observation: { motionDetected: false, motionMagnitude: 0 } }, Date.now());
        setSession(next);
        pendingSessionRef.current = next;
        return;
      }
      next = transitionLiveness(next, { type: 'quality_ok' }, Date.now());
    }
    if (next.state === 'challenge_active') {
      const prev = prevFrameRef.current;
      const obs = analyzeFrameMotion(prev, curr);
      prevFrameRef.current = curr;
      next = transitionLiveness(next, { type: 'frame', observation: obs }, Date.now());
    }
    setSession(next);
    pendingSessionRef.current = next;

    if (next.state === 'liveness_passed') {
      cam.stop();
      setCamera(null);
      prevFrameRef.current = null;
      onComplete?.({ passed: true, completedAt: Date.now() });
      return;
    }
    if (isFailureOutcome(next)) {
      cam.stop();
      setCamera(null);
      prevFrameRef.current = null;
      onComplete?.({ passed: false, completedAt: Date.now() });
    }
  }, [camera, onComplete]);

  useEffect(() => {
    if (!camera) return;
    // Poll the live video for frames while the challenge is active.
    const id = window.setInterval(() => {
      void onFrame();
    }, 120);
    return () => window.clearInterval(id);
  }, [camera, onFrame]);

  // Always stop the camera on unmount.
  useEffect(() => {
    return () => {
      if (camera) camera.stop();
      pendingSessionRef.current = createLivenessSession([]);
    };
  }, [camera]);

  const retry = useCallback(() => {
    if (camera) {
      camera.stop();
      setCamera(null);
    }
    prevFrameRef.current = null;
    setCameraError(null);
    setGuidance([]);
    const s = freshSession();
    setSession(s);
    void start();
  }, [camera, start]);

  const activeChallenge =
    session.challenges.length > 0 && session.state === 'challenge_active'
      ? session.challenges[Math.min(session.currentChallengeIndex, session.challenges.length - 1)]
      : null;

  const progressText =
    session.state === 'challenge_active' && activeChallenge
      ? activeChallenge.instruction
      : session.state === 'camera_ready'
        ? 'Preparing…'
        : session.state === 'liveness_passed'
          ? 'Liveness passed'
          : 'Starting…';

  const challengeLabel =
    session.challenges.length > 0 && session.state === 'challenge_active'
      ? `Challenge ${session.currentChallengeIndex + 1} of ${session.challenges.length}`
      : '';

  return (
    <section className="liveness-card" aria-label="Live identity check">
      <h2 className="liveness-title">Live Identity Check</h2>
      <p className="liveness-subtitle">
        Follow the instruction shown below. Registration is complete only after
        this liveness check succeeds — a static photo or replay cannot pass.
      </p>

      <div className="liveness-preview">
        {(session.state === 'requesting_camera' || session.state === 'camera_ready' || session.state === 'challenge_active') && camera ? (
          <video
            ref={videoRef}
            playsInline
            autoPlay
            muted
            className="liveness-video"
            aria-label="Camera preview"
          />
        ) : (
          <div className="liveness-placeholder">
            {session.state === 'camera_denied'
              ? 'Camera permission denied'
              : session.state === 'camera_unavailable'
                ? 'Camera unavailable'
                : session.state === 'vision_unavailable'
                  ? 'Liveness unavailable on this device'
                  : session.state === 'liveness_passed'
                    ? 'Liveness passed'
                    : 'Camera preview'}
          </div>
        )}
      </div>

      <div className="liveness-challenge">
        <div className="liveness-progress" role="progressbar" aria-valuenow={session.currentChallengeIndex + 1} aria-valuemax={session.challenges.length || 1}>
          {Array.from({ length: session.challenges.length }).map((_, i) => (
            <span key={i} className={`liveness-dot${i < session.currentChallengeIndex ? ' done' : i === session.currentChallengeIndex ? ' active' : ''}`} />
          ))}
        </div>
        <p className="liveness-instruction">{progressText}</p>
        {challengeLabel && <span className="liveness-counter">{challengeLabel}</span>}
        {guidance.length > 0 && (
          <ul className="liveness-guidance">
            {guidance.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
            {session.state === 'challenge_active' && (
              <li>{motionHint(session.currentAttempts)}</li>
            )}
          </ul>
        )}
      </div>

      {(session.state === 'idle' || session.state === 'requesting_camera') && !camera && (
        <button type="button" className="btn btn-primary" onClick={() => void start()}>
          Start liveness check
        </button>
      )}

      {cameraError && (
        <div className="status-msg error" role="alert">{cameraError}</div>
      )}
      {session.state === 'camera_denied' && (
        <div className="status-msg error" role="alert">
          Camera permission was denied. Allow camera access and try again.
        </div>
      )}
      {session.state === 'camera_unavailable' && (
        <div className="status-msg error" role="alert">
          No camera was found, or the camera is in use elsewhere.
        </div>
      )}
      {session.state === 'vision_unavailable' && (
        <div className="status-msg error" role="alert">
          Liveness cannot be verified on this device/browser because the vision
          capability is unavailable. No check was simulated.
        </div>
      )}
      {session.state === 'challenge_failed' && (
        <div className="status-msg error" role="alert">
          We could not confirm the requested movement. Please try again.
        </div>
      )}
      {session.state === 'timeout' && (
        <div className="status-msg error" role="alert">
          The liveness check timed out. Please try again.
        </div>
      )}

      <p className="liveness-privacy">
        Privacy: your camera feed is processed entirely in memory and is never
        stored, logged, or uploaded. We stop using the camera as soon as this
        check finishes.
      </p>

      {isFailureOutcome(session) && (
        <div className="status-msg error" role="alert">
          Liveness could not be confirmed. Please try again.
        </div>
      )}
      {isFailureOutcome(session) && (
        <button type="button" className="btn btn-ghost" onClick={() => void retry()}>
          Retry
        </button>
      )}
    </section>
  );
}

/** True when a liveness session ended in a non-pass failure state. */
function isFailureOutcome(session: LivenessSession): boolean {
  return session.finalOutcome !== null && session.state !== 'liveness_passed';
}