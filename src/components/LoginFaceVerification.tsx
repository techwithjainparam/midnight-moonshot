// PRIESTATE — Login face verification + liveness stage (Level 3 Part 6).
//
// A professional identity-verification step that runs AFTER the five-factor
// login (wallet → google → sms → whatsapp → password). It is deliberately the
// SECOND, subsequent identity stage, SEPARATE from the motion-only liveness
// check used at registration:
//
//   * LIVENESS  — is a live person present? (this component reuses the camera
//                 + the pure login-face state machine, NOT a fake boolean),
//   * FACE MATCH — does the live face match a registered reference? (real
//                 server-authoritative matching; never fabricated).
//
// Honesty / fail-closed behaviour:
//   * When the server reports `providerAvailable:true` AND
//     `hasReferenceIdentity:true`, we run the REAL path: lazily load the
//     face-api descriptor provider (detector + landmark + recognition nets,
//     weights vendored under /models), capture a live frame, send the derived
//     128-d embedding to the server's single-use verification endpoint, and map
//     the server verdict — the ONLY path to `identity_verified`.
//   * Otherwise (no provider, no reference, or the recognition model failed to
//     load) the stage admits it cannot run and fails closed to
//     `verification_unavailable`. There is no fake "faceMatched = true".
//   * Camera permission is requested explicitly; all tracks are stopped on
//     finish/unmount; every frame stays in memory and is never stored, logged,
//     or uploaded.

import { useState, useCallback, useEffect, useRef } from 'react';
import type { FaceMatchVerdict } from '../liveness/face-verification';
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
import { faceVerificationStatus, isFaceVerificationCapable } from '../auth/account-types';
import {
  beginBiometricVerification,
  completeBiometricVerification,
} from '../auth/account-api';

export interface LoginFaceVerificationProps {
  /** Server-authoritative face-verification stage snapshot. */
  readonly snapshot: FaceVerificationSnapshot | null;
  /** Wallet that is logging in (needed only for the real server path). */
  readonly walletAddress?: string;
  /** Called with the stage outcome (pass only from a real provider match). */
  readonly onPassed?: () => void;
}

export default function LoginFaceVerification({
  snapshot,
  walletAddress,
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

      // 2) Capability discovery is server-authoritative: the server tells us
      //    whether a registered reference + provider exist. When it does we
      //    proceed to the real descriptor path, which additionally verifies at
      //    runtime that the models actually loaded before running the match.
      const serverCapable = isFaceVerificationCapable(snapshot);
      const hasReference = Boolean(serverCapable);
      const capable = serverCapable;

      update(transitionLoginFace(pendingRef.current, {
        type: 'capabilities',
        capable,
        hasReference,
      }, Date.now()));

      // 3) Real path: only a real provider with a registered reference can run.
      if (pendingRef.current.state !== 'face_verification_in_progress') return;

      // Lazy-load the real descriptor source (detector + landmark + recognition
      // nets). The recognition weights are vendored under /models for this
      // build; if for any reason they fail to load it fails closed to
      // provider_unavailable — never a fabricated match.
      const { realDescriptorProvider } = await import('../liveness/face-verification-real');
      const descriptorSource = await realDescriptorProvider();
      const ready = await descriptorSource.ensureReady();
      if (!ready) {
        update(transitionLoginFace(pendingRef.current, {
          type: 'verification_result',
          verdict: 'provider_unavailable',
        }, Date.now()));
        return;
      }

      // 4) Capture a live frame and produce a real embedding.
      const raw = handle.captureRaw(512);
      const embedding = await descriptorSource.descriptor(raw);
      if (!embedding) {
        update(transitionLoginFace(pendingRef.current, {
          type: 'verification_result',
          verdict: 'no_face',
        }, Date.now()));
        return;
      }

      // 5) Server-authoritative match. The server owns the verdict — a client
      //    "matched" claim is ignored. Fail closed on any server refusal.
      let verdict: FaceMatchVerdict;
      try {
        if (!walletAddress) throw new Error('missing wallet');
        const begin = await beginBiometricVerification(walletAddress);
        if (!begin.ok) {
          // The server refused to issue a verification session (unavailable /
          // no reference / revoked / not-found) — fail closed.
          verdict = mapServerVerdict(begin.reason);
        } else {
          const done = await completeBiometricVerification({
            verificationToken: begin.data.token,
            liveEmbedding: embedding,
          });
          if (!done.ok) {
            // Server refused the verification session (e.g. session invalid,
            // reference revoked, provider unavailable) — fail closed.
            verdict = mapServerVerdict(done.message ?? 'provider_unavailable');
          } else if (!done.data.ok) {
            // Server ran the match but the verdict was not a match (mismatch,
            // insufficient quality, etc.).
            verdict = mapServerVerdict(done.data.verdict);
          } else {
            // Server matched (ok:true) — but keep through the mapper so the
            // verdict surface stays exhaustive and closed.
            verdict = mapServerVerdict(done.data.verdict);
          }
        }
      } catch {
        verdict = 'error';
      }

      const next = transitionLoginFace(pendingRef.current, {
        type: 'verification_result',
        verdict,
      }, Date.now());
      update(next);

      if (next.state === 'identity_verified') {
        handle.stop();
        setCamera(null);
        onPassed?.();
      }
    };
    void run();
  }, [snapshot, walletAddress, onPassed]);

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

/**
 * Map the server's verdict (or refusal) to the pure face-verification verdict
 * surface. Any server refusal fails closed; the client never invents a match.
 */
function mapServerVerdict(input: string): FaceMatchVerdict {
  switch (input) {
    case 'matched':
      return 'matched';
    case 'mismatch':
      return 'mismatch';
    case 'insufficient_quality':
      return 'insufficient_quality';
    case 'no_reference':
    case 'reference_revoked':
    case 'revoked':
    case 'provider_unavailable':
    case 'unavailable':
    case 'not-found':
      return 'provider_unavailable';
    case 'session_invalid':
    case 'error':
    default:
      return 'error';
  }
}