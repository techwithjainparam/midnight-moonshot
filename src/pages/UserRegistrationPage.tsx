import { useState, useCallback, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import BiometricEnrollment from '../components/BiometricEnrollment';
import ServerRegistrationLiveness, {
  type ServerLivenessStartResult,
  type ServerLivenessEvidenceResult,
} from '../components/ServerRegistrationLiveness';
import { maskAadhaar } from '../auth/account-types';
import {
  REGISTRATION_STEP_ORDER,
  REGISTRATION_STEP_LABELS,
  currentRegistrationStep,
  type RegistrationCapabilities,
  type RegistrationLivenessEvidenceInput,
  type RegistrationStatus,
  type RegistrationStep,
} from '../auth/registration-types';
import {
  beginRegistration,
  fetchRegistrationCapabilities,
  fetchRegistrationStatus,
  postPersonal,
  uploadAadhaarDocument,
  postEmail,
  verifyRegistrationEmailOtp,
  issueRegistrationSmsOtp,
  verifyRegistrationSmsOtp,
  issueRegistrationWhatsappOtp,
  verifyRegistrationWhatsappOtp,
  startRegistrationAadhaarMobile,
  completeRegistrationAadhaarMobile,
  setRegistrationPassword,
  uploadRegistrationPhoto,
  startRegistrationLiveness,
  postLivenessEvidence,
  postLocation,
  finalizeRegistration,
  type RegistrationApiResult,
} from '../auth/registration-api';
import { createLocationWatcher } from '../liveness/location-watcher';
import type { LocationSessionState } from '../liveness/location-watcher';
import type { LocationEvidence } from '../liveness/location';
import { associateWalletWithAccount } from '../auth/account-api';
import { useWallet } from '../hooks/useWallet';

// PRIESTATE — Secure user registration (`/register-account`), Part 1 flow.
//
// This page drives the REAL server-side registration stepper
// (`/api/v1/registration/*`): personal → Aadhaar OCR → email → SMS OTP →
// WhatsApp OTP → Aadhaar-mobile link → password → photo → liveness → location
// → finalize. Every decision is server-authoritative (the HttpOnly
// `priestate_reg_sid` session cookie set at `begin`), and every step that needs
// a real external provider FAILS CLOSED when that provider is unconfigured.
//
// Registration NEVER connects a wallet and NEVER asks for a wallet address:
// there is no wallet field (typed or otherwise) anywhere in the stepper. The
// account is created without a wallet. AFTER finalize the citizen CONNECTS
// their real Midnight wallet (wallet association) so the account is bound to
// it before the biometric enrollment step — no wallet address is ever entered
// by hand.
//
// The client NEVER stores a password, OTP, raw PII, or a self-affirmed
// verification flag, and NEVER touches the ledger.

// A cookie-less or expired registration cookie is NOT an error: the server
// answers `status` with `{ok:true, session:null}` (and clears the stale
// cookie). The registration API returns `ok:false` ONLY when the request could
// not be served: the fetch threw (network-error / backend unreachable) or the
// response was an error or non-JSON (e.g. the dev proxy's 500 while the
// verification server is down). Report honestly per category — never surface
// server internals.
const REGISTRATION_SERVER_DOWN_MESSAGE =
  'Cannot reach the verification server right now. Check that it is running, then try again.';
const REGISTRATION_SERVER_ERROR_MESSAGE =
  'The verification server is not responding correctly right now. Try again.';
const REGISTRATION_STATE_LOAD_ERROR =
  'The server could not load your registration state. Try again.';

function registrationStateMessage<T>(st: RegistrationApiResult<T>): string {
  if (st.ok) return REGISTRATION_STATE_LOAD_ERROR;
  if (st.reason === 'network-error') return REGISTRATION_SERVER_DOWN_MESSAGE;
  if (typeof st.status === 'number' && st.status >= 500) return REGISTRATION_SERVER_ERROR_MESSAGE;
  return REGISTRATION_STATE_LOAD_ERROR;
}

export default function UserRegistrationPage() {
  const navigate = useNavigate();

  // ── Server-authoritative session + capabilities ─────────────────
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [caps, setCaps] = useState<RegistrationCapabilities | null>(null);
  const [status, setStatus] = useState<RegistrationStatus | null>(null);
  const [enrolled, setEnrolled] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const [stepBusy, setStepBusy] = useState(false);

  // ── Post-finalize wallet association (connect the REAL Midnight wallet) ──
  const wallet = useWallet();
  const [walletAssociated, setWalletAssociated] = useState(false);
  const [associateBusy, setAssociateBusy] = useState(false);
  const [associateError, setAssociateError] = useState<string | null>(null);

  // ── Registration begins without any wallet connection ────────────
  // `begin` (POST /api/v1/registration/begin) takes NO wallet address and
  // mints the HttpOnly `priestate_reg_sid` cookie. `sessionStarted` is true
  // when the cookie is already live (resumed) so `begin` is not re-called.
  const [sessionStarted, setSessionStarted] = useState(false);

  // ── Personal-form state ──────────────────────────────────────────
  const [fullName, setFullName] = useState('');
  const [aadhaarNumber, setAadhaarNumber] = useState('');
  const [aadhaarMasked, setAadhaarMasked] = useState(false);
  const [addressOnAadhaar, setAddressOnAadhaar] = useState('');
  const [pincode, setPincode] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [mobile, setMobile] = useState('');

  // ── Email / SMS / WhatsApp OTP state ─────────────────────────────
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [smsSent, setSmsSent] = useState(false);
  const [smsCode, setSmsCode] = useState('');
  const [waSent, setWaSent] = useState(false);
  const [waCode, setWaCode] = useState('');

  // ── Aadhaar-mobile link state ────────────────────────────────────
  const [amChallenge, setAmChallenge] = useState<{ sessionId: string; expiresAt: number } | null>(null);
  const [amCode, setAmCode] = useState('');

  // ── Password state ───────────────────────────────────────────────
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');

  // ── Location step state ──────────────────────────────────────────
  const [locationState, setLocationState] = useState<'idle' | 'requesting' | 'submitting' | 'error'>('idle');
  const [locationMessage, setLocationMessage] = useState<string | null>(null);
  const locationHandleRef = useRef<ReturnType<typeof createLocationWatcher> | null>(null);
  const locationPollRef = useRef<number | null>(null);

  // ── Boot: capability discovery + resume an in-flight session ────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setStartupError(null);
      const capsRes = await fetchRegistrationCapabilities();
      if (!cancelled && capsRes.ok) setCaps(capsRes.data.capabilities);

      // No wallet is involved: if a previous registration left a live
      // `priestate_reg_sid` cookie, resume it; otherwise the user starts the
      // personal step below (which mints the cookie on submit).
      const st = await fetchRegistrationStatus();
      if (cancelled) return;
      if (!st.ok) {
        // A missing OR stale registration cookie is NOT an error: the server
        // answers a cookie-less / expired status with `{ok:true, session:null}`
        // (and clears the stale cookie). The ONLY ways `st.ok` can be false are
        // the request failing to reach the backend (network-error) or the
        // response being an error/non-JSON — e.g. the dev proxy's 500 when the
        // verification server is down. Report accurately per category.
        setStartupError(registrationStateMessage(st));
      } else if (st.data.session) {
        setStatus(st.data.session);
        setSessionStarted(true);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Refresh server-authoritative status after every step ─────────
  const refreshStatus = useCallback(async (): Promise<RegistrationStatus | null> => {
    const st = await fetchRegistrationStatus();
    if (!st.ok) {
      setStepError(registrationStateMessage(st));
      return null;
    }
    if (!st.data.session) {
      // The HttpOnly `priestate_reg_sid` cookie was invalid/expired (or never
      // minted) server-side; the server already cleared it and returned a null
      // session — NOT an error. Reset to a clean registration and let the user
      // start fresh from the personal step; no wallet is required to do so.
      setStatus(null);
      setSessionStarted(false);
      setStepError('Your previous registration session has expired. You can start a fresh one below.');
      return null;
    }
    setStatus(st.data.session);
    return st.data.session;
  }, []);

  // Unmount cleanup: stop any live location watcher + poll.
  useEffect(() => {
    return () => {
      if (locationPollRef.current !== null) window.clearInterval(locationPollRef.current);
      locationHandleRef.current?.stop();
      locationHandleRef.current = null;
    };
  }, []);

  // ── Liveness adapters (server-issued challenges) ─────────────────

  const livenessStart = useCallback(async (): Promise<ServerLivenessStartResult> => {
    const r = await startRegistrationLiveness();
    if (r.ok) return { ok: true, challenges: r.data.challenges, expiresInMs: r.data.expiresInMs };
    return { ok: false, reason: r.reason, message: r.message };
  }, []);

  const livenessEvidence = useCallback(
    async (input: RegistrationLivenessEvidenceInput): Promise<ServerLivenessEvidenceResult> => {
      const r = await postLivenessEvidence(input);
      if (r.ok) {
        return {
          ok: true,
          done: r.data.progress.done,
          completed: r.data.progress.completed,
          total: r.data.progress.total,
        };
      }
      return { ok: false, message: r.message };
    },
    [],
  );

  // ── Location evidence (only after server-recorded liveness) ──────

  const handleCaptureLocation = useCallback(() => {
    setLocationMessage(null);
    setStepError(null);
    setLocationState('requesting');

    if (locationPollRef.current !== null) window.clearInterval(locationPollRef.current);
    const watcher = createLocationWatcher();
    locationHandleRef.current = watcher;
    watcher.start();

    const poll = window.setInterval(() => {
      const s = watcher.getState();
      if (s.state === 'active' && s.evidence) {
        window.clearInterval(poll);
        watcher.stop();
        locationHandleRef.current = null;
        void submitLocation(s.evidence);
        return;
      }
      if (TERMINAL_LOCATION_STATES.includes(s.state)) {
        window.clearInterval(poll);
        watcher.stop();
        locationHandleRef.current = null;
        setLocationState('error');
        setLocationMessage(`Location could not be verified: ${locationStateMessage(s.state)}`);
      }
    }, 250);
    locationPollRef.current = poll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitLocation = useCallback(async (evidence: LocationEvidence): Promise<void> => {
    setLocationState('submitting');
    setLocationMessage(null);
    const r = await postLocation({
      context: 'registration',
      livenessPassed: true,
      location: {
        latitude: evidence.latitude,
        longitude: evidence.longitude,
        accuracyMeters: evidence.accuracyMeters,
        timestampMs: evidence.timestampMs,
        nonce: evidence.nonce,
      },
    });
    if (r.ok) {
      setLocationState('idle');
      await refreshStatus();
    } else {
      setLocationState('error');
      setLocationMessage(r.message ?? 'Location evidence was rejected by the server.');
    }
  }, [refreshStatus]);

  if (loading) {
    return (
      <div className="page profile-page">
        <ProductBanner />
        <div className="auth-gate">
          <h1 className="auth-gate-title">Loading your registration…</h1>
          <div className="status-msg info" role="status">
            Contacting the verification server <span className="spinner-inline" aria-hidden="true" />
          </div>
        </div>
      </div>
    );
  }

  if (startupError) {
    return (
      <div className="page profile-page">
        <ProductBanner />
        <div className="auth-gate">
          <h1 className="auth-gate-title">Could not start registration</h1>
          <p className="auth-gate-desc">{startupError}</p>
          <div className="account-card-actions">
            <button className="btn btn-primary" onClick={() => window.location.reload()}>Try again</button>
            <Link to="/" className="btn btn-ghost">Return Home</Link>
          </div>
        </div>
      </div>
    );
  }

  if (status?.finalized) {
    return (
      <div className="page profile-page">
        <ProductBanner />
        <div className="page-header">
          <h1 className="page-title">Account Created</h1>
        </div>
        <div className="account-card">
          <div className="status-msg success" role="status">
            Your PRIESTATE account has been created. Every real verification
            gate passed server-side. Finalize also signed you in, so the final
            steps (connect your Midnight wallet, then biometric enrollment) can
            run now.
          </div>
          {!walletAssociated ? (
            <section className="account-section">
              <h2 className="account-section-title">Connect your Midnight wallet</h2>
              <p className="account-section-desc">
                Your account was created without a wallet. Connect your Midnight
                wallet now to bind it to this account — it gates every wallet-based
                property flow and is required before biometric enrollment.
              </p>
              {!wallet.address ? (
                <>
                  <div className="account-card-actions">
                    <button className="btn btn-primary btn-lg" onClick={wallet.connect} disabled={wallet.walletState !== 'ready'}>
                      {wallet.walletState === 'ready' ? 'Connect Wallet' : 'Detecting wallet…'}
                    </button>
                  </div>
                  {wallet.error && <div className="status-msg error" role="alert">{wallet.error}</div>}
                </>
              ) : (
                <>
                  <p className="account-section-desc">
                    Wallet connected: <code className="form-input" style={{ marginTop: '0.25rem' }} aria-label="Connected wallet address">{wallet.address.slice(0, 10)}…{wallet.address.slice(-6)}</code>
                  </p>
                  <div className="account-card-actions">
                    <button className="btn btn-primary btn-lg" onClick={() => void handleAssociateWallet()} disabled={associateBusy}>
                      {associateBusy ? 'Associating…' : 'Associate this wallet'}
                    </button>
                  </div>
                  {associateError && <div className="status-msg error" role="alert">{associateError}</div>}
                </>
              )}
            </section>
          ) : (
            <>
              <div className="status-msg success" role="status">
                Your Midnight wallet is associated with this account. The final
                biometric enrollment step can run now.
              </div>
              {!enrolled ? (
                <BiometricEnrollment onEnrolled={() => setEnrolled(true)} />
              ) : (
                <div className="status-msg success" role="status">
                  Biometric reference enrolled and tied to your identity by the
                  server. Login with your password + real face now works.
                </div>
              )}
            </>
          )}
          <div className="account-card-actions">
            <button
              className="btn btn-primary btn-lg"
              onClick={() => navigate('/login/user')}
              disabled={!enrolled}
              title={enrolled ? undefined : 'Associate your wallet and complete biometric enrollment to enable login'}
            >
              Continue to Login
            </button>
            <button className="btn btn-ghost" onClick={() => navigate('/dashboard')}>Dashboard</button>
          </div>
        </div>
      </div>
    );
  }

  const step: RegistrationStep = status ? currentRegistrationStep(status) : 'personal';

  return (
    <div className="page profile-page">
      <ProductBanner />
      <div className="page-header">
        <h1 className="page-title">Create Your PRIESTATE Account</h1>
        <p className="page-desc" style={{ maxWidth: 700 }}>
          Registration is a real, server-driven stepper — and it never needs a
          wallet. No wallet address is typed anywhere. After account creation you
          connect your real Midnight wallet to bind it to the account. Your
          password is stored only as a salted hash, raw PII and the Aadhaar
          document extraction are encrypted at rest on the verification server,
          and nothing ever reaches the ledger. A step whose real provider is not
          configured fails closed — it is never faked or skipped.
        </p>
      </div>

      <StepRail step={step} />

      <div className="account-card">
        {stepError && <div className="status-msg error" role="alert">{stepError}</div>}

        {step === 'personal' && (
          <section className="account-section">
            <h2 className="account-section-title">Identity & Contact</h2>
            <p className="account-section-desc">
              The server verifies your pincode against India Post and stores
              these details only as an encrypted blob on the verification
              server. Raw Aadhaar is never kept — only a masked fragment. No
              wallet address is needed or collected.
            </p>

            <div className="form-field">
              <label className="form-label" htmlFor="reg-fullname">Full Name (as on Aadhaar)</label>
              <input
                id="reg-fullname"
                type="text"
                autoComplete="name"
                className="form-input"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="reg-aadhaar">Aadhaar Number</label>
              <input
                id="reg-aadhaar"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                className="form-input"
                placeholder="•••• •••• 4321"
                value={aadhaarMasked && aadhaarNumber.length === 12 ? maskAadhaar(aadhaarNumber) : aadhaarNumber}
                onChange={(e) => { setAadhaarNumber(e.target.value.replace(/\D/g, '').slice(0, 12)); setAadhaarMasked(false); }}
                onBlur={() => { if (aadhaarNumber.replace(/\s/g, '').length === 12) setAadhaarMasked(true); }}
              />
              <span className="form-hint">Masked after entry; only a masked fragment is ever kept.</span>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="reg-address">Address (as on Aadhaar)</label>
              <input
                id="reg-address"
                type="text"
                className="form-input"
                value={addressOnAadhaar}
                maxLength={200}
                onChange={(e) => setAddressOnAadhaar(e.target.value)}
              />
            </div>

            <div className="form-row">
              <div className="form-field">
                <label className="form-label" htmlFor="reg-pincode">Pincode</label>
                <input
                  id="reg-pincode"
                  type="text"
                  inputMode="numeric"
                  className="form-input"
                  value={pincode}
                  maxLength={6}
                  onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                {caps && !caps.pincodeConfigured && (
                  <span className="form-hint">Pincode verification (India Post) is not configured — this server cannot accept pincodes yet.</span>
                )}
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="reg-dob">Date of Birth</label>
                <input
                  id="reg-dob"
                  type="date"
                  className="form-input"
                  value={dateOfBirth}
                  onChange={(e) => setDateOfBirth(e.target.value)}
                />
              </div>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="reg-mobile">Mobile Number</label>
              <div className="verify-mobile-row">
                <span className="verify-mobile-prefix">+91</span>
                <input
                  id="reg-mobile"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  maxLength={10}
                  className="form-input"
                  placeholder="9876543210"
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
                />
              </div>
              <span className="form-hint">Used for real SMS and WhatsApp OTP at login. Stored encrypted; shown only masked.</span>
            </div>

            <div className="account-card-actions">
              <button className="btn btn-primary btn-lg" onClick={() => void handlePersonal()} disabled={stepBusy}>
                {stepBusy ? 'Saving…' : 'Save personal details'}
              </button>
            </div>
          </section>
        )}

        {step === 'aadhaar-document' && (
          <section className="account-section">
            <h2 className="account-section-title">Aadhaar Document (real OCR)</h2>
            <p className="account-section-desc">
              Upload a clear photo of your Aadhaar or e-Aadhaar PDF. The server
              runs a REAL OCR provider, cross-checks the extracted name against
              what you entered, and stores only an encrypted extraction. The raw
              file and file name are never retained.
            </p>
            {caps && !caps.aadhaarOcrConfigured && (
              <div className="status-msg error" role="alert">
                Aadhaar document OCR is not configured on the verification server.
                This step cannot complete — no fake extraction is used.
              </div>
            )}
            <div className="form-field">
              <input
                type="file"
                accept="image/*,application/pdf"
                className="form-input"
                disabled={stepBusy || Boolean(caps && !caps.aadhaarOcrConfigured)}
                onChange={(e) => void handleAadhaarDoc(e.target.files?.[0] ?? null)}
              />
              {stepBusy && <span className="form-hint">Uploading and running OCR…</span>}
            </div>
          </section>
        )}

        {step === 'email' && (
          <section className="account-section">
            <h2 className="account-section-title">Email Verification</h2>
            <p className="account-section-desc">
              A real code is emailed from the verification server. Disposable
              email domains are rejected server-side, and the address is stored
              only inside the encrypted profile.
            </p>
            {caps && !caps.emailConfigured && (
              <div className="status-msg error" role="alert">
                Email delivery is not configured on the verification server. This
                step cannot complete.
              </div>
            )}
            {!emailSent ? (
              <div className="form-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-email">Email</label>
                  <input
                    id="reg-email"
                    type="email"
                    autoComplete="email"
                    className="form-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="account-card-actions">
                  <button className="btn btn-primary" onClick={() => void handleSendEmail()} disabled={stepBusy || Boolean(caps && !caps.emailConfigured)}>
                    {stepBusy ? 'Sending…' : 'Send code'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="form-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-email-code">Email code</label>
                  <input
                    id="reg-email-code"
                    type="text"
                    inputMode="numeric"
                    className="form-input"
                    maxLength={6}
                    placeholder="_ _ _ _ _ _"
                    value={emailCode}
                    onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                  <span className="form-hint">Check your inbox (including spam).</span>
                </div>
                <div className="account-card-actions">
                  <button className="btn btn-primary" onClick={() => void handleVerifyEmail()} disabled={stepBusy || emailCode.length !== 6}>
                    {stepBusy ? 'Verifying…' : 'Verify code'}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {step === 'sms-otp' && (
          <section className="account-section">
            <h2 className="account-section-title">SMS OTP</h2>
            <p className="account-section-desc">
              A real one-time code is delivered by SMS to your registered Indian
              mobile through the server's SMS gateway.
            </p>
            {caps && !caps.smsConfigured && (
              <div className="status-msg error" role="alert">
                SMS delivery is not configured on the verification server. This
                step cannot complete — a fake code is never accepted.
              </div>
            )}
            {!smsSent ? (
              <div className="account-card-actions">
                <button className="btn btn-primary" onClick={() => void handleSendSms()} disabled={stepBusy || Boolean(caps && !caps.smsConfigured)}>
                  {stepBusy ? 'Sending…' : 'Send SMS code'}
                </button>
              </div>
            ) : (
              <div className="form-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-sms-code">SMS code</label>
                  <input
                    id="reg-sms-code"
                    type="text"
                    inputMode="numeric"
                    className="form-input"
                    maxLength={6}
                    placeholder="_ _ _ _ _ _"
                    value={smsCode}
                    onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                </div>
                <div className="account-card-actions">
                  <button className="btn btn-primary" onClick={() => void handleVerifySms()} disabled={stepBusy || smsCode.length !== 6}>
                    {stepBusy ? 'Verifying…' : 'Verify SMS code'}
                  </button>
                </div>
              </div>
            )}
            <span className="form-hint">{status?.maskedMobile ? `Delivered to ${status.maskedMobile}.` : ''}</span>
          </section>
        )}

        {step === 'whatsapp-otp' && (
          <section className="account-section">
            <h2 className="account-section-title">WhatsApp OTP</h2>
            <p className="account-section-desc">
              An independent one-time code is delivered over WhatsApp — a separate,
              real channel from SMS.
            </p>
            {caps && !caps.whatsappConfigured && (
              <div className="status-msg error" role="alert">
                WhatsApp delivery is not configured on the verification server.
                This step cannot complete — a fake code is never accepted.
              </div>
            )}
            {!waSent ? (
              <div className="account-card-actions">
                <button className="btn btn-primary" onClick={() => void handleSendWhatsapp()} disabled={stepBusy || Boolean(caps && !caps.whatsappConfigured)}>
                  {stepBusy ? 'Sending…' : 'Send WhatsApp code'}
                </button>
              </div>
            ) : (
              <div className="form-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-wa-code">WhatsApp code</label>
                  <input
                    id="reg-wa-code"
                    type="text"
                    inputMode="numeric"
                    className="form-input"
                    maxLength={6}
                    placeholder="_ _ _ _ _ _"
                    value={waCode}
                    onChange={(e) => setWaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                </div>
                <div className="account-card-actions">
                  <button className="btn btn-primary" onClick={() => void handleVerifyWhatsapp()} disabled={stepBusy || waCode.length !== 6}>
                    {stepBusy ? 'Verifying…' : 'Verify WhatsApp code'}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {step === 'aadhaar-mobile' && (
          <section className="account-section">
            <h2 className="account-section-title">Aadhaar-linked Mobile</h2>
            <p className="account-section-desc">
              The server asks its authorized KYC provider whether your registered
              mobile is linked to an Aadhaar record — it is not inferred client-side.
            </p>
            {caps && !caps.aadhaarMobileConfigured && (
              <div className="status-msg error" role="alert">
                The Aadhaar-link provider is not configured on the verification
                server. This step cannot complete.
              </div>
            )}
            {!amChallenge ? (
              <div className="account-card-actions">
                <button className="btn btn-primary" onClick={() => void handleStartAadhaarMobile()} disabled={stepBusy || Boolean(caps && !caps.aadhaarMobileConfigured)}>
                  {stepBusy ? 'Checking…' : 'Verify Aadhaar-linked mobile'}
                </button>
              </div>
            ) : (
              <div className="form-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-am-code">Provider OTP code</label>
                  <input
                    id="reg-am-code"
                    type="text"
                    inputMode="numeric"
                    className="form-input"
                    maxLength={6}
                    placeholder="_ _ _ _ _ _"
                    value={amCode}
                    onChange={(e) => setAmCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                </div>
                <div className="account-card-actions">
                  <button className="btn btn-primary" onClick={() => void handleCompleteAadhaarMobile()} disabled={stepBusy || amCode.length !== 6}>
                    {stepBusy ? 'Verifying…' : 'Verify code'}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {step === 'password' && (
          <section className="account-section">
            <h2 className="account-section-title">Password</h2>
            <p className="account-section-desc">
              Stored only as a salted scrypt hash on the verification server — never
              plaintext, never on-chain, never in this browser.
            </p>
            <div className="form-row">
              <div className="form-field">
                <label className="form-label" htmlFor="reg-password">Password</label>
                <input
                  id="reg-password"
                  type="password"
                  autoComplete="new-password"
                  className="form-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="reg-password-confirm">Confirm Password</label>
                <input
                  id="reg-password-confirm"
                  type="password"
                  autoComplete="new-password"
                  className="form-input"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                />
              </div>
            </div>
            <div className="account-card-actions">
              <button className="btn btn-primary btn-lg" onClick={() => void handlePassword()} disabled={stepBusy}>
                {stepBusy ? 'Setting…' : 'Set password'}
              </button>
            </div>
          </section>
        )}

        {step === 'photo' && (
          <section className="account-section">
            <h2 className="account-section-title">Passport Photo</h2>
            <p className="account-section-desc">
              Upload a near-square PNG with a uniform white background. The server
              validates it pixel-by-pixel (white corners, subject occupancy) and
              stores only a content hash — the portrait bytes are never kept.
            </p>
            <div className="form-field">
              <input
                type="file"
                accept="image/png,image/*"
                className="form-input"
                disabled={stepBusy}
                onChange={(e) => void handlePhoto(e.target.files?.[0] ?? null)}
              />
              {stepBusy && <span className="form-hint">Validating photo…</span>}
            </div>
          </section>
        )}

        {step === 'liveness' && (
          <section className="account-section">
            <h2 className="account-section-title">Live Liveness</h2>
            <ServerRegistrationLiveness
              onStart={livenessStart}
              onEvidence={livenessEvidence}
              onComplete={(passed) => {
                if (passed) {
                  setStepError(null);
                  void refreshStatus();
                }
              }}
            />
          </section>
        )}

        {step === 'location' && (
          <section className="account-section">
            <h2 className="account-section-title">Live Location</h2>
            <p className="account-section-desc">
              Your location is requested only AFTER the server has recorded your
              real liveness. A fresh, accurate fix is submitted; the server
              reverse-geocodes it and refuses stale, coarse, or out-of-India
              evidence. Raw coordinates are never stored.
            </p>
            {locationState === 'idle' && (
              <div className="account-card-actions">
                <button className="btn btn-primary btn-lg" onClick={handleCaptureLocation}>
                  Capture my location
                </button>
              </div>
            )}
            {locationState === 'requesting' && (
              <div className="status-msg info" role="status">
                Waiting for a fresh, accurate location fix… <span className="spinner-inline" aria-hidden="true" />
              </div>
            )}
            {locationState === 'submitting' && (
              <div className="status-msg info" role="status">
                Verifying location against the server… <span className="spinner-inline" aria-hidden="true" />
              </div>
            )}
            {locationState === 'error' && (
              <>
                <div className="status-msg error" role="alert">
                  {locationMessage ?? 'Location could not be verified. Location is required for registration and is never faked.'}
                </div>
                <div className="account-card-actions">
                  <button className="btn btn-ghost" onClick={handleCaptureLocation}>Try again</button>
                </div>
              </>
            )}
          </section>
        )}

        {step === 'finalize' && (
          <section className="account-section">
            <h2 className="account-section-title">Finish</h2>
            <p className="account-section-desc">
              Every real verification gate has passed on the server. Finish account
              creation to finalize your encrypted account record.
            </p>
            <div className="account-card-actions">
              <button className="btn btn-primary btn-lg" onClick={() => void handleFinalize()} disabled={stepBusy}>
                {stepBusy ? 'Finalizing…' : 'Finish account creation'}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );

  // ── Step handlers ────────────────────────────────────────────────

  async function handlePersonal(): Promise<void> {
    setStepError(null);
    setStepBusy(true);
    try {
      // Registration begins here, wallet-free: `begin` takes NO wallet address
      // and mints the HttpOnly session cookie. No wallet is connected or typed.
      if (!sessionStarted) {
        const begun = await beginRegistration();
        if (!begun.ok) {
          if (begun.reason === 'already-registered') {
            navigate('/login/user', { replace: true });
            return;
          }
          setStepError(failureMessage(begun));
          return;
        }
        setSessionStarted(true);
      }
      const r = await postPersonal({
        fullName: fullName.trim(),
        aadhaarNumber: aadhaarNumber.replace(/\s/g, ''),
        addressOnAadhaar: addressOnAadhaar.trim() || undefined,
        pincode: pincode.trim() || undefined,
        dateOfBirth,
        mobile: mobile.replace(/\D/g, ''),
      });
      if (r.ok) {
        setStatus(r.data);
        await refreshStatus();
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  async function handleAadhaarDoc(file: File | null): Promise<void> {
    if (!file) return;
    setStepError(null);
    setStepBusy(true);
    try {
      const r = await uploadAadhaarDocument(file);
      if (r.ok) {
        await refreshStatus();
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  async function handleSendEmail(): Promise<void> {
    setStepError(null);
    setStepBusy(true);
    try {
      const r = await postEmail(email.trim());
      if (r.ok) {
        setEmailSent(true);
        setStepError(null);
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  async function handleVerifyEmail(): Promise<void> {
    setStepError(null);
    setStepBusy(true);
    try {
      const r = await verifyRegistrationEmailOtp(emailCode);
      if (r.ok) {
        await refreshStatus();
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  async function handleSendSms(): Promise<void> {
    setStepError(null);
    setStepBusy(true);
    try {
      const r = await issueRegistrationSmsOtp();
      if (r.ok) {
        setSmsSent(true);
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  async function handleVerifySms(): Promise<void> {
    setStepError(null);
    setStepBusy(true);
    try {
      const r = await verifyRegistrationSmsOtp(smsCode);
      if (r.ok) {
        setSmsCode('');
        setSmsSent(false);
        await refreshStatus();
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  async function handleSendWhatsapp(): Promise<void> {
    setStepError(null);
    setStepBusy(true);
    try {
      const r = await issueRegistrationWhatsappOtp();
      if (r.ok) {
        setWaSent(true);
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  async function handleVerifyWhatsapp(): Promise<void> {
    setStepError(null);
    setStepBusy(true);
    try {
      const r = await verifyRegistrationWhatsappOtp(waCode);
      if (r.ok) {
        setWaCode('');
        setWaSent(false);
        await refreshStatus();
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  async function handleStartAadhaarMobile(): Promise<void> {
    setStepError(null);
    setStepBusy(true);
    try {
      const r = await startRegistrationAadhaarMobile();
      if (r.ok) {
        if (r.data.mode === 'otp-challenge') {
          setAmChallenge({ sessionId: r.data.sessionId, expiresAt: r.data.expiresAt });
        } else {
          await refreshStatus();
        }
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  async function handleCompleteAadhaarMobile(): Promise<void> {
    setStepError(null);
    setStepBusy(true);
    try {
      if (!amChallenge) return;
      const r = await completeRegistrationAadhaarMobile(amChallenge.sessionId, amCode);
      if (r.ok) {
        setAmCode('');
        setAmChallenge(null);
        await refreshStatus();
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  async function handlePassword(): Promise<void> {
    setStepError(null);
    setStepBusy(true);
    try {
      const r = await setRegistrationPassword(password, passwordConfirm);
      if (r.ok) {
        setPassword('');
        setPasswordConfirm('');
        await refreshStatus();
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  async function handlePhoto(file: File | null): Promise<void> {
    if (!file) return;
    setStepError(null);
    setStepBusy(true);
    try {
      const r = await uploadRegistrationPhoto(file);
      if (r.ok) {
        await refreshStatus();
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  async function handleFinalize(): Promise<void> {
    setStepError(null);
    setStepBusy(true);
    try {
      const r = await finalizeRegistration();
      if (r.ok) {
        setStatus((prev) => (prev ? { ...prev, finalized: true } : prev));
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  // Bind the connected Midnight wallet to the finalized account. The server
  // also re-mints the session cookie so it carries the wallet — which the
  // biometric enrollment step below requires.
  async function handleAssociateWallet(): Promise<void> {
    if (!wallet.address) return;
    setAssociateError(null);
    setAssociateBusy(true);
    try {
      const r = await associateWalletWithAccount(wallet.address);
      if (r.ok) {
        setWalletAssociated(true);
        setAssociateError(null);
      } else {
        setAssociateError(
          r.reason === 'already-registered'
            ? 'That wallet is already bound to a different PRIESTATE account. Connect a different wallet.'
            : r.message ?? 'The wallet could not be associated. Try again.',
        );
      }
    } finally {
      setAssociateBusy(false);
    }
  }
}

// ── Presentational stepper rail ────────────────────────────────────

function StepRail({ step }: { step: RegistrationStep }) {
  const idx = REGISTRATION_STEP_ORDER.indexOf(step);
  return (
    <div className="registration-stepper" aria-label="Registration progress">
      <div className="registration-steps">
        {REGISTRATION_STEP_ORDER.map((s, i) => {
          const state = i < idx ? 'done' : i === idx ? 'active' : 'pending';
          const cls = `registration-step ${state}`;
          return (
            <div key={s} className={cls}>
              <div className="registration-step-indicator">
                <div className="registration-step-dot">
                  {state === 'done' && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                  {state === 'active' && <div className="registration-step-pulse" />}
                  {state === 'pending' && <span className="registration-step-num">{i + 1}</span>}
                </div>
                {i < REGISTRATION_STEP_ORDER.length - 1 && <div className="registration-step-line" />}
              </div>
              <span className="registration-step-label">{REGISTRATION_STEP_LABELS[s]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function failureMessage(r: RegistrationApiResult<unknown>): string {
  if (r.ok) return '';
  if (r.issues && r.issues.length > 0) return r.issues.join(' ');
  switch (r.reason) {
    case 'unavailable':
      return r.message ?? 'This step is unavailable because its real provider is not configured on the server.';
    case 'mismatch':
    case 'provider-error':
    case 'bad-state':
    case 'no-session':
      return r.message ?? 'This step could not be completed. Try again.';
    case 'already-registered':
      return 'This account is already registered. Please log in.';
    case 'rate-limited':
      return 'Too many attempts. Try again later.';
    default:
      return r.message ?? 'This step could not be completed. Try again.';
  }
}

const TERMINAL_LOCATION_STATES: readonly LocationSessionState[] = [
  'location_denied',
  'location_unavailable',
  'location_timeout',
  'location_stale',
  'location_invalid_cache',
  'location_accuracy_insufficient',
];

function locationStateMessage(state: LocationSessionState): string {
  switch (state) {
    case 'location_denied':
      return 'permission was denied.';
    case 'location_unavailable':
      return 'no signal was available.';
    case 'location_timeout':
      return 'it timed out.';
    case 'location_stale':
      return 'the fix was too old.';
    case 'location_accuracy_insufficient':
      return 'accuracy was too coarse.';
    case 'location_invalid_cache':
      return 'the fix was invalid.';
    default:
      return 'it was unavailable.';
  }
}