// PRIESTATE — Real registration identity check (Level 3 Part 7).
//
// A COMBINED live session that requires ALL of the following distinct signals
// before registration identity verification can be considered complete:
//   1. wallet/account authentication (enforced by the surrounding page), and
//   2. camera permission, and
//   3. a REAL face + randomized liveness challenge observed via 68-point
//      landmarks (`@vladmandic/face-api`), and
//   4. a mandatory, freshly-observed browser geolocation fix
//      (`navigator.geolocation.watchPosition`).
//
// Capability honesty & fail-closed:
//   * The real landmark provider is loaded lazily. If it (or its models) fail
//     to load we do NOT fall back to a fake "isHuman" — we surface
//     `vision_unavailable`. Motion-only would NOT satisfy "real" liveness.
//   * Location is mandatory: denial or unavailability BLOCKS completion.
//   * Browser GPS is NOT cryptographic physical-location attestation; we say so
//     in the UI and only ever treat it as freshly-observed, user-granted signal.
//
// Cleanup guarantees:
//   * the camera stream and the geolocation watcher are BOTH stopped on every
//     exit path — pass, fail, cancel, and unmount.
//   * no raw pixels, landmark coordinates, or coordinates are stored/logged/
//     uploaded; frames are analysed in memory then discarded.

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  requestCamera,
  type CameraHandle,
  type CameraErrorKind,
  cameraErrorMessage,
} from '../liveness/camera-capture';
import { realLandmarkProvider, REAL_LANDMARK_CAPABILITIES, UNLOADED_BIOMETRIC_CAPABILITIES, type LandmarkProvider } from '../liveness/landmark-provider';
import { deriveWitness, isUsableFace, type FaceLandmarkFrame } from '../liveness/landmark';
import { verifyChallengeFrame, createChallengeTrack, VERIFIABLE_ACTIONS, type ChallengeTrack } from '../liveness/landmark-verifier';
import { buildChallengeSequence, sequenceIsEmpty } from '../liveness/challenges';
import { createLivenessSession, transitionLiveness, type LivenessSession } from '../liveness/state-machine';
import { createLocationWatcher, type LocationSession, type LocationSessionState } from '../liveness/location-watcher';

export interface LivenessResult {
  readonly passed: boolean;
  readonly completedAt: number;
  /** Location fix evidence at completion time, when liveness passed. */
  readonly locationEvidence: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracyMeters: number;
    readonly timestampMs: number;
    readonly nonce: string;
  } | null;
}

interface RegistrationLivenessProps {
  readonly onComplete?: (result: LivenessResult) => void;
  readonly challengeCount?: number;
}

