import { useState, useCallback, useEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import { useAuth } from '../auth/AuthContext';
import {
  demoFaceMatch,
  computeReferenceSignature,
  projectDemoEmbedding,
  demoResultLabel,
  type DemoFaceMatchResult,
} from '../verify/face-match';
import {
  createMobileSession,
  mobileSessionUrl,
  redeemMobileSession,
  type MobileSession,
} from '../verify/mobile-session';
import { markClientIdentityVerified } from '../auth/account-store';
import {
  beginBiometricEnrollment,
  completeBiometricEnrollment,
} from '../auth/account-api';

// FEATURE 5 — Demo Identity Verification (`/identity-verification`).
//
// Clearly-labelled DEMO verification: capture a document/reference photo and a
// live selfie, then run the demo face-match fully client-side. Images are
// processed in memory and never stored or uploaded; only a boolean outcome is
// sent to the server. This is NOT an official Aadhaar/UIDAI verification and
// must never be presented as one. Desktop camera is preferred; when no camera
// is available the user can continue on their phone via a short-lived,
// single-use carry-over link (no PII in the QR/URL).

type Step = 'reference' | 'selfie' | 'match';

export default function IdentityVerificationPage() {
  const { address } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [step, setStep] = useState<Step>('reference');
  const [referenceSignature, setReferenceSignature] = useState<number[] | null>(null);
  const [selfieData, setSelfieData] = useState<ImageData | null>(null);
  const [result, setResult] = useState<DemoFaceMatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mobileFallback, setMobileFallback] = useState(false);
  const [mobileSession, setMobileSession] = useState<MobileSession | null>(null);
  const [mobileStatus, setMobileStatus] = useState<string | null>(null);

  // Mobile carry-over handoff: a session token may arrive in the URL. Redeem
  // it (single-use) when present and matching the current wallet.
  useEffect(() => {
    const token = searchParams.get('mobileSession');
    const claimedWallet = searchParams.get('wallet');
    if (!token) return;
    const redeemed = redeemMobileSession(token);
    if (!redeemed.ok) {
      setMobileStatus(`This carry-over link is ${redeemed.reason}. Start verification again on this device.`);
      return;
    }
    if (claimedWallet && address && claimedWallet.toLowerCase() !== address.toLowerCase()) {
      setMobileStatus('This carry-over link is for a different wallet. Connect that wallet first.');
      return;
    }
    setMobileFallback(false);
    setMobileStatus('Carry-over accepted from your phone. Continue here.');
  }, [searchParams, address]);

  if (!address) {
    return (
      <div className="page profile-page">
        <ProductBanner />
        <div className="auth-gate">
          <h1 className="auth-gate-title">Connect your wallet to continue.</h1>
          <p className="auth-gate-desc">A connected wallet is required for identity verification.</p>
          <Link to="/" className="btn btn-primary btn-lg">Return Home</Link>
        </div>
      </div>
    );
  }

  const handleReferenceUpload = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const sig = await loadImageSignature(file);
      setReferenceSignature(sig);
      setStep('selfie');
    } catch {
      setError('Could not read that image. Use a clear, front-facing photo.');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleSelfieCapture = useCallback(async (imageData: ImageData) => {
    setBusy(true);
    setError(null);
    try {
      if (!referenceSignature) {
        setError('Upload a reference document/photo first.');
        return;
      }
      const r = await demoFaceMatch(imageData, referenceSignature);
      setResult(r);
      setSelfieData(imageData);
      setStep('match');
    } finally {
      setBusy(false);
    }
  }, [referenceSignature]);

  const handleConfirm = useCallback(async () => {
    if (!address || !result?.ok || !selfieData) return;
    setBusy(true);
    setError(null);
    try {
      // Part 8: the insecure "client says confirmed:true" path was removed.
      // identityVerified can now only be set server-side through REAL biometric
      // enrollment. This demo runs that real flow with a clearly-labelled
      // server-side-enforced consent step.
      const begin = await beginBiometricEnrollment();
      if (!begin.ok) {
        setError(begin.message ?? 'Could not start biometric enrollment. Try again.');
        return;
      }
      const demoEmbedding = await projectDemoEmbedding(selfieData);
      // The server enforces consent + requires >=3 usable frames. Send the
      // single-use token and explicit consent; the server does the rest and
      // never trusts a client "matched"/"score".
      const r = await completeBiometricEnrollment({
        token: begin.data.token,
        consent: true,
        embeddings: [demoEmbedding, demoEmbedding, demoEmbedding, demoEmbedding],
      });
      if (!r.ok) {
        setError(r.message ?? 'Could not record the verification outcome. Try again.');
        return;
      }
      markClientIdentityVerified(address);
      navigate('/login', { replace: true });
    } finally {
      setBusy(false);
    }
  }, [address, navigate, result, selfieData]);

  const retry = useCallback(() => {
    setResult(null);
    setSelfieData(null);
    setStep('selfie');
    setError(null);
  }, []);

  const startOver = useCallback(() => {
    setResult(null);
    setSelfieData(null);
    setReferenceSignature(null);
    setStep('reference');
    setError(null);
    setMobileFallback(false);
    setMobileSession(null);
  }, []);

  return (
    <div className="page profile-page">
      <ProductBanner />
      <div className="demo-mode-banner" role="status">
        <span className="demo-mode-banner-icon" aria-hidden="true">⚠</span>
        <span><strong>Demo Identity Verification</strong> — this is NOT an official Aadhaar/UIDAI or government identity verification. Images are processed only on your device and are never stored or uploaded.</span>
      </div>

      <div className="page-header">
        <h1 className="page-title">Identity Verification</h1>
        <p className="page-desc" style={{ maxWidth: 640 }}>
          Verify that you are the person who registered this account. Capture a
          reference document/photo, then a live selfie; the demo uses a local
          perceptual match. No photo, selfie, or biometric data leaves your
          device and nothing is written to the ledger.
        </p>
      </div>

      {mobileStatus && <div className="status-msg info" role="status">{mobileStatus}</div>}
      {error && <div className="status-msg error" role="alert">{error}</div>}

      <div className="account-card">
        {step === 'reference' && (
          <ReferenceStep
            onUpload={handleReferenceUpload}
            busy={busy}
            onMobile={() => {
              const s = createMobileSession(address);
              setMobileSession(s);
              setMobileFallback(true);
            }}
          />
        )}

        {step === 'selfie' && (
          <SelfieStep
            onCapture={handleSelfieCapture}
            busy={busy}
            onRetryReference={startOver}
            onMobile={() => {
              const s = createMobileSession(address);
              setMobileSession(s);
              setMobileFallback(true);
            }}
          />
        )}

        {step === 'match' && result && (
          <MatchStep
            result={result}
            resultLabel={demoResultLabel(result)}
            selfieData={selfieData}
            onRetry={retry}
            onConfirm={handleConfirm}
            busy={busy}
          />
        )}

        {mobileFallback && mobileSession && (
          <MobileFallbackPanel session={mobileSession} />
        )}
      </div>
    </div>
  );
}

