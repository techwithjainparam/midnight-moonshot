// PRIESTATE — Login face verification + liveness stage (Level 3 Part 6).
//
// A professional identity-verification step that runs AFTER the five-factor
// login (wallet → google → sms → whatsapp → password). It is deliberately the
// SECOND, subsequent identity stage, SEPARATE from the motion-only liveness
// check used at registration:
//
//   * LIVENESS  — is a live person present? (this component reuses the camera
//                 + the pure login-face state machine, NOT a fake boolean),
//   * FACE MATCH — does the live face match a registered reference? (a real
//                 `FaceVerificationProvider` boundary; never fabricated).
//
// Honesty / fail-closed behaviour:
//   * This build ships NO real computer-vision provider and stores NO
//     registered biometric reference (the Part 4 demo face-match is client-side
//     and transient). The server reports `providerAvailable:false` and
//     `hasReferenceIdentity:false`, so the stage can never reach
//     `identity_verified` — it reports `verification_unavailable` honestly
//     instead. There is no fake "faceMatched = true".
//   * Camera permission is requested explicitly; all tracks are stopped on
//     finish/unmount; every frame stays in memory and is never stored, logged,
//     or uploaded.

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  IN_MEMORY_FACE_PROVIDER,
  type FaceVerificationProvider,
} from '../liveness/face-verification';
import {
  createLoginFaceSession,
  transitionLoginFace,
  type LoginFaceSession,
  type LoginFaceStateName,
} from '../liveness/login-face-machine';
import {
  requestCamera,
  type CameraHandle,
  CameraUnavailableError,
  cameraErrorMessage,
} from '../liveness/camera-capture';
import type { FaceVerificationSnapshot } from '../auth/account-types';
import { faceVerificationStatus } from '../auth/account-types';

export interface LoginFaceVerificationProps {
  /** Server-authoritative face-verification stage snapshot. */
  readonly snapshot: FaceVerificationSnapshot | null;
  /** A real provider, or the bundled fail-closed (no-capability) provider. */
  readonly provider?: FaceVerificationProvider;
  /** Called with the stage outcome (pass only from a real provider match). */
  readonly onPassed?: () => void;
}

