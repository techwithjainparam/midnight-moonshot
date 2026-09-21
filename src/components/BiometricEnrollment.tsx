// PRIESTATE — Real biometric reference ENROLLMENT step (Level 3 Part 8).
//
// Runs right after registration finalize: the account session minted at
// finalize authenticates this step. The user's face is captured live from the
// camera, a REAL 128-d embedding is derived with the face-api recognition
// model (weights vendored under /models), and several usable frames are sent to
// the server's single-use enrollment endpoint. ONLY the server sets
// `identityVerified=true` — the client never self-asserts it.
//
// Honesty / fail-closed behaviour:
//   * Camera permission is requested explicitly; tracks stop on finish/unmount.
//   * The descriptor provider is lazily loaded and `ensureReady()` must pass
//     (detector + landmark + recognition nets all loaded). It never fakes an
//     embedding.
//   * At least `minEnrollFrames` (server default 3) usable embeddings must be
//     captured, and explicit consent is required, or enrollment fails closed.
//   * No raw pixels or embeddings are stored, logged, or uploaded except to the
//     server's one-use enrollment endpoint.

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  requestCamera,
  type CameraHandle,
  CameraUnavailableError,
  cameraErrorMessage,
} from '../liveness/camera-capture';
import {
  beginBiometricEnrollment,
  completeBiometricEnrollment,
  type EnrollmentEmbedding,
} from '../auth/account-api';

/** Minimum usable frames we require client-side before completing enrollment. */
const REQUIRED_FRAMES = 3;

export interface BiometricEnrollmentProps {
  /** Called once enrollment completed (identityVerified=true server-side). */
  readonly onEnrolled?: () => void;
}

type Phase =
  | 'idle'
  | 'camera'
  | 'capturing'
  | 'consent'
  | 'uploading'
  | 'enrolled'
  | 'failed';