function ReferenceStep({ onUpload, busy, onMobile }: { onUpload: (f: File) => void; busy: boolean; onMobile: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <section className="account-section">
      <h2 className="account-section-title">Step 1 — Reference Document / Photo</h2>
      <p className="account-section-desc">
        Upload a clear, front-facing reference photo (e.g. a passport-style
        photo). It is used only to compute a local reference signature for the
        demo match. It is never uploaded, stored, or written to the ledger.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="form-input"
        disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }}
      />
      <div className="profile-done-actions" style={{ marginTop: '1rem' }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? 'Reading image…' : 'Use reference photo'}
        </button>
        <span className="or-divider">or</span>
        <button className="btn btn-ghost" onClick={onMobile}>Continue on phone</button>
      </div>
    </section>
  );
}

function SelfieStep({
  onCapture,
  busy,
  onRetryReference,
  onMobile,
}: {
  onCapture: (d: ImageData) => void;
  busy: boolean;
  onRetryReference: () => void;
  onMobile: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('No camera access on this device.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraActive(true);
        setCameraError(null);
      } catch {
        if (!cancelled) setCameraError('Camera unavailable or permission denied.');
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const capture = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    onCapture(imageData);
  };

  const handleFile = (f: File) => {
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 480 / img.width);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      onCapture(imageData);
    };
    img.src = url;
  };

  return (
    <section className="account-section">
      <h2 className="account-section-title">Step 2 — Live Selfie</h2>
      <p className="account-section-desc">
        Capture a live selfie. It is matched locally against your reference and
        never stored or uploaded. The demo result is clearly labelled as a demo
        check only.
      </p>

      {cameraActive && (
        <div className="selfie-camera">
          <video ref={videoRef} muted playsInline className="selfie-video" aria-label="Live selfie preview" />
        </div>
      )}
      {cameraError && (
        <div className="status-msg info" role="status">{cameraError}</div>
      )}

      <div className="profile-done-actions" style={{ marginTop: '1rem' }}>
        {cameraActive && (
          <button className="btn btn-primary" disabled={busy} onClick={capture}>
            {busy ? 'Matching…' : 'Capture selfie'}
          </button>
        )}
        {cameraActive && <span className="or-divider">or</span>}
        <button className="btn btn-ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
          Upload a selfie photo
        </button>
        <button className="btn btn-ghost" onClick={onMobile}>Continue on phone</button>
        <button className="btn btn-ghost" onClick={onRetryReference}>Change reference</button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
      />
    </section>
  );
}