export default function RegistrationLiveness({
  onComplete,
  challengeCount = 3,
}: RegistrationLivenessProps) {
  const [session, setSession] = useState<LivenessSession>(() => createLivenessSession([]));
  const [camera, setCamera] = useState<CameraHandle | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [location, setLocation] = useState<LocationSession | null>(null);
  const [provider, setProvider] = useState<LandmarkProvider | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [locationFailed, setLocationFailed] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSessionRef = useRef<LivenessSession>(session);
  const tracksRef = useRef<Record<string, ChallengeTrack>>({});
  const locationRef = useRef<LocationSession | null>(location);
  const locationHandleRef = useRef<ReturnType<typeof createLocationWatcher> | null>(null);
  const finishedRef = useRef(false);

  const buildSession = (): LivenessSession => {
    // Only offer actions the 68-point mesh genuinely verifies.
    const seq = buildChallengeSequence(REAL_LANDMARK_CAPABILITIES, challengeCount, Math.random, VERIFIABLE_ACTIONS);
    if (sequenceIsEmpty(seq)) return createLivenessSession([]);
    return createLivenessSession(seq);
  };

  const start = useCallback(async () => {
    finishedRef.current = false;
    setCameraError(null);
    setStatusNote(null);
    setLocation(null);
    setLocationFailed(false);

    // 1. Load the real landmark provider; fail closed if it can't load.
    let prov: LandmarkProvider | null = null;
    try {
      prov = await realLandmarkProvider();
      await prov.loadModels();
    } catch {
      prov = null;
    }
    if (!prov || (!prov.capabilities.faceDetection)) {
      setProvider(prov);
      setSession(createLivenessSession([]));
      setStatusNote(
        prov && prov.capabilities === UNLOADED_BIOMETRIC_CAPABILITIES
          ? 'The face-landmark model could not be loaded on this device; real liveness is unavailable. Liveness was NOT simulated.'
          : 'This browser/device does not support real landmark-based liveness. No check was simulated.',
      );
      return; // stays at a fail-closed state (no challenge, no pass)
    }
    setProvider(prov);

    const s = buildSession();
    setSession(transitionLiveness(s, { type: 'start' }, Date.now()));
    pendingSessionRef.current = transitionLiveness(s, { type: 'start' }, Date.now());
    tracksRef.current = {};

    // 2. Start the camera. Location is NOT requested yet — the geolocation gate
    //    begins only after liveness has genuinely passed (see the location effect).
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
      const kind: CameraErrorKind =
        err && typeof err === 'object' && 'kind' in err && (err as { kind?: CameraErrorKind }).kind
          ? (err as { kind: CameraErrorKind }).kind
          : 'unavailable';
      setCameraError(cameraErrorMessage(kind));
      const ev = kind === 'denied' ? ({ type: 'camera_denied' } as const) : ({ type: 'camera_unavailable' } as const);
      const s2 = transitionLiveness(pendingSessionRef.current, ev, Date.now());
      setSession(s2);
      pendingSessionRef.current = s2;
      return;
    }
  }, [challengeCount]);

  // Process each frame: quality gate → landmark challenge → state machine.
  const onFrame = useCallback(async () => {
    const cam = camera;
    const prov = provider;
    if (!cam || !prov) return;

    const raw = cam.captureRaw(512);
    const faces = await prov.detect(raw);
    if (!faces) return; // provider failed → keep waiting (fail closed within attempts)

    const usable = faces.filter((f) => isUsableFace(f)).slice(0, 1)[0];
    const witness = deriveWitness(usable as FaceLandmarkFrame | null);

    let next = pendingSessionRef.current;
    if (next.state === 'camera_ready') {
      // Wait for a usable single face before starting challenges.
      if (!witness) {
        setSession(transitionLiveness(next, { type: 'frame', observation: { motionDetected: false, motionMagnitude: 0 } }, Date.now()));
        pendingSessionRef.current = next;
        return;
      }
      next = transitionLiveness(next, { type: 'quality_ok' }, Date.now());
      tracksRef.current = {};
    }

    if (next.state === 'challenge_active') {
      const challenge = next.challenges[Math.min(next.currentChallengeIndex, next.challenges.length - 1)];
      const key = challenge.id;
      let track = tracksRef.current[key] ?? createChallengeTrack(challenge.action, Date.now());
      const { next: ntrack, outcome } = verifyChallengeFrame(
        track,
        { frame: usable as FaceLandmarkFrame | null, witness },
        {},
      );
      tracksRef.current = { ...tracksRef.current, [key]: ntrack };

      // Advance the state machine ONLY on a genuine, observed completion.
      const completed = outcome.status === 'completed';
      next = transitionLiveness(next, { type: 'frame', observation: { motionDetected: completed, motionMagnitude: completed ? 0.5 : 0 } }, Date.now());
    }
    if (next.state === 'liveness_passed') {
      // The separate location-gate effect performs the final pass decision
      // (it starts the location watcher and waits for a live fix); all we do
      // here is persist state.
      setSession(next);
      pendingSessionRef.current = next;
      return;
    }
    setSession(next);
    pendingSessionRef.current = next;
    if (isFailureOutcome(next)) {
      finish(false);
    }
  }, [camera, provider]);

  const finish = useCallback((passed: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const loc = locationHandleRef.current?.getState();
    const locEvidence = passed && loc && loc.state === 'active' && loc.evidence
      ? loc.evidence
      : null;
    if (camera) {
      camera.stop();
      setCamera(null);
    }
    if (locationHandleRef.current) {
      locationHandleRef.current.stop();
      locationHandleRef.current = null;
    }
    videoRef.current = null;
    setLocation(null);
    locationRef.current = null;
    onComplete?.({
      passed,
      completedAt: Date.now(),
      locationEvidence: locEvidence
        ? {
            latitude: locEvidence.latitude,
            longitude: locEvidence.longitude,
            accuracyMeters: locEvidence.accuracyMeters,
            timestampMs: locEvidence.timestampMs,
            nonce: locEvidence.nonce,
          }
        : null,
    });
  }, [camera, onComplete]);

  useEffect(() => {
    if (!camera) return;
    const id = window.setInterval(() => {
      void onFrame();
    }, 120);
    return () => window.clearInterval(id);
  }, [camera, onFrame]);

  // STRICTLY AFTER LIVENESS gate: the user is only asked for their location
  // once liveness has genuinely passed. On the first `liveness_passed` render
  // we create + start the watcher, then poll it until an active fresh fix
  // (→ finish pass) or a terminal location failure (→ fail closed with retry).
  // The watcher is stopped via `finish`, retry, and unmount.
  useEffect(() => {
    if (finishedRef.current) return;
    pendingSessionRef.current = session;
    if (session.state !== 'liveness_passed') return;

    if (!locationHandleRef.current) {
      const loc = createLocationWatcher();
      locationHandleRef.current = loc;
      locationRef.current = { state: 'requesting', evidence: null, message: null };
      setLocation(locationRef.current);
      loc.start();
      setLocation(loc.getState());
    }

    const id = window.setInterval(() => {
      if (finishedRef.current) return;
      const loc = locationHandleRef.current?.getState();
      if (!loc || loc.state === 'inactive') return;
      setLocation(loc);
      if (loc.state === 'active' && loc.evidence) {
        void finish(true);
        return;
      }
      if (isTerminalLocationState(loc.state)) {
        setStatusNote(
          'Your location could not be verified, so identity verification cannot complete.',
        );
        finish(false);
      }
    }, 250);

    return () => window.clearInterval(id);
  }, [session, finish]);

  // Unmount cleanup: stop camera + location watcher.
  useEffect(() => {
    return () => {
      if (camera) camera.stop();
      if (locationHandleRef.current) locationHandleRef.current.stop();
      locationHandleRef.current = null;
      locationRef.current = null;
      pendingSessionRef.current = createLivenessSession([]);
    };
  }, [camera]);

  const retry = useCallback(() => {
    if (camera) {
      camera.stop();
      setCamera(null);
    }
    if (locationHandleRef.current) {
      locationHandleRef.current.stop();
      locationHandleRef.current = null;
    }
    tracksRef.current = {};
    setCameraError(null);
    setLocation(null);
    setStatusNote(null);
    setLocationFailed(false);
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
        ? 'Detecting your face…'
        : session.state === 'liveness_passed'
          ? 'Liveness passed'
          : 'Starting…';

  return (
    <section className="liveness-card" aria-label="Live identity check">
      <h2 className="liveness-title">Live Identity Check</h2>
      <p className="liveness-subtitle">
        This requires a live face and a genuinely fresh location fix. Your
        location is only requested AFTER your liveness passes. A static photo,
        replay, or faked report cannot pass.
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
        {activeChallenge && <span className="liveness-counter">Challenge {session.currentChallengeIndex + 1} of {session.challenges.length}</span>}

        {location && (
          <div className="liveness-location" role="status">
            {location.state === 'active'
              ? `Location locked (accuracy ±${Math.round(location.evidence!.accuracyMeters)} m).`
              : location.state === 'requesting'
                ? 'Requesting your location…'
                : locationMessage(location.state)}
          </div>
        )}
        {statusNote && (
          <div className="status-msg error" role="alert">{statusNote}</div>
        )}
      </div>

      {(session.state === 'idle' || session.state === 'requesting_camera') && !camera && (
        <button type="button" className="btn btn-primary" onClick={() => void start()}>
          Start identity check
        </button>
      )}

      {cameraError && (
        <div className="status-msg error" role="alert">{cameraError}</div>
      )}
      {session.state === 'camera_denied' && (
        <div className="status-msg error" role="alert">Camera permission was denied. Allow camera access and try again.</div>
      )}
      {session.state === 'camera_unavailable' && (
        <div className="status-msg error" role="alert">No camera was found, or the camera is in use elsewhere.</div>
      )}
      {session.state === 'vision_unavailable' && (
        <div className="status-msg error" role="alert">
          Real liveness cannot be verified on this device/browser (landmark model
          unavailable). No check was simulated and location is not used to fake one.
        </div>
      )}
      {session.state === 'challenge_failed' && (
        <div className="status-msg error" role="alert">We could not confirm the requested movement. Please try again.</div>
      )}
      {session.state === 'timeout' && (
        <div className="status-msg error" role="alert">The identity check timed out. Please try again.</div>
      )}

      <p className="liveness-privacy">
        Privacy: your camera feed is analysed in memory and never stored, logged,
        or uploaded. Your location permission is used only for this check and
        watched live — it is not shared with the ledger. Browser location is not a
        cryptographic proof of physical presence.
      </p>

      {isFailureOutcome(session) && (
        <div className="status-msg error" role="alert">Identity could not be confirmed. Please try again.</div>
      )}
      {isFailureOutcome(session) && (
        <button type="button" className="btn btn-ghost" onClick={() => void retry()}>Retry</button>
      )}
      {locationFailed && (
        <div className="status-msg error" role="alert">
          Location is required to complete identity verification, but your location
          could not be confirmed. No check was faked. You can retry.
        </div>
      )}
      {locationFailed && (
        <button type="button" className="btn btn-ghost" onClick={() => void retry()}>Retry</button>
      )}
    </section>
  );
}

function isFailureOutcome(session: LivenessSession): boolean {
  return session.finalOutcome !== null && session.state !== 'liveness_passed';
}

const TERMINAL_LOCATION_STATES: readonly LocationSessionState[] = [
  'location_denied',
  'location_unavailable',
  'location_timeout',
  'location_stale',
  'location_invalid_cache',
  'location_accuracy_insufficient',
];

function isTerminalLocationState(state: LocationSessionState): boolean {
  return TERMINAL_LOCATION_STATES.includes(state);
}

function locationMessage(state: LocationSessionState): string {
  switch (state) {
    case 'location_denied':
      return 'Location permission was denied — required to complete identity verification.';
    case 'location_unavailable':
      return 'No location signal available. Move near a window and wait.';
    case 'location_timeout':
      return 'Could not acquire location in time. Retry.';
    case 'location_stale':
      return 'Location fix is stale. Retry.';
    case 'location_accuracy_insufficient':
      return 'Location accuracy is too coarse. Move outdoors and retry.';
    case 'location_invalid_cache':
      return 'Reported location is invalid. Retry.';
    default:
      return 'Location unavailable.';
  }
}