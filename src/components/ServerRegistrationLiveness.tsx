// PRIESTATE — Registration liveness driven by SERVER-ISSUED challenges (Part 1).
//
// Unlike the self-contained Level 3 liveness card (which picks its own client
// challenges), this component consumes the challenge sequence the server issues
// at `/api/v1/registration/liveness/start` and submits per-challenge evidence
// back to `/api/v1/registration/liveness/evidence`. The server validates the
// order, the values, and the observation window, and only it decides when
// liveness has passed.
//
// HONESTY / FAIL-CLOSED:
//   * The on-device vision is REAL:
//       - blink + head-movement use the 68-point face-landmark mesh,
//       - hand-up + finger-count use the MediaPipe Hands landmarker
//         (`src/liveness/hand-provider.ts` + `hand.ts`) — a genuine ML model
//         run over live camera frames; the classifier counts extended fingers
//         and checks the hand is fully, confidently in frame,
//       - the phrase uses the browser's real (Web Speech API) speech
//         recognition when it is truly available.
//   * A challenge type whose real model is NOT available on this device
//     BLOCKS completion with a clear message. It is NEVER simulated, skipped,
//     or auto-passed.
//   * Gesture evidence is only submitted after the gesture is observed
//     CONTIGUOUSLY for a sustained real-time window from live camera frames;
//     any break in the gesture resets the accumulation.
//   * A mismatch/expiry verdict from the server resets only the current
//     challenge and asks the user to repeat it — it is never papered over.
//   * The camera stream, any active speech recognizer, and the wasm hand model
//     are released on every exit path (complete / fail / cancel / unmount).
//   * No raw pixels, landmark coordinates, or transcripts are stored, logged,
//     or uploaded beyond the single server-issued evidence descriptor.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  requestCamera,
  type CameraHandle,
  type CameraErrorKind,
  cameraErrorMessage,
} from '../liveness/camera-capture';
import { realLandmarkProvider, type LandmarkProvider } from '../liveness/landmark-provider';
import { deriveWitness, isUsableFace, type FaceLandmarkFrame } from '../liveness/landmark';
import { realHandProvider, type HandDetectorProvider } from '../liveness/hand-provider';
import { classifyHand, type HandObservation } from '../liveness/hand';
import type {
  RegistrationLivenessChallenge,
  RegistrationLivenessChallengeType,
  RegistrationLivenessEvidenceInput,
} from '../auth/registration-types';

export type ServerLivenessStartResult =
  | { readonly ok: true; readonly challenges: readonly RegistrationLivenessChallenge[]; readonly expiresInMs: number }
  | { readonly ok: false; readonly reason: string; readonly message?: string };

export type ServerLivenessEvidenceResult =
  | { readonly ok: true; readonly done: boolean; readonly completed: number; readonly total: number }
  | { readonly ok: false; readonly message?: string };

interface ServerRegistrationLivenessProps {
  /** Start (or restart) the server-issued challenge session. */
  readonly onStart: () => Promise<ServerLivenessStartResult>;
  /** Submit evidence for ONE observed challenge; the server decides. */
  readonly onEvidence: (input: RegistrationLivenessEvidenceInput) => Promise<ServerLivenessEvidenceResult>;
  /** `passed` is only true after the server accepted every challenge. */
  readonly onComplete?: (passed: boolean) => void;
}

type Phase = 'idle' | 'starting' | 'setup' | 'running' | 'done' | 'failed';

interface ChallengeTracker {
  type: 'blink' | 'head-movement' | 'hand-up' | 'finger-count';
  startedAt: number;
  blinks: number;
  eyeClosed: boolean;
  prevYawSign: -1 | 0 | 1;
  yawFlips: number;
  /** Hand gestures only: sustained contiguous observation time of the target. */
  gestureObservedMs: number;
  /** Timestamp of the last contiguous qualifying gesture frame (0 = gap). */
  lastGestureAt: number;
  completed: boolean;
}