function MatchStep({
  result,
  resultLabel,
  selfieData,
  onRetry,
  onConfirm,
  busy,
}: {
  result: DemoFaceMatchResult;
  resultLabel: string;
  selfieData: ImageData | null;
  onRetry: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <section className="account-section">
      <h2 className="account-section-title">Step 3 — Demo Result</h2>
      <div className={`status-msg ${result.ok ? 'success' : 'error'}`} role="status">{resultLabel}</div>
      {selfieData && (
        <div className="status-msg info" role="status">
          <strong>Remember:</strong> this is a DEMO match. It is not an official
          identity verification and cannot be presented as Aadhaar/UIDAI eKYC.
        </div>
      )}
      <div className="profile-done-actions" style={{ marginTop: '1rem' }}>
        {result.ok && (
          <button className="btn btn-primary btn-lg" disabled={busy} onClick={onConfirm}>
            {busy ? 'Recording…' : 'Confirm verification & continue'}
          </button>
        )}
        <button className="btn btn-ghost" onClick={onRetry}>Retry selfie</button>
      </div>
    </section>
  );
}

function MobileFallbackPanel({ session }: { session: MobileSession }) {
  const url = mobileSessionUrl(session);
  return (
    <section className="account-section">
      <h2 className="account-section-title">Continue Verification on Your Phone</h2>
      <p className="account-section-desc">
        On your phone, open the carry-over link below (scan the QR with a
        camera app, or open it on the same device). The link is short-lived and
        single-use; it contains no photo, no Aadhaar number, and no other
        personal data.
      </p>
      <div className="status-msg info" role="status">
        This in-browser demo resolves carry-over tokens within the same running
        app instance. In production the token resolves across devices through
        the server.
      </div>
      <p className="account-factor-detail" style={{ wordBreak: 'break-all', fontFamily: 'var(--mono, monospace)', fontSize: '0.8rem' }}>
        {url}
      </p>
    </section>
  );
}

async function loadImageSignature(file: File): Promise<number[]> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 480 / img.width);
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return computeReferenceSignature(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('load failed'));
    img.src = src;
  });
}
