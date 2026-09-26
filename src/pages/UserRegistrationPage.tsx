import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import BiometricEnrollment from '../components/BiometricEnrollment';
import ServerRegistrationLiveness, {
  type ServerLivenessStartResult,
  type ServerLivenessEvidenceResult,
} from '../components/ServerRegistrationLiveness';
import { maskAadhaar } from '../auth/account-types';
import {
  DEFAULT_COUNTRY_CODE,
  EARLIEST_BIRTH_DATE,
  INDIAN_STATES,
  isPersonalFormComplete,
  maskPan,
  normalizePan,
  todayIso,
  validatePersonalForm,
  type PersonalFormValues,
  type PersonalFieldName,
  type DiallingPlan,
  DIALLING_PLANS,
} from '../registration/personal-validation';
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
  completeRegistrationPersonal,
  reverseGeocodeRegistrationAddress,
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

  // ── Personal Information form state ─────────────────────────────
  //
  // The name is three separate fields — there is deliberately no single
  // combined full-name input. Canonical Aadhaar value: RAW DIGITS ONLY, never a
  // masked string. The mask is presentation-only and driven by `aadhaarFocused`,
  // so a focused field always shows the complete raw digits and `onChange` never
  // has to re-parse a masked DOM value (which used to silently drop the leading
  // 8 digits and produce a short Aadhaar → 400). PAN follows the same rule.
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [lastName, setLastName] = useState('');
  const [aadhaarNumber, setAadhaarNumber] = useState('');
  const [aadhaarFocused, setAadhaarFocused] = useState(false);
  const [panNumber, setPanNumber] = useState('');
  const [panFocused, setPanFocused] = useState(false);
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [stateName, setStateName] = useState('');
  const [pincode, setPincode] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [countryCode, setCountryCode] = useState<string>(DEFAULT_COUNTRY_CODE);
  /** Example number for the selected country, so the shape is never guessed. */
  const phonePlaceholder = useMemo(() => {
    const plan = DIALLING_PLANS.find((p) => `+${p.callingCode}` === countryCode);
    if (!plan) return '';
    const [min] = plan.nsnLength;
    const prefix = plan.mobilePrefixes[0] ?? '9';
    return prefix.padEnd(min, '0');
  }, [countryCode]);
  const [mobile, setMobile] = useState('');
  /** Reveal every inline error once the citizen has attempted to continue. */
  const [showPersonalErrors, setShowPersonalErrors] = useState(false);
  /** Fields the citizen has finished editing, so errors can surface on blur. */
  const [personalTouched, setPersonalTouched] = useState<Partial<Record<PersonalFieldName, boolean>>>({});
  const markTouched = useCallback((field: PersonalFieldName) => {
    setPersonalTouched((t) => (t[field] ? t : { ...t, [field]: true }));
  }, []);

  // ── Phone verification (compulsory, SMS OR WhatsApp) ─────────────
  type PhoneChannel = 'sms' | 'whatsapp';
  const [phoneChannel, setPhoneChannel] = useState<PhoneChannel>('sms');
  const [phoneCodeSent, setPhoneCodeSent] = useState(false);
  const [phoneCode, setPhoneCode] = useState('');

  // ── GPS address capture ──────────────────────────────────────────
  type LocationPhase = 'idle' | 'requesting' | 'resolving' | 'resolved' | 'denied' | 'unavailable' | 'failed';
  const [locationPhase, setLocationPhase] = useState<LocationPhase>('idle');
  /** True once the citizen has typed in the address box themselves. */
  const [addressTouched, setAddressTouched] = useState(false);
  /**
   * A resolved address that was NOT applied because the citizen had already
   * edited the field. Held so it can be applied explicitly rather than
   * silently overwriting their edit.
   */
  const [pendingFetched, setPendingFetched] = useState<{
    address: string;
    city: string;
    state: string;
    pincode: string;
  } | null>(null);

  // ── Two-phase personal submission state ──────────────────────────
  /** Phase 1 has landed: the encrypted PII record exists server-side. */
  const [personalSaved, setPersonalSaved] = useState(false);
  /** Snapshot of the values that were actually saved, to detect later edits. */
  const [savedValuesKey, setSavedValuesKey] = useState<string | null>(null);

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

  // ── Personal Information: derived validation state ──────────────

  const personalValues: PersonalFormValues = {
    firstName,
    middleName,
    lastName,
    countryCode,
    mobile,
    address,
    city,
    state: stateName,
    pincode,
    dateOfBirth,
    aadhaarNumber,
    panNumber,
  };
  const personalErrors = validatePersonalForm(personalValues);
  const personalFormComplete = isPersonalFormComplete(personalValues);
  /**
   * Show a field's error once it has been BLURRED, or once a submit was
   * attempted. Continue is disabled while the form is incomplete, so without
   * the blur trigger the citizen would get no indication of WHICH field is
   * wrong and could never surface the errors.
   */
  const errorFor = (field: PersonalFieldName): string | undefined =>
    (showPersonalErrors || personalTouched[field] ? personalErrors[field] : undefined);
  /** Editing any field after phase 1 invalidates the earlier phone proof. */
  const personalValuesKey = JSON.stringify(personalValues);
  const personalHasUnsavedEdits = personalSaved && savedValuesKey !== personalValuesKey;
  /** Server-authoritative: has a real channel proven the stored number? */
  const phoneVerified = status?.phoneVerified === true;
  /** True when a previous session already stored the details. */
  const detailsOnServer = personalSaved || Boolean(status?.maskedMobile);
  const activeChannelConfigured =
    phoneChannel === 'sms' ? caps?.smsConfigured === true : caps?.whatsappConfigured === true;
  const anyChannelConfigured = caps?.smsConfigured === true || caps?.whatsappConfigured === true;
  /** Continue unlocks only once the form is valid AND the phone is proven. */
  const canContinuePersonal =
    personalFormComplete && detailsOnServer && !personalHasUnsavedEdits && phoneVerified;

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
            <h2 className="account-section-title">Personal Information</h2>
            <p className="account-section-desc">
              Enter your details as they appear on your Aadhaar. Everything on
              this page is stored only as an encrypted record — never on a
              public ledger, never tied to a wallet, and shown back to you only
              masked. Your PIN code is checked against real India Post data.
            </p>

            {/* ── Resume state: details already on the server ── */}
            {detailsOnServer && (
              <div className="status-msg success" role="status">
                {phoneVerified
                  ? `Phone number confirmed${
                      status?.phoneChannel === 'whatsapp' ? ' via WhatsApp' : ' via SMS'
                    }${status?.maskedMobile ? ` (${status.maskedMobile})` : ''}. You can continue.`
                  : `Your details are saved${status?.maskedMobile ? ` for ${status.maskedMobile}` : ''}. Verify your phone number to continue.`}
              </div>
            )}

            {/* ── Name: three separate fields ── */}
            <fieldset className="form-fieldset">
              <legend className="form-legend">Name</legend>
              <div className="form-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-first-name">
                    First Name <span className="form-required" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="reg-first-name"
                    type="text"
                    autoComplete="given-name"
                    className={`form-input${errorFor('firstName') ? ' form-input-error' : ''}`}
                    value={firstName}
                    maxLength={40}
                    aria-required="true"
                    aria-invalid={errorFor('firstName') ? true : undefined}
                    onChange={(e) => setFirstName(e.target.value)}
                    onBlur={() => markTouched('firstName')}
                  />
                  {errorFor('firstName') && (
                    <span className="form-error" role="alert">{errorFor('firstName')}</span>
                  )}
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-middle-name">
                    Middle Name <span className="form-optional">(optional)</span>
                  </label>
                  <input
                    id="reg-middle-name"
                    type="text"
                    autoComplete="additional-name"
                    className={`form-input${errorFor('middleName') ? ' form-input-error' : ''}`}
                    value={middleName}
                    maxLength={40}
                    onChange={(e) => setMiddleName(e.target.value)}
                    onBlur={() => markTouched('middleName')}
                  />
                  {errorFor('middleName') && (
                    <span className="form-error" role="alert">{errorFor('middleName')}</span>
                  )}
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-last-name">
                    Last Name <span className="form-required" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="reg-last-name"
                    type="text"
                    autoComplete="family-name"
                    className={`form-input${errorFor('lastName') ? ' form-input-error' : ''}`}
                    value={lastName}
                    maxLength={40}
                    aria-required="true"
                    aria-invalid={errorFor('lastName') ? true : undefined}
                    onChange={(e) => setLastName(e.target.value)}
                    onBlur={() => markTouched('lastName')}
                  />
                  {errorFor('lastName') && (
                    <span className="form-error" role="alert">{errorFor('lastName')}</span>
                  )}
                </div>
              </div>
            </fieldset>

            {/* ── Phone: country code + number, compulsory verification ── */}
            <fieldset className="form-fieldset">
              <legend className="form-legend">
                Phone Number <span className="form-required" aria-hidden="true">*</span>
              </legend>
              <div className="form-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-country-code">Country Code</label>
                  <select
                    id="reg-country-code"
                    className={`form-input${errorFor('countryCode') ? ' form-input-error' : ''}`}
                    value={countryCode}
                    onChange={(e) => setCountryCode(e.target.value)}
                    onBlur={() => markTouched('countryCode')}
                  >
                    {DIALLING_PLANS.map((p: DiallingPlan) => (
                      <option key={p.iso2} value={`+${p.callingCode}`}>
                        +{p.callingCode} — {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-mobile">Phone Number</label>
                  <input
                    id="reg-mobile"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    maxLength={15}
                    placeholder={phonePlaceholder}
                    className={`form-input${errorFor('mobile') ? ' form-input-error' : ''}`}
                    value={mobile}
                    aria-required="true"
                    aria-invalid={errorFor('mobile') ? true : undefined}
                    onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 15))}
                    onBlur={() => markTouched('mobile')}
                  />
                  {errorFor('mobile') && (
                    <span className="form-error" role="alert">{errorFor('mobile')}</span>
                  )}
                </div>
              </div>
              {/* A foreign number is routable, but the identity proof below is
                  not: say so plainly rather than implying a foreign path. */}
              {countryCode !== DEFAULT_COUNTRY_CODE && (
                <p className="form-hint" role="note">
                  Your verification code is sent to this number. Aadhaar, the PIN code
                  and the state list remain Indian, so a foreign number does not change
                  the documents you will be verified against.
                </p>
              )}

              {/* Verification method: EITHER channel satisfies the requirement. */}
              <div className="form-field">
                <span className="form-label" id="phone-method-label">Verification method</span>
                <div className="verify-mobile-row" role="radiogroup" aria-labelledby="phone-method-label">
                  <label className={`verify-choice${phoneChannel === 'sms' ? ' verify-choice-on' : ''}${caps && !caps.smsConfigured ? ' verify-choice-off' : ''}`}>
                    <input
                      type="radio"
                      name="phone-channel"
                      value="sms"
                      checked={phoneChannel === 'sms'}
                      onChange={() => { setPhoneChannel('sms'); setPhoneCodeSent(false); setPhoneCode(''); }}
                    />
                    <span> SMS{caps && !caps.smsConfigured ? ' (not configured)' : ''}</span>
                  </label>
                  <label className={`verify-choice${phoneChannel === 'whatsapp' ? ' verify-choice-on' : ''}${caps && !caps.whatsappConfigured ? ' verify-choice-off' : ''}`}>
                    <input
                      type="radio"
                      name="phone-channel"
                      value="whatsapp"
                      checked={phoneChannel === 'whatsapp'}
                      onChange={() => { setPhoneChannel('whatsapp'); setPhoneCodeSent(false); setPhoneCode(''); }}
                    />
                    <span> WhatsApp{caps && !caps.whatsappConfigured ? ' (not configured)' : ''}</span>
                  </label>
                </div>
                <span className="form-hint">Stored encrypted; always shown masked. We never print the code here.</span>
              </div>

              {/* Provider-unavailable state — never faked, never auto-accepted. */}
              {caps && !anyChannelConfigured && (
                <div className="status-msg error" role="alert">
                  Phone verification is currently unavailable: no SMS or WhatsApp
                  provider is configured. We will not proceed without verifying
                  your number. Please contact support or try again later.
                </div>
              )}
              {caps && anyChannelConfigured && !activeChannelConfigured && (
                <div className="status-msg warn" role="status">
                  {phoneChannel === 'sms' ? 'SMS' : 'WhatsApp'} delivery is not
                  configured. Choose the other method to verify your number.
                </div>
              )}

              {phoneVerified ? (
                <div className="status-msg success" role="status">
                  Phone number verified{status?.phoneChannel === 'whatsapp' ? ' via WhatsApp' : ' via SMS'}.
                </div>
              ) : !phoneCodeSent ? (
                <div className="account-card-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => void handleVerifyPhone()}
                    disabled={
                      stepBusy ||
                      (!personalFormComplete && !detailsOnServer) ||
                      (caps ? !activeChannelConfigured : false)
                    }
                  >
                    {stepBusy ? 'Sending…' : 'Verify Phone'}
                  </button>
                </div>
              ) : (
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-phone-code">
                    Enter the code sent by {phoneChannel === 'sms' ? 'SMS' : 'WhatsApp'}
                  </label>
                  <div className="verify-mobile-row">
                    <input
                      id="reg-phone-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="_ _ _ _ _ _"
                      className="form-input"
                      value={phoneCode}
                      onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    />
                    <button
                      className="btn btn-primary"
                      onClick={() => void handleVerifyPhoneCode()}
                      disabled={stepBusy || phoneCode.length !== 6}
                    >
                      {stepBusy ? 'Verifying…' : 'Confirm code'}
                    </button>
                  </div>
                  <button
                    className="btn btn-ghost"
                    onClick={() => void handleVerifyPhone()}
                    disabled={stepBusy}
                  >
                    Resend code
                  </button>
                </div>
              )}
              <span className="form-hint">
                {status?.maskedMobile
                  ? `A code will be sent to ${status.maskedMobile}.`
                  : 'Your details are saved first, then the code is sent to that number.'}
              </span>
            </fieldset>

            {/* ── Address with GPS capture ── */}
            <fieldset className="form-fieldset">
              <legend className="form-legend">
                Address <span className="form-required" aria-hidden="true">*</span>
              </legend>
              <div className="account-card-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => void handleUseCurrentLocation()}
                  disabled={stepBusy || locationPhase === 'requesting' || locationPhase === 'resolving'}
                >
                  {locationPhase === 'requesting'
                    ? 'Requesting permission…'
                    : locationPhase === 'resolving'
                      ? 'Resolving address…'
                      : 'Use My Current Location'}
                </button>
              </div>

              {locationPhase === 'resolved' && (
                <div className="status-msg success" role="status">
                  Location detected. Review the address below and edit it if needed.
                </div>
              )}
              {locationPhase === 'denied' && (
                <div className="status-msg warn" role="alert">
                  Location permission was denied. You can type your address manually below.
                </div>
              )}
              {locationPhase === 'unavailable' && (
                <div className="status-msg warn" role="alert">
                  Address lookup is unavailable right now. You can type your address manually below.
                </div>
              )}
              {locationPhase === 'failed' && (
                <div className="status-msg warn" role="alert">
                  We could not resolve an address from your location. You can type it manually below.
                </div>
              )}

              {/* A resolved address that was NOT auto-applied over an edit. */}
              {pendingFetched && (
                <div className="status-msg warn" role="status">
                  <p>A different address was resolved from your location. Your edited address was kept.</p>
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      applyResolvedAddress(pendingFetched);
                      setPendingFetched(null);
                    }}
                    disabled={stepBusy}
                  >
                    Use the resolved address instead
                  </button>
                </div>
              )}

              <div className="form-field">
                <label className="form-label" htmlFor="reg-address">Full Address</label>
                <textarea
                  id="reg-address"
                  className={`form-input${errorFor('address') ? ' form-input-error' : ''}`}
                  rows={3}
                  maxLength={200}
                  value={address}
                  aria-required="true"
                  aria-invalid={errorFor('address') ? true : undefined}
                  onChange={(e) => { setAddress(e.target.value); setAddressTouched(true); }}
                />
                {errorFor('address') && (
                  <span className="form-error" role="alert">{errorFor('address')}</span>
                )}
                <span className="form-hint">
                  Editable at any time. Your precise coordinates are used once to
                  look up the address and are never stored.
                </span>
              </div>
            </fieldset>

            {/* ── DOB / PIN / State / City ── */}
            <fieldset className="form-fieldset">
              <legend className="form-legend">Additional Details</legend>
              <div className="form-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-dob">
                    Date of Birth <span className="form-required" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="reg-dob"
                    type="date"
                    className={`form-input${errorFor('dateOfBirth') ? ' form-input-error' : ''}`}
                    min={EARLIEST_BIRTH_DATE}
                    max={todayIso()}
                    value={dateOfBirth}
                    aria-required="true"
                    aria-invalid={errorFor('dateOfBirth') ? true : undefined}
                    onChange={(e) => setDateOfBirth(e.target.value)}
                    onBlur={() => markTouched('dateOfBirth')}
                  />
                  {errorFor('dateOfBirth') && (
                    <span className="form-error" role="alert">{errorFor('dateOfBirth')}</span>
                  )}
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-pincode">
                    PIN Code <span className="form-required" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="reg-pincode"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="560001"
                    className={`form-input${errorFor('pincode') ? ' form-input-error' : ''}`}
                    value={pincode}
                    aria-required="true"
                    aria-invalid={errorFor('pincode') ? true : undefined}
                    onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    onBlur={() => markTouched('pincode')}
                  />
                  {errorFor('pincode') ? (
                    <span className="form-error" role="alert">{errorFor('pincode')}</span>
                  ) : caps && !caps.pincodeConfigured ? (
                    <span className="form-hint">PIN code verification is temporarily unavailable.</span>
                  ) : (
                    <span className="form-hint">Checked against India Post data when you continue.</span>
                  )}
                </div>
              </div>
              <div className="form-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-state">
                    State <span className="form-required" aria-hidden="true">*</span>
                  </label>
                  <select
                    id="reg-state"
                    className={`form-input${errorFor('state') ? ' form-input-error' : ''}`}
                    value={stateName}
                    aria-required="true"
                    aria-invalid={errorFor('state') ? true : undefined}
                    onChange={(e) => setStateName(e.target.value)}
                    onBlur={() => markTouched('state')}
                  >
                    <option value="">Select a state</option>
                    {INDIAN_STATES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  {errorFor('state') && (
                    <span className="form-error" role="alert">{errorFor('state')}</span>
                  )}
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="reg-city">
                    City <span className="form-required" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="reg-city"
                    type="text"
                    list="reg-city-options"
                    autoComplete="address-level2"
                    className={`form-input${errorFor('city') ? ' form-input-error' : ''}`}
                    value={city}
                    maxLength={80}
                    aria-required="true"
                    aria-invalid={errorFor('city') ? true : undefined}
                    onChange={(e) => setCity(e.target.value)}
                    onBlur={() => markTouched('city')}
                  />
                  <datalist id="reg-city-options">
                    {[city, stateName].filter(Boolean).map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                  {errorFor('city') && (
                    <span className="form-error" role="alert">{errorFor('city')}</span>
                  )}
                </div>
              </div>
            </fieldset>

            {/* ── Aadhaar + PAN ── */}
            <fieldset className="form-fieldset">
              <legend className="form-legend">Identity Documents</legend>
              <div className="form-field">
                <label className="form-label" htmlFor="reg-aadhaar">
                  Aadhaar Card Number <span className="form-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="reg-aadhaar"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={12}
                  placeholder="•••• •••• ••••"
                  className={`form-input${errorFor('aadhaarNumber') ? ' form-input-error' : ''}`}
                  value={aadhaarFocused || aadhaarNumber.length !== 12 ? aadhaarNumber : maskAadhaar(aadhaarNumber)}
                  aria-required="true"
                  aria-invalid={errorFor('aadhaarNumber') ? true : undefined}
                  onFocus={() => setAadhaarFocused(true)}
                  onChange={(e) => setAadhaarNumber(e.target.value.replace(/\D/g, '').slice(0, 12))}
                  onBlur={() => { setAadhaarFocused(false); markTouched('aadhaarNumber'); }}
                />
                {errorFor('aadhaarNumber') ? (
                  <span className="form-error" role="alert">{errorFor('aadhaarNumber')}</span>
                ) : (
                  <span className="form-hint">
                    12 digits. Stored encrypted and never written to a public ledger.
                    Format is checked here only — that is not an Aadhaar verification.
                  </span>
                )}
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="reg-pan">
                  PAN Card Number <span className="form-optional">(optional)</span>
                </label>
                <input
                  id="reg-pan"
                  type="password"
                  autoComplete="off"
                  maxLength={10}
                  placeholder="ABCDE1234F"
                  className={`form-input${errorFor('panNumber') ? ' form-input-error' : ''}`}
                  value={panFocused || !normalizePan(panNumber) ? panNumber : maskPan(panNumber)}
                  aria-invalid={errorFor('panNumber') ? true : undefined}
                  onFocus={() => setPanFocused(true)}
                  onChange={(e) => setPanNumber(e.target.value.toUpperCase().slice(0, 10))}
                  onBlur={() => { setPanFocused(false); markTouched('panNumber'); }}
                />
                {errorFor('panNumber') ? (
                  <span className="form-error" role="alert">{errorFor('panNumber')}</span>
                ) : (
                  <span className="form-hint">
                    Stored encrypted. Format is checked here only — we do not
                    claim your PAN is verified without a real provider.
                  </span>
                )}
              </div>
            </fieldset>

            {personalHasUnsavedEdits && (
              <div className="status-msg warn" role="status">
                You changed a field after saving. Verify your phone number again
                so we can confirm the number belongs to these details.
              </div>
            )}

            <div className="account-card-actions">
              {detailsOnServer && (
                <button
                  className="btn btn-secondary"
                  onClick={() => void handlePersonal()}
                  disabled={stepBusy}
                >
                  {stepBusy ? 'Saving…' : 'Save details'}
                </button>
              )}
              <button
                className="btn btn-primary btn-lg"
                onClick={() => void handleContinuePersonal()}
                disabled={stepBusy || !canContinuePersonal}
              >
                {stepBusy ? 'Continuing…' : 'Continue'}
              </button>
            </div>
            {!canContinuePersonal && !stepBusy && (
              <span className="form-hint">
                {!personalFormComplete
                  ? 'Complete all required fields to continue.'
                  : !detailsOnServer
                    ? 'Save your details, then verify your phone number.'
                    : personalHasUnsavedEdits
                      ? 'Re-verify your phone number after your changes.'
                      : 'Verify your phone number to continue.'}
              </span>
            )}
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

  /**
   * Registration begins here, wallet-free: `begin` takes NO wallet address and
   * mints the HttpOnly session cookie. No wallet is connected or typed.
   *
   * Needed before anything session-scoped — including the GPS address lookup,
   * which the server ties to the registration session so the upstream geocoder
   * cannot be driven anonymously.
   */
  async function ensureSession(): Promise<boolean> {
    if (sessionStarted) return true;
    const begun = await beginRegistration();
    if (!begun.ok) {
      if (begun.reason === 'already-registered') {
        navigate('/login/user', { replace: true });
        return false;
      }
      setStepError(failureMessage(begun));
      return false;
    }
    setSessionStarted(true);
    return true;
  }

  /**
   * Phase 1: validate and store the encrypted PII record.
   *
   * Returns whether the record is now on the server, so the phone flow can
   * chain off it. The OTP gateways deliver to the STORED number, which is why
   * this must land before a code can be sent.
   */
  async function savePersonalDetails(): Promise<boolean> {
    setStepError(null);
    if (!(await ensureSession())) return false;
    const r = await postPersonal({
      firstName: firstName.trim(),
      middleName: middleName.trim() || undefined,
      lastName: lastName.trim(),
      aadhaarNumber: aadhaarNumber.replace(/\s/g, ''),
      panNumber: panNumber.trim() || undefined,
      addressOnAadhaar: address.trim() || undefined,
      city: city.trim() || undefined,
      state: stateName.trim() || undefined,
      pincode: pincode.trim() || undefined,
      dateOfBirth,
      mobileCountryCode: countryCode,
      mobile: mobile.replace(/\D/g, ''),
    });
    if (!r.ok) {
      setStepError(failureMessage(r));
      return false;
    }
    // `postPersonal` already returns the authoritative new status.
    setStatus(r.data);
    setPersonalSaved(true);
    setSavedValuesKey(personalValuesKey);
    return true;
  }

  async function handlePersonal(): Promise<void> {
    setShowPersonalErrors(true);
    if (!personalFormComplete) {
      setStepError('Please correct the highlighted fields before continuing.');
      return;
    }
    setStepBusy(true);
    try {
      if (await savePersonalDetails()) {
        setShowPersonalErrors(false);
      }
    } finally {
      setStepBusy(false);
    }
  }

  /**
   * Phase 2: the explicit Continue gate.
   *
   * The phone must already be proven. The server re-checks this, so a stale or
   * tampered client cannot skip it — it fails closed with bad-state.
   */
  async function handleContinuePersonal(): Promise<void> {
    setStepError(null);
    if (!personalFormComplete || personalHasUnsavedEdits) {
      setShowPersonalErrors(true);
      setStepError('Please correct the highlighted fields before continuing.');
      return;
    }
    if (!detailsOnServer) {
      setStepError('Save your details before verifying your phone number.');
      return;
    }
    if (!phoneVerified) {
      setStepError('Verify your phone number over SMS or WhatsApp before continuing.');
      return;
    }
    setStepBusy(true);
    try {
      const r = await completeRegistrationPersonal();
      if (r.ok) {
        setStatus(r.data);
      } else {
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  /** "Use My Current Location" — browser GPS → server-side reverse geocode. */
  async function handleUseCurrentLocation(): Promise<void> {
    setStepError(null);
    setPendingFetched(null);
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationPhase('unavailable');
      return;
    }
    if (!caps?.geocodingConfigured) {
      setLocationPhase('unavailable');
      return;
    }
    // The geocoding endpoint is session-scoped so the upstream provider cannot
    // be driven anonymously, and a citizen may look up their address BEFORE
    // saving anything. Start the session first, otherwise the lookup 401s.
    if (!(await ensureSession())) {
      setLocationPhase('failed');
      return;
    }
    setLocationPhase('requesting');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void (async () => {
          setLocationPhase('resolving');
          // The coordinate pair is sent once to resolve an address and is then
          // discarded — it is never stored and never shown back to the citizen.
          const r = await reverseGeocodeRegistrationAddress(pos.coords.latitude, pos.coords.longitude);
          if (!r.ok) {
            setLocationPhase(r.reason === 'unavailable' ? 'unavailable' : 'failed');
            return;
          }
          const resolved = {
            address: r.data.address,
            city: r.data.city,
            state: r.data.state,
            pincode: r.data.pincode,
          };
          if (!resolved.address && !resolved.city) {
            setLocationPhase('failed');
            return;
          }
          // NEVER silently overwrite an address the citizen edited themselves.
          if (addressTouched && (address.trim() || city.trim() || stateName.trim() || pincode.trim())) {
            setPendingFetched(resolved);
            setLocationPhase('resolved');
            return;
          }
          applyResolvedAddress(resolved);
          setLocationPhase('resolved');
        })();
      },
      (err) => {
        setLocationPhase(err.code === err.PERMISSION_DENIED ? 'denied' : 'failed');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }

  function applyResolvedAddress(resolved: {
    address: string;
    city: string;
    state: string;
    pincode: string;
  }): void {
    if (resolved.address) setAddress(resolved.address);
    // City / state / pincode stay editable; they are only prefilled when the
    // citizen has not already typed their own.
    if (resolved.city && !city.trim()) setCity(resolved.city);
    if (resolved.state && !stateName.trim()) setStateName(resolved.state);
    if (resolved.pincode && !pincode.trim()) setPincode(resolved.pincode.replace(/\D/g, '').slice(0, 6));
    setAddressTouched(false);
  }

  /**
   * Send the one-time code over the selected channel.
   *
   * Phase 1 lands first, because the gateways deliver to the stored number.
   * When no provider is configured this surfaces the unavailable state instead
   * of pretending a code was sent.
   */
  async function handleVerifyPhone(): Promise<void> {
    setStepError(null);
    setShowPersonalErrors(true);
    // A resumed session already has the number on the server — only the MASKED
    // form comes back, by design, so the local fields are empty. The OTP
    // gateways deliver to the STORED number, so there is nothing to re-enter
    // and nothing to re-save; requiring a locally complete form here would
    // strand anyone who refreshed the page mid-verification.
    const resuming = detailsOnServer && !personalHasUnsavedEdits;
    if (!personalFormComplete && !resuming) {
      setStepError('Please correct the highlighted fields before verifying your phone.');
      return;
    }
    if (!activeChannelConfigured) {
      setStepError(
        phoneChannel === 'sms'
          ? 'SMS delivery is not configured. Choose WhatsApp or try again later.'
          : 'WhatsApp delivery is not configured. Choose SMS or try again later.',
      );
      return;
    }
    setStepBusy(true);
    try {
      // Only push details when they are actually complete on this device;
      // re-saving a resumed session would needlessly revoke nothing but would
      // also demand the full form again.
      if (!resuming && !(await savePersonalDetails())) return;
      const r =
        phoneChannel === 'sms' ? await issueRegistrationSmsOtp() : await issueRegistrationWhatsappOtp();
      if (r.ok) {
        setPhoneCodeSent(true);
        setPhoneCode('');
      } else {
        setPhoneCodeSent(false);
        setStepError(failureMessage(r));
      }
    } finally {
      setStepBusy(false);
    }
  }

  /** Confirm the one-time code over the channel that issued it. */
  async function handleVerifyPhoneCode(): Promise<void> {
    setStepError(null);
    setStepBusy(true);
    try {
      const r =
        phoneChannel === 'sms'
          ? await verifyRegistrationSmsOtp(phoneCode)
          : await verifyRegistrationWhatsappOtp(phoneCode);
      if (r.ok) {
        const st = await refreshStatus();
        if (st?.phoneVerified) {
          setPhoneCode('');
          setPhoneCodeSent(false);
        } else {
          setStepError('That code was not accepted. Request a new one and try again.');
        }
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