function freshTracker(
  type: 'blink' | 'head-movement' | 'hand-up' | 'finger-count',
  now: number,
): ChallengeTracker {
  return {
    type,
    startedAt: now,
    blinks: 0,
    eyeClosed: false,
    prevYawSign: 0,
    yawFlips: 0,
    gestureObservedMs: 0,
    lastGestureAt: 0,
    completed: false,
  };
}

/** Blink: one close→open eye transition completes the challenge. */
function applyBlink(track: ChallengeTracker, ear: number): ChallengeTracker {
  if (!track.eyeClosed) {
    if (ear <= 0.14) return { ...track, eyeClosed: true };
    return track;
  }
  if (ear >= 0.2) {
    return { ...track, blinks: track.blinks + 1, eyeClosed: false, completed: track.blinks + 1 >= 1 };
  }
  return track;
}

/** Head movement: one side-to-side yaw excursion (two direction flips). */
function applyHeadMove(track: ChallengeTracker, yaw: number): ChallengeTracker {
  const sign: -1 | 0 | 1 = yaw > 20 ? 1 : yaw < -20 ? -1 : 0;
  let flips = track.yawFlips;
  if (sign !== 0) {
    if (track.prevYawSign !== 0 && sign !== track.prevYawSign) flips += 1;
  }
  return { ...track, prevYawSign: sign, yawFlips: flips, completed: flips >= 2 };
}

/** What a hand challenge needs the classifier to observe. */
interface HandTarget {
  readonly gesture: 'hand-up' | 'finger-count';
  /** finger-count only: the exact number of extended fingers to match. */
  readonly count?: number;
}

/**
 * Sustained-window constants for honest gesture evidence. The server already
 * range-validates `observedMs`; we additionally refuse to submit until the
 * gesture has been genuinely and continuously present for a realistic window.
 */
const HAND_UP_SUSTAIN_MS = 900;
const FINGER_COUNT_SUSTAIN_MS = 1000;
const GESTURE_GAP_MS = 500;
const MAX_SUBMIT_OBSERVED_MS = 20_000;

/**
 * Accumulate contiguous qualifying hand observations. A qualifying frame is one
 * where a confident hand is fully visible and (for finger-count) the classifier
 * reports exactly the target finger count. Any gap resets the window, so a
 * static/replayed or intermittent gesture can never accrue enough evidence.
 */
function applyHandObserve(
  track: ChallengeTracker,
  obs: HandObservation | null,
  target: HandTarget,
  now: number,
): ChallengeTracker {
  const matching =
    Boolean(obs && obs.raised) &&
    (target.gesture === 'hand-up' || (typeof target.count === 'number' && obs?.count === target.count));
  if (!matching) return { ...track, lastGestureAt: 0 };
  if (track.lastGestureAt === 0) return { ...track, lastGestureAt: now, gestureObservedMs: 0 };
  if (now - track.lastGestureAt > GESTURE_GAP_MS) return { ...track, lastGestureAt: now, gestureObservedMs: 0 };
  const sustained = track.gestureObservedMs + (now - track.lastGestureAt);
  const needsMs = target.gesture === 'hand-up' ? HAND_UP_SUSTAIN_MS : FINGER_COUNT_SUSTAIN_MS;
  return {
    ...track,
    lastGestureAt: now,
    gestureObservedMs: sustained,
    completed: sustained >= needsMs,
  };
}

// ── Minimal Web Speech API surface (real browser recognition, not faked) ──

interface SpeechResultEvent {
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
}
interface SpeechRecognitionApi {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionApi;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const CHALLENGE_INSTRUCTIONS: Record<RegistrationLivenessChallengeType, string> = {
  blink: 'Blink once, clearly and deliberately.',
  'head-movement': 'Move your head side to side (look left, then right).',
  'hand-up': 'Raise one hand so it is fully visible in the frame.',
  'finger-count': 'Hold up the requested number of fingers.',
  phrase: 'Say the phrase shown below, out loud.',
};
export default function ServerRegistrationLiveness({
  onStart,
  onEvidence,
  onComplete,
}: ServerRegistrationLivenessProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);