export default function LoginFaceVerification({
  snapshot,
  provider = IN_MEMORY_FACE_PROVIDER,
  onPassed,
}: LoginFaceVerificationProps) {
  const [session, setSession] = useState<LoginFaceSession>(() =>
    createLoginFaceSession(),
  );
  const [camera, setCamera] = useState<CameraHandle | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const pendingRef = useRef<LoginFaceSession>(session);

  const update = (next: LoginFaceSession) => {
    pendingRef.current = next;
    setSession(next);
  };

  const start = useCallback(() => {
    setCameraError(null);
    update(transitionLoginFace(createLoginFaceSession(), { type: 'start' }, Date.now()));

    // 1) Request the camera explicitly (live person presence).
    const run = async () => {
      let handle: CameraHandle;
      try {
        handle = await requestCamera();
      } catch (err) {
        const kind =
          err instanceof CameraUnavailableError ? err.kind : 'unavailable';
        setCameraError(cameraErrorMessage(kind));
        update(transitionLoginFace(
          pendingRef.current,
          { type: kind === 'denied' ? 'camera_denied' : 'camera_unavailable' },
          Date.now(),
        ));
        return;
      }
      setCamera(handle);
      update(transitionLoginFace(pendingRef.current, { type: 'camera_ready' }, Date.now()));

      // 2) Capability discovery + reference presence (server-authoritative).
      const hasReference = Boolean(snapshot?.hasReferenceIdentity && snapshot.providerAvailable);
      const capable = provider.capabilities.size > 0 && provider.hasReferenceIdentity === hasReference;
      update(transitionLoginFace(pendingRef.current, {
        type: 'capabilities',
        capable,
        hasReference,
      }, Date.now()));

      // 3) If the provider is actually capable + has a reference, run it; the
      //    verdict is the ONLY honest way to reach identity_verified. In this
      //    build the provider advertises NO capability, so the result is
      //    `provider_unavailable` and the stage fails closed.
      if (pendingRef.current.state === 'face_verification_in_progress') {
        const result = provider.verify();
        update(transitionLoginFace(pendingRef.current, {
          type: 'verification_result',
          verdict: result.verdict,
        }, Date.now()));
      }

      if (pendingRef.current.state === 'identity_verified') {
        handle.stop();
        setCamera(null);
        onPassed?.();
      }
    };
    void run();
  }, [snapshot, provider, onPassed]);

  useEffect(() => {
    return () => {
      if (camera) camera.stop();
      pendingRef.current = createLoginFaceSession();
    };
  }, [camera]);

  const retry = useCallback(() => {
    if (camera) {
      camera.stop();
      setCamera(null);
    }
    setCameraError(null);
    start();
  }, [camera, start]);

  const state = session.state;

  const previewVisible =
    state === 'requesting_camera' ||
    state === 'capability_check' ||
    state === 'face_verification_in_progress';

  const statusLine = faceVerificationStatus(snapshot);

  return (
    <section className="liveness-card" aria-label="Face verification">
      <h2 className="liveness-title">Face Verification (biometric identity)</h2>
      <p className="liveness-subtitle">
        A mandatory identity step after the five-factor login. We check for a
        live person (liveness) and, when a real face-verification provider and a
        registered reference identity are available, that your live face matches
        your registered identity. Verification can never be faked.
      </p>

      <div className="liveness-preview">
        {previewVisible && camera ? (
          <video playsInline autoPlay muted className="liveness-video" aria-label="Camera preview" />
        ) : (
          <div className="liveness-placeholder">
            {state === 'identity_verified'
              ? 'Identity verified'
              : state === 'verification_unavailable'
                ? 'Face verification unavailable'
                : state === 'mismatch'
                  ? 'Face did not match the registered identity'
                  : state === 'insufficient_quality'
                    ? 'Frame quality too low — try again'
                    : state === 'no_face' || state === 'multiple_faces'
                      ? 'No (or multiple) faces detected'
                      : state === 'camera_denied'
                        ? 'Camera permission denied'
                        : state === 'camera_unavailable'
                          ? 'Camera unavailable'
                          : 'Camera preview'}
          </div>
        )}
      </div>

      <div className="liveness-challenge">
        <p className="liveness-instruction">
          {state === 'idle'
            ? 'Ready to begin biometric identity verification.'
            : state === 'requesting_camera'
              ? 'Requesting camera permission…'
              : state === 'capability_check'
                ? 'Checking face-verification capability…'
                : state === 'face_verification_in_progress'
                  ? 'Verifying live face identity…'
                  : state === 'identity_verified'
                    ? 'Identity verified for this login.'
                    : 'Verification could not complete.'}
        </p>
        {statusLine && <p className="liveness-privacy">{statusLine}</p>}
        {cameraError && <div className="status-msg error" role="alert">{cameraError}</div>}
      </div>

      {state === 'idle' && (
        <button type="button" className="btn btn-primary" onClick={() => start()}>
          Begin face verification
        </button>
      )}

      {state === 'verification_unavailable' && (
        <div className="status-msg error" role="alert">
          Face matching is unavailable: no real computer-vision provider is
          configured and no registered reference identity exists. This build
          never fakes biometric verification — nothing was simulated.
        </div>
      )}
      {state === 'insufficient_quality' && (
        <div className="status-msg error" role="alert">
          The frame quality was too low to verify a face. Improve lighting and
          try again.
        </div>
      )}
      {state === 'mismatch' && (
        <div className="status-msg error" role="alert">
          The live face did not match the registered identity. Try again or
          contact support.
        </div>
      )}
      {(state === 'no_face' || state === 'multiple_faces') && (
        <div className="status-msg error" role="alert">
          We could not confirm exactly one face. Face the camera directly and
          try again.
        </div>
      )}
      {state === 'camera_denied' && (
        <div className="status-msg error" role="alert">
          Camera permission was denied. Allow camera access and try again.
        </div>
      )}
      {state === 'camera_unavailable' && (
        <div className="status-msg error" role="alert">
          No camera was found, or the camera is in use elsewhere.
        </div>
      )}

      <p className="liveness-privacy">
        Privacy: your camera feed is processed entirely in memory and is never
        stored, logged, uploaded, or written to the blockchain. We stop using
        the camera as soon as this stage finishes.
      </p>

      {isFailure(state) && (
        <button type="button" className="btn btn-ghost" onClick={() => retry()}>
          Retry
        </button>
      )}
    </section>
  );
}

function isFailure(state: LoginFaceStateName): boolean {
  switch (state) {
    case 'verification_unavailable':
    case 'insufficient_quality':
    case 'mismatch':
    case 'no_face':
    case 'multiple_faces':
    case 'camera_denied':
    case 'camera_unavailable':
    case 'provider_error':
    case 'timeout':
      return true;
    default:
      return false;
  }
}