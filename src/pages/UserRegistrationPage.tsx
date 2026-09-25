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
  REGISTRATION_STAGE_LABELS,
  REGISTRATION_STAGE_ORDER,
  currentRegistrationStep,
  stageOfStep,
  type RegistrationCapabilities,
  type RegistrationLivenessEvidenceInput,
  type RegistrationStage,
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
import { useAuth } from '../auth/AuthContext';

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
  // The wallet is the SHARED auth instance — no second detection/connect is
  // ever created here, so the account flow never opens duplicate wallet
  // prompts or ends up out of sync with the rest of the app.
  const { wallet } = useAuth();
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
  // Canonical Aadhaar value: RAW DIGITS ONLY, never a masked string. The
  // mask is presentation-only and is driven by `aadhaarFocused`, so a focused
  // field always shows the complete raw digits. That keeps `onChange` reading
  // real input — previously the handler re-parsed the *masked* DOM value
  // (`•••• 9012`), whose leading 8 digits were stripped by `.replace(/\D/g,'')`
  // and silently lost, producing a short Aadhaar and a 400 invalid-input.
  const [aadhaarNumber, setAadhaarNumber] = useState('');
  const [aadhaarFocused, setAadhaarFocused] = useState(false);
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
      // Capabilities and resume-state are independent reads — fetch them in
      // parallel so boot never waits on two round-trips serially.
      const [capsRes, st] = await Promise.all([
        fetchRegistrationCapabilities(),
        fetchRegistrationStatus(),
      ]);
      if (!cancelled && capsRes.ok) setCaps(capsRes.data.capabilities);

      // No wallet is involved: if a previous registration left a live
      // `priestate_reg_sid` cookie, resume it; otherwise the user starts the
      // personal step below (which mints the cookie on submit).
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
                      {wallet.walletState === 'ready'
                        ? 'Connect Wallet'
                        : wallet.walletState === 'connecting'
                          ? 'Connecting…'
                          : 'Detecting wallet…'}
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
          Your account is created in a few short steps — and it never needs a
          wallet. We verify your details with real government data and secure
          the account with strong checks; your password is stored only as a
          salted hash, your documents are encrypted at rest, and nothing reaches
          the public ledger. A verification that is genuinely unavailable is
          never faked or skipped — you will see a clear message and can try again.
        </p>
      </div>

      <StageRail stage={stageOfStep(step)} />

      <div className="account-card">
        {stepError && <div className="status-msg error" role="alert">{stepError}</div>}

        {step === 'personal' && (
          <section className="account-section">
            <div className="account-stage-eyebrow">
              Step {REGISTRATION_STAGE_ORDER.indexOf('personal') + 1} of {REGISTRATION_STAGE_ORDER.length} — {REGISTRATION_STAGE_LABELS.personal}
            </div>
            <h2 className="account-section-title">Your Personal Details</h2>
            <p className="account-section-desc">
              Enter the details exactly as they appear on your Aadhaar. Your
              pincode is checked against real India Post data, and your details
              are stored only as an encrypted record — never on a public ledger
              and never with a wallet.
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
                value={aadhaarFocused || aadhaarNumber.length !== 12 ? aadhaarNumber : maskAadhaar(aadhaarNumber)}
                onFocus={() => setAadhaarFocused(true)}
                onChange={(e) => setAadhaarNumber(e.target.value.replace(/\D/g, '').slice(0, 12))}
                onBlur={() => setAadhaarFocused(false)}
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
                  <span className="form-hint">Pincode verification is temporarily unavailable.</span>
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
              <span className="form-hint">Used to send one-time login codes. Stored encrypted; shown only masked.</span>
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
            <div className="account-stage-eyebrow">
              Step {REGISTRATION_STAGE_ORDER.indexOf('identity') + 1} of {REGISTRATION_STAGE_ORDER.length} — {REGISTRATION_STAGE_LABELS.identity}
            </div>
            <h2 className="account-section-title">Verify your identity document</h2>
            <p className="account-section-desc">
              Upload a clear photo or PDF of a government-issued identity
              document (for example your Aadhaar or e-Aadhaar). The server
              verifies that the document details match what you entered, and
              stores only the encrypted result — the raw file is never kept.
            </p>
            {caps && !caps.aadhaarOcrConfigured && (
              <div className="status-msg error" role="alert">
                Identity verification is not configured in this environment, so
                this step cannot be completed and no Aadhaar document can be
                verified. This is a configuration issue rather than a temporary
                error — retrying will not help until the provider is configured.
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
              {stepBusy && <span className="form-hint">Uploading and verifying your document…</span>}
            </div>
          </section>
        )}

        {step === 'email' && (
          <section className="account-section">
            <div className="account-stage-eyebrow">
              Step {REGISTRATION_STAGE_ORDER.indexOf('identity') + 1} of {REGISTRATION_STAGE_ORDER.length} — {REGISTRATION_STAGE_LABELS.identity}
            </div>
            <h2 className="account-section-title">Confirm your email address</h2>
            <p className="account-section-desc">
              A one-time code is sent to your inbox so we can confirm this
              address belongs to you. The address is stored only inside your
              encrypted profile.
            </p>
            {caps && !caps.emailConfigured && (
              <div className="status-msg error" role="alert">
                Email confirmation is temporarily unavailable. Please try again later.
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
                  <label className="form-label" htmlFor="reg-email-code">One-time code</label>
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
            <div className="account-stage-eyebrow">
              Step {REGISTRATION_STAGE_ORDER.indexOf('identity') + 1} of {REGISTRATION_STAGE_ORDER.length} — {REGISTRATION_STAGE_LABELS.identity}
            </div>
            <h2 className="account-section-title">Confirm your mobile number</h2>
            <p className="account-section-desc">
              A one-time code is sent to your mobile number so we can confirm it
              belongs to you. Your number is stored encrypted and shown only
              masked.
            </p>
            {caps && !caps.smsConfigured && (
              <div className="status-msg error" role="alert">
                Mobile confirmation is temporarily unavailable. Please try again later.
              </div>
            )}
            {!smsSent ? (
              <div className="account-card-actions">
                <button className="btn btn-primary" onClick={() => void handleSendSms()} disabled={stepBusy || Boolean(caps && !caps.smsConfigured)}>
                  {stepBusy ? 'Sending…' : 'Send code'}
                </button>
              </div>
            ) : (
              <div className="form-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-sms-code">One-time code</label>
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
                    {stepBusy ? 'Verifying…' : 'Verify code'}
                  </button>
                </div>
              </div>
            )}
            <span className="form-hint">{status?.maskedMobile ? `Delivered to ${status.maskedMobile}.` : ''}</span>
          </section>
        )}

        {step === 'whatsapp-otp' && (
          <section className="account-section">
            <div className="account-stage-eyebrow">
              Step {REGISTRATION_STAGE_ORDER.indexOf('identity') + 1} of {REGISTRATION_STAGE_ORDER.length} — {REGISTRATION_STAGE_LABELS.identity}
            </div>
            <h2 className="account-section-title">Confirm on WhatsApp</h2>
            <p className="account-section-desc">
              A separate one-time code is sent over WhatsApp as an independent
              security check that your number is really yours.
            </p>
            {caps && !caps.whatsappConfigured && (
              <div className="status-msg error" role="alert">
                Confirmation by WhatsApp is temporarily unavailable. Please try again later.
              </div>
            )}
            {!waSent ? (
              <div className="account-card-actions">
                <button className="btn btn-primary" onClick={() => void handleSendWhatsapp()} disabled={stepBusy || Boolean(caps && !caps.whatsappConfigured)}>
                  {stepBusy ? 'Sending…' : 'Send code'}
                </button>
              </div>
            ) : (
              <div className="form-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-wa-code">One-time code</label>
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
                    {stepBusy ? 'Verifying…' : 'Verify code'}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {step === 'aadhaar-mobile' && (
          <section className="account-section">
            <div className="account-stage-eyebrow">
              Step {REGISTRATION_STAGE_ORDER.indexOf('identity') + 1} of {REGISTRATION_STAGE_ORDER.length} — {REGISTRATION_STAGE_LABELS.identity}
            </div>
            <h2 className="account-section-title">Confirm your Aadhaar-linked number</h2>
            <p className="account-section-desc">
              The server checks with its authorised provider that your registered
              mobile number is linked to an Aadhaar record — this is never
              inferred on your device.
            </p>
            {caps && !caps.aadhaarMobileConfigured && (
              <div className="status-msg error" role="alert">
                This check is temporarily unavailable. Please try again later.
              </div>
            )}
            {!amChallenge ? (
              <div className="account-card-actions">
                <button className="btn btn-primary" onClick={() => void handleStartAadhaarMobile()} disabled={stepBusy || Boolean(caps && !caps.aadhaarMobileConfigured)}>
                  {stepBusy ? 'Checking…' : 'Verify my number'}
                </button>
              </div>
            ) : (
              <div className="form-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-am-code">One-time code</label>
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
            <div className="account-stage-eyebrow">
              Step {REGISTRATION_STAGE_ORDER.indexOf('security') + 1} of {REGISTRATION_STAGE_ORDER.length} — {REGISTRATION_STAGE_LABELS.security}
            </div>
            <h2 className="account-section-title">Set a secure password</h2>
            <p className="account-section-desc">
              Your password is stored only as a salted cryptographic hash — never
              in plaintext, never on a ledger, and never in this browser.
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
            <div className="account-stage-eyebrow">
              Step {REGISTRATION_STAGE_ORDER.indexOf('security') + 1} of {REGISTRATION_STAGE_ORDER.length} — {REGISTRATION_STAGE_LABELS.security}
            </div>
            <h2 className="account-section-title">Add your photo</h2>
            <p className="account-section-desc">
              Upload a passport-style photo with a plain white background. The
              server validates it itself, and stores only a content reference —
              the photo bytes are never kept.
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
            <div className="account-stage-eyebrow">
              Step {REGISTRATION_STAGE_ORDER.indexOf('liveness') + 1} of {REGISTRATION_STAGE_ORDER.length} — {REGISTRATION_STAGE_LABELS.liveness}
            </div>
            <h2 className="account-section-title">Complete a live check</h2>
            <p className="account-section-desc">
              A short on-camera check with simple prompts confirms a real person
              is registering — it is verified server-side and never faked.
            </p>
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
            <div className="account-stage-eyebrow">
              Step {REGISTRATION_STAGE_ORDER.indexOf('liveness') + 1} of {REGISTRATION_STAGE_ORDER.length} — {REGISTRATION_STAGE_LABELS.liveness}
            </div>
            <h2 className="account-section-title">Verify your location</h2>
            <p className="account-section-desc">
              This runs only after your live check is recorded. A fresh, accurate
              location fix confirms you are where you say you are; the server
              validates it and never stores raw coordinates.
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
            <div className="account-stage-eyebrow">
              Step {REGISTRATION_STAGE_ORDER.indexOf('finalize') + 1} of {REGISTRATION_STAGE_ORDER.length} — {REGISTRATION_STAGE_LABELS.finalize}
            </div>
            <h2 className="account-section-title">Finish registration</h2>
            <p className="account-section-desc">
              All verification checks have passed. Finish to create your secure
              encrypted account record.
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
        // `postPersonal` already returns the authoritative new status — no
        // duplicate GET is needed here.
        setStatus(r.data);
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

// ── Presentational stage rail ──────────────────────────────────────
//
// The citizen sees only the five user-facing stages — NOT the internal
// provider/method checklist (OCR, SMS/WhatsApp OTP, liveness, etc.). The
// active stage is derived from the server-authoritative step; the full
// verification pipeline still runs underneath, exactly as before.

function StageRail({ stage }: { stage: RegistrationStage }) {
  const idx = REGISTRATION_STAGE_ORDER.indexOf(stage);
  return (
    <div className="registration-stepper registration-stage-rail" aria-label="Registration progress">
      <div className="registration-steps">
        {REGISTRATION_STAGE_ORDER.map((s, i) => {
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
                {i < REGISTRATION_STAGE_ORDER.length - 1 && <div className="registration-step-line" />}
              </div>
              <span className="registration-step-label registration-stage-label">
                {REGISTRATION_STAGE_LABELS[s]}
              </span>
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
      return r.message ?? 'This step is temporarily unavailable. Please try again later.';
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