  const cameraRef = useRef<CameraHandle | null>(null);
  const providerRef = useRef<LandmarkProvider | null>(null);
  const handProviderRef = useRef<HandDetectorProvider | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackerRef = useRef<ChallengeTracker | null>(null);
  const challengesRef = useRef<readonly RegistrationLivenessChallenge[]>([]);
  const currentIndexRef = useRef(0);
  const submittingRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionApi | null>(null);
  const phraseStartedAtRef = useRef(0);
  const finishedRef = useRef(false);

  const current = challengesRef.current[currentIndexRef.current] ?? null;

  // ── Session lifecycle ────────────────────────────────────────────

  const stopCamera = useCallback(() => {
    if (cameraRef.current) {
      cameraRef.current.stop();
      cameraRef.current = null;
    }
    videoRef.current = null;
  }, []);

  const stopRecognition = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.stop();
      } catch {
        // already stopped / never started
      }
      recognitionRef.current = null;
    }
  }, []);

  const stopHand = useCallback(() => {
    try {
      handProviderRef.current?.dispose();
    } catch {
      // already disposed / never created
    }
    handProviderRef.current = null;
  }, []);

  const finish = useCallback(
    (passed: boolean) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      stopCamera();
      stopRecognition();
      stopHand();
      setPhase(passed ? 'done' : 'failed');
      onComplete?.(passed);
    },
    [onComplete, stopCamera, stopRecognition, stopHand],
  );

  // Reset helper for the current challenge after a server rejection.
  const resistCurrentChallenge = useCallback((message?: string) => {
    const ch = challengesRef.current[currentIndexRef.current];
    if (!ch) return;
    const type: ChallengeTracker['type'] =
      ch.type === 'hand-up' || ch.type === 'finger-count' ? ch.type : 'blink';
    trackerRef.current = freshTracker(type, Date.now());
    setError(message ?? 'That was not convincingly observed. Try the current challenge again.');
  }, []);

  const advance = useCallback(
    (i: number) => {
      const chs = challengesRef.current;
      if (i >= chs.length) {
        setCompleted(chs.length);
        setCurrentIndex(chs.length);
        finish(true);
        return;
      }
      currentIndexRef.current = i;
      setCurrentIndex(i);
      setCompleted(i);
      setError(null);
      const ch = chs[i];
      if (ch.type === 'blink' || ch.type === 'head-movement') {
        trackerRef.current = freshTracker(ch.type, Date.now());
        setPhase('running');
        return;
      }
      if (ch.type === 'hand-up' || ch.type === 'finger-count') {
        const hp = handProviderRef.current;
        if (!hp || !hp.capabilities.handDetection) {
          setPhase('failed');
          setError(
            `The real hand-tracking model could not be loaded on this device. ` +
              `The ${ch.type === 'hand-up' ? 'hand-raise' : 'finger-count'} challenge requires genuine hand tracking, which is unavailable here. No check was simulated.`,
          );
          return;
        }
        trackerRef.current = freshTracker(ch.type, Date.now());
        setPhase('running');
        setStatusNote(
          ch.type === 'finger-count'
            ? `Hold up exactly ${ch.params.count ?? '?'} fingers, palm toward the camera.`
            : 'Raise one hand fully into the frame and hold it still.',
        );
        return;
      }
      if (ch.type === 'phrase') {
        if (!speechRecognitionCtor()) {
          setPhase('failed');
          setError(
            'The liveness session includes a spoken phrase, but this browser has no speech recognition API. Real liveness cannot be completed here, and no check was simulated.',
          );
          return;
        }
        trackerRef.current = null;
        setPhase('running');
        setStatusNote(`Say exactly: "${ch.params.phrase ?? ''}"`);
        return;
      }
    },
    [finish],
  );

  // ── Start: host the server-issued challenges, then open camera + vision ──

  const start = useCallback(async () => {
    finishedRef.current = false;
    setError(null);
    setStatusNote(null);
    setPhase('starting');
    const res = await onStart();
    if (!res.ok) {
      setPhase('failed');
      setError(res.message ?? 'Could not start the server-issued liveness session.');
      return;
    }
    challengesRef.current = res.challenges;
    setTotal(res.challenges.length);
    setCompleted(0);
    currentIndexRef.current = 0;
    submittingRef.current = false;

    setPhase('setup');
    let prov: LandmarkProvider | null = null;
    try {
      prov = await realLandmarkProvider();
      await prov.loadModels();
    } catch {
      prov = null;
    }
    if (!prov || !prov.capabilities.faceDetection || !prov.capabilities.biometricActions) {
      setPhase('failed');
      setError(
        'The real face-landmark model could not be loaded on this device. Live blink/head liveness is unavailable, and no check was simulated.',
      );
      return;
    }
    providerRef.current = prov;

    // Load the real MediaPipe hand model in parallel with the camera request.
    // It is only retained (and advertised) when it genuinely loads; otherwise
    // a hand challenge fails closed rather than being simulated.
    const handLoad = (async () => {
      try {
        const hp = await realHandProvider();
        await hp.loadModels();
        return hp.capabilities.handDetection ? hp : null;
      } catch {
        return null;
      }
    })();

    let cam: CameraHandle | null = null;
    try {
      cam = await requestCamera();
      cameraRef.current = cam;
      if (videoRef.current) {
        videoRef.current.srcObject = cam.video.srcObject;
        void videoRef.current.play?.();
      }
    } catch (err) {
      const kind: CameraErrorKind =
        err && typeof err === 'object' && 'kind' in err && (err as { kind?: CameraErrorKind }).kind
          ? (err as { kind: CameraErrorKind }).kind
          : 'unavailable';
      setPhase('failed');
      setError(cameraErrorMessage(kind));
      return;
    }

    const hp = await handLoad;
    if (hp) handProviderRef.current = hp;

    advance(0);
  }, [advance, onStart]);

  // ── Frame loop (blink / head-movement / hand-up / finger-count) ───

  const onFrame = useCallback(async () => {
    const ch = challengesRef.current[currentIndexRef.current];
    if (!ch) return;
    if (submittingRef.current) return;
    const cam = cameraRef.current;
    if (!cam) return;

    if (ch.type === 'blink' || ch.type === 'head-movement') {
      const prov = providerRef.current;
      if (!prov) return;
      const raw = cam.captureRaw(512);
      const faces = await prov.detect(raw);
      if (!faces) return;

      const usable = faces.filter((f) => isUsableFace(f)).slice(0, 1)[0];
      const witness = deriveWitness(usable as FaceLandmarkFrame | null);
      if (!witness || !witness.valid) return;

      let track = trackerRef.current;
      if (!track || track.type !== ch.type) track = freshTracker(ch.type, Date.now());
      track = ch.type === 'blink' ? applyBlink(track, witness.meanEar) : applyHeadMove(track, witness.yawDegrees);
      trackerRef.current = track;
      if (track.completed) {
        submittingRef.current = true;
        const observedMs = Math.min(MAX_SUBMIT_OBSERVED_MS, Math.max(300, Date.now() - track.startedAt));
        const result = await onEvidence({ ordinal: ch.ordinal, type: ch.type, observedMs });
        submittingRef.current = false;
        if (result.ok) {
          if (result.done) {
            finish(true);
          } else {
            advance(currentIndexRef.current + 1);
          }
        } else {
          resistCurrentChallenge(result.message);
        }
      }
      return;
    }

    if (ch.type === 'hand-up' || ch.type === 'finger-count') {
      const hp = handProviderRef.current;
      if (!hp || !hp.capabilities.handDetection) return;
      const raw = cam.captureRaw(256);
      const detected = await hp.detect(raw);
      const obs: HandObservation | null = detected ? classifyHand(detected) : null;
      const now = Date.now();
      const target: HandTarget =
        ch.type === 'hand-up'
          ? { gesture: 'hand-up' }
          : { gesture: 'finger-count', count: ch.params.count };

      let track = trackerRef.current;
      if (!track || track.type !== ch.type) track = freshTracker(ch.type, now);
      track = applyHandObserve(track, obs, target, now);
      trackerRef.current = track;
      if (track.completed) {
        submittingRef.current = true;
        const observedMs = Math.min(MAX_SUBMIT_OBSERVED_MS, track.gestureObservedMs);
        const result = await onEvidence(
          ch.type === 'finger-count'
            ? { ordinal: ch.ordinal, type: ch.type, observedMs, count: obs?.count }
            : { ordinal: ch.ordinal, type: ch.type, observedMs },
        );
        submittingRef.current = false;
        if (result.ok) {
          if (result.done) {
            finish(true);
          } else {
            advance(currentIndexRef.current + 1);
          }
        } else {
          resistCurrentChallenge(result.message);
        }
      }
      return;
    }
  }, [advance, finish, onEvidence, resistCurrentChallenge]);

  useEffect(() => {
    if (phase !== 'running') return;
    // Only run vision for the challenge types we genuinely observe.
    const ch = challengesRef.current[currentIndexRef.current];
    if (!ch) return;
    const isFrameVision =
      ch.type === 'blink' ||
      ch.type === 'head-movement' ||
      ch.type === 'hand-up' ||
      ch.type === 'finger-count';
    if (!isFrameVision) return;
    const id = window.setInterval(() => {
      void onFrame();
    }, 120);
    return () => window.clearInterval(id);
  }, [phase, onFrame, currentIndex]);
  // ── Phrase step: real Web Speech recognition ─────────────────────

  const beginPhraseListening = useCallback(() => {
    const ch = challengesRef.current[currentIndexRef.current];
    if (!ch || ch.type !== 'phrase') return;
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      setPhase('failed');
      setError(
        'This browser has no speech recognition API, so the spoken-phrase challenge cannot be completed. No check was simulated.',
      );
      return;
    }
    stopRecognition();
    const rec = new Ctor();
    rec.lang = 'en-IN';
    rec.continuous = false;
    rec.interimResults = false;
    phraseStartedAtRef.current = Date.now();
    setError(null);
    setListening(true);

    let settled = false;
    rec.onresult = (e) => {
      const result = e.results[0];
      if (!result || typeof result[0]?.transcript !== 'string') return;
      if (!result.isFinal) return;
      settled = true;
      stopRecognition();
      setListening(false);
      const transcript = result[0].transcript.trim();
      const observedMs = Math.max(900, Date.now() - phraseStartedAtRef.current);
      void (async () => {
        submittingRef.current = true;
        const r = await onEvidence({ ordinal: ch.ordinal, type: 'phrase', observedMs, transcript });
        submittingRef.current = false;
        if (r.ok) {
          if (r.done) finish(true);
          else advance(currentIndexRef.current + 1);
        } else {
          resistCurrentChallenge(r.message ?? 'The spoken phrase did not match. Try again.');
        }
      })();
    };
    rec.onerror = (e) => {
      if (settled) return;
      settled = true;
      stopRecognition();
      setListening(false);
      setError(`Speech recognition failed${e.error ? ` (${e.error})` : ''}. Try again.`);
    };
    rec.onend = () => {
      if (settled) return;
      settled = true;
      setListening(false);
      setError('Speech recognition ended without a result. Press the button and say the phrase.');
    };
    recognitionRef.current = rec;
    rec.start();
  }, [advance, finish, onEvidence, resistCurrentChallenge, stopRecognition]);

  // ── Cleanup on unmount ───────────────────────────────────────────

  useEffect(() => {
    return () => {
      stopCamera();
      stopRecognition();
      stopHand();
    };
  }, [stopCamera, stopRecognition, stopHand]);

  if (phase === 'idle') {
    return (
      <section className="liveness-card" aria-label="Live liveness check">
        <h2 className="liveness-title">Live Liveness Check</h2>
        <p className="liveness-subtitle">
          The verification server issues a randomized set of challenges. Only a
          real, observed completion of every challenge is accepted — a photo,
          replay, or simulated report cannot pass.
        </p>
        <div className="account-card-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => void start()}>
            Start liveness check
          </button>
        </div>
      </section>
    );
  }

  if (phase === 'starting' || phase === 'setup') {
    return (
      <section className="liveness-card" aria-label="Live liveness check">
        <h2 className="liveness-title">Live Liveness Check</h2>
        <div className="status-msg info" role="status">
          {phase === 'starting' ? 'Requesting your challenge set from the verification server…' : 'Loading camera, face analysis, and hand tracking…'}{' '}
          <span className="spinner-inline" aria-hidden="true" />
        </div>
      </section>
    );
  }

  if (phase === 'failed') {
    return (
      <section className="liveness-card" aria-label="Live liveness check">
        <h2 className="liveness-title">Live Liveness Check</h2>
        {error && <div className="status-msg error" role="alert">{error}</div>}
        <div className="account-card-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void start()}>
            Restart liveness
          </button>
        </div>
      </section>
    );
  }

  if (phase === 'done') {
    return (
      <section className="liveness-card" aria-label="Live liveness check">
        <h2 className="liveness-title">Live Liveness Check</h2>
        <div className="status-msg success" role="status">
          Every server-issued liveness challenge was genuinely completed.
        </div>
      </section>
    );
  }

  const ch = current;
  const showsCamera =
    Boolean(ch) &&
    ['blink', 'head-movement', 'hand-up', 'finger-count'].includes(ch.type) &&
    Boolean(cameraRef.current);

  return (
    <section className="liveness-card" aria-label="Live liveness check">
      <h2 className="liveness-title">Live Liveness Check</h2>

      <div className="liveness-preview">
        {showsCamera ? (
          <video ref={videoRef} playsInline autoPlay muted className="liveness-video" aria-label="Camera preview" />
        ) : (
          <div className="liveness-placeholder">
            {ch && ch.type === 'phrase' ? 'Say the phrase out loud' : 'Camera preview'}
          </div>
        )}
      </div>

      <div className="liveness-challenge">
        <div className="liveness-progress" role="progressbar" aria-valuenow={completed + 1} aria-valuemax={total || 1}>
          {Array.from({ length: total }).map((_, i) => (
            <span key={i} className={`liveness-dot${i < completed ? ' done' : i === completed ? ' active' : ''}`} />
          ))}
        </div>
        {ch ? (
          <p className="liveness-instruction">{CHALLENGE_INSTRUCTIONS[ch.type]}</p>
        ) : (
          <p className="liveness-instruction">Finalizing…</p>
        )}
        {ch && <span className="liveness-counter">Challenge {completed + 1} of {total}</span>}
        {ch && ch.type === 'phrase' && ch.params.phrase && (
          <div className="liveness-guidance" role="status">
            <strong>Say: “{ch.params.phrase}”</strong>
          </div>
        )}
        {ch && ch.type === 'finger-count' && typeof ch.params.count === 'number' && (
          <div className="liveness-guidance" role="status">
            <strong>Hold up {ch.params.count} {ch.params.count === 1 ? 'finger' : 'fingers'}</strong>
          </div>
        )}
        {statusNote && <div className="status-msg info" role="status">{statusNote}</div>}
        {error && <div className="status-msg error" role="alert">{error}</div>}
      </div>

      {ch && ch.type === 'phrase' && (
        <div className="account-card-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={beginPhraseListening} disabled={listening}>
            {listening ? 'Listening…' : 'Start speaking the phrase'}
          </button>
        </div>
      )}

      <p className="liveness-privacy">
        Privacy: your camera feed and microphone are analysed in memory and
        never stored, logged, or uploaded. Only the server-issued evidence
        descriptor is submitted, and the server decides acceptance.
      </p>
    </section>
  );
}