export default function BiometricEnrollment({ onEnrolled }: BiometricEnrollmentProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [camera, setCamera] = useState<CameraHandle | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [captured, setCaptured] = useState(0);
  const [usable, setUsable] = useState<readonly number[][]>([]);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const embeddingsRef = useRef<number[][]>([]);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (camera && videoRef.current) {
      videoRef.current.srcObject = camera.video.srcObject;
      void videoRef.current.play?.();
    }
  }, [camera]);

  useEffect(() => {
    return () => {
      finishedRef.current = true;
      if (camera) camera.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  const capture = useCallback(async (): Promise<readonly number[][]> => {
    if (!camera) return [];
    const { realDescriptorProvider } = await import('../liveness/face-verification-real');
    const provider = await realDescriptorProvider();
    if (!(await provider.ensureReady())) return [];
    const out: number[][] = [];
    const maxTries = 12;
    for (let i = 0; i < maxTries && out.length < REQUIRED_FRAMES && !finishedRef.current; i += 1) {
      const raw = camera.captureRaw(512);
      const embedding = await provider.descriptor(raw);
      if (embedding && embedding.length === 128) out.push(embedding as unknown as number[]);
      setCaptured(Math.max(out.length, i + 1));
      if (out.length < REQUIRED_FRAMES) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return out;
  }, [camera]);

  const start = useCallback(() => {
    finishedRef.current = false;
    setError(null);
    setStatusNote(null);
    setCaptured(0);
    embeddingsRef.current = [];
    setPhase('camera');
    const run = async () => {
      let handle: CameraHandle;
      try {
        handle = await requestCamera();
      } catch (err) {
        const kind = err instanceof CameraUnavailableError ? err.kind : 'unavailable';
        setCameraError(cameraErrorMessage(kind));
        setPhase('failed');
        setError('Camera is required for biometric enrollment.');
        return;
      }
      setCamera(handle);
      setStatusNote('Hold your face steady in the frame — several samples will be captured.');
      setPhase('capturing');
      const frames = await capture();
      if (finishedRef.current) {
        handle.stop();
        setCamera(null);
        return;
      }
      if (frames.length < REQUIRED_FRAMES) {
        handle.stop();
        setCamera(null);
        setPhase('failed');
        setError(
          `Only ${frames.length} usable face frame${frames.length === 1 ? '' : 's'} were captured (need ${REQUIRED_FRAMES}). Improve lighting, face the camera directly, and try again.`,
        );
        return;
      }
      embeddingsRef.current = frames as number[][];
      setUsable(frames);
      setCaptured(frames.length);
      setStatusNote(null);
      setPhase('consent');
    };
    void run();
  }, [capture]);

  const complete = useCallback(async () => {
    if (!consent) {
      setError('You must consent before enrolling your biometric reference.');
      return;
    }
    setError(null);
    setPhase('uploading');
    try {
      const begin = await beginBiometricEnrollment();
      if (!begin.ok) {
        setPhase('failed');
        setError(
          begin.reason === 'unavailable'
            ? 'Biometric enrollment is not configured on the server in this demo.'
            : begin.reason === 'bad-state'
              ? 'This account is not ready for biometric enrollment right now.'
              : 'Could not begin biometric enrollment.',
        );
        return;
      }
      const done = await completeBiometricEnrollment({
        token: begin.data.token,
        consent: true,
        embeddings: usable as readonly EnrollmentEmbedding[],
      });
      if (!done.ok) {
        setPhase('failed');
        switch (done.reason) {
          case 'unavailable':
            setError('Biometric enrollment is not configured on the server in this demo.');
            break;
          case 'no-consent':
            setError('Consent is required to enroll a biometric reference.');
            break;
          case 'session-invalid':
            setError('The enrollment session expired — start again.');
            break;
          case 'low-quality':
            setError('The captured frames were not consistent enough. Try again with steady lighting.');
            break;
          default:
            setError('Biometric enrollment could not be completed.');
        }
        return;
      }
      finishedRef.current = true;
      if (camera) camera.stop();
      setCamera(null);
      setPhase('enrolled');
      onEnrolled?.();
    } catch {
      setPhase('failed');
      setError('Biometric enrollment could not reach the server. Try again.');
    }
  }, [camera, consent, onEnrolled, usable]);

  const retry = useCallback(() => {
    if (camera) {
      camera.stop();
      setCamera(null);
    }
    setCameraError(null);
    setConsent(false);
    start();
  }, [camera, start]);

  return (
    <section className="liveness-card" aria-label="Biometric enrollment">
      <h2 className="liveness-title">Biometric Enrollment</h2>
      <p className="liveness-subtitle">
        One final identity step: we capture your real face and store an encrypted
        biometric reference on the server. Login is enabled only after this
        reference is registered — it can never be fabricated.
      </p>

      <div className="liveness-preview">
        {phase === 'camera' || phase === 'capturing' ? (
          <video ref={videoRef} playsInline autoPlay muted className="liveness-video" aria-label="Camera preview" />
        ) : (
          <div className="liveness-placeholder">
            {phase === 'enrolled'
              ? 'Biometric reference enrolled'
              : phase === 'consent'
                ? 'Face captured — review consent below'
                : phase === 'uploading'
                  ? 'Uploading encrypted reference…'
                  : phase === 'failed'
                    ? 'Enrollment could not complete'
                    : 'Camera preview'}
          </div>
        )}
      </div>

      <div className="liveness-challenge">
        <p className="liveness-instruction">
          {phase === 'idle'
            ? 'Ready to begin biometric enrollment.'
            : phase === 'camera'
              ? 'Requesting camera permission…'
              : phase === 'capturing'
                ? `Capturing usable face frames… (${captured}/${REQUIRED_FRAMES})`
                : phase === 'consent'
                  ? 'Face captured. Confirm consent to finish enrollment.'
                  : phase === 'uploading'
                    ? 'Securing your biometric reference on the server…'
                    : phase === 'enrolled'
                      ? 'Your biometric reference is registered.'
                      : 'Enrollment failed.'}
        </p>
        {statusNote && <p className="liveness-privacy">{statusNote}</p>}
        {cameraError && <div className="status-msg error" role="alert">{cameraError}</div>}
        {error && <div className="status-msg error" role="alert">{error}</div>}
      </div>

      {phase === 'idle' && (
        <button type="button" className="btn btn-primary" onClick={start}>
          Begin biometric enrollment
        </button>
      )}

      {phase === 'consent' && (
        <div className="form-field">
          <label className="consent-row">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>
              I consent to the server storing an encrypted biometric reference of my face
              for identity verification, and I understand it is never written to the
              blockchain.
            </span>
          </label>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void complete()}
            disabled={!consent}
          >
            Enroll biometric reference
          </button>
        </div>
      )}

      {phase === 'uploading' && (
        <span className="spinner-inline" aria-hidden="true" />
      )}

      {phase === 'failed' && (
        <button type="button" className="btn btn-ghost" onClick={retry}>
          Try again
        </button>
      )}

      <p className="liveness-privacy">
        Privacy: your camera feed is processed entirely in memory. Only a derived
        128-d embedding is sent to the one-use enrollment endpoint; raw pixels,
        landmarks, and embeddings are never stored by this browser.
      </p>
    </section>
  );
}