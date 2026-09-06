import { useState, useCallback, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import RegistrationStepper from '../components/RegistrationStepper';
import RegistrationLiveness from '../components/RegistrationLiveness';
import { useAuth } from '../auth/AuthContext';
import {
  validateRegistrationForm,
  normalizeIndianMobile,
  maskAadhaar,
  type AccountCapabilities,
  type RegistrationFactor,
  type RegistrationSnapshot,
  type RegistrationFieldErrors,
} from '../auth/account-types';
import {
  registerAccount,
  fetchAccountCapabilities,
  checkAccountExists,
  sendSmsOtp,
  verifySmsOtp,
  sendWhatsappOtp,
  verifyWhatsappOtp,
  submitIdentityEvidence,
} from '../auth/account-api';
import { useGoogleSignIn } from '../auth/google-oauth';
import { saveAccount, getAccount } from '../auth/account-store';

// FEATURE 3 — Secure user registration (`/register-account`).
//
// Registration is modelled as a SEQUENTIAL authentication state machine:
//
//   Connect Wallet → check account existence → (no account) → fill profile →
//   create account (wallet factor verified) → Google → SMS OTP → WhatsApp OTP
//
// If an account already exists for the wallet, the app does NOT create another
// account — it directs the user to Login. Registration authentication is only
// considered complete once every configured factor has passed. Missing
// factors are never silently bypassed.
//
// Passwords are hashed (salted scrypt) and raw PII is encrypted at rest — all
// on the verification server. This client only ever stores masked fragments
// and never a password, OTP, or raw PII. Google sign-in uses a server-issued
// state + nonce challenge.

type Phase = 'check' | 'form' | 'factors' | 'identity' | 'done';

export default function UserRegistrationPage() {
  const { address } = useAuth();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>('check');
  const [identityStage, setIdentityStage] = useState<'pending' | 'active' | 'done'>('pending');
  const [caps, setCaps] = useState<AccountCapabilities | null>(null);
  const [capsLoaded, setCapsLoaded] = useState(false);
  const [regState, setRegState] = useState<RegistrationSnapshot | null>(null);
  const [livenessPassed, setLivenessPassed] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [existsError, setExistsError] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [aadhaarNumber, setAadhaarNumber] = useState('');
  const [aadhaarMasked, setAadhaarMasked] = useState(false);
  const [addressOnAadhaar, setAddressOnAadhaar] = useState('');
  const [pincode, setPincode] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [passportPhoto, setPassportPhoto] = useState<File | null>(null);

  const [errors, setErrors] = useState<RegistrationFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  // Active factor-step state (only used once phase === 'factors').
  const [activeFactor, setActiveFactor] = useState<RegistrationFactor | 'google' | 'sms' | 'whatsapp' | null>(null);
  const [busyFactor, setBusyFactor] = useState<RegistrationFactor | null>(null);
  const [stepMessage, setStepMessage] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [smsCode, setSmsCode] = useState('');
  const [whatsappCode, setWhatsappCode] = useState('');
  const [smsSentAt, setSmsSentAt] = useState<number | null>(null);
  const [whatsappSentAt, setWhatsappSentAt] = useState<number | null>(null);

  // Authoritative account-existence check after wallet connect. If an account
  // already exists for this wallet, never create another — route to Login.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setExistsError(null);
    checkAccountExists(address).then((r) => {
      if (cancelled) return;
      setExistsError(r.ok ? null : (r.message ?? 'Could not check this wallet.'));
      const exists = r.ok ? r.data.exists : null;
      if (exists === true) {
        // Existing account → direction to login, NOT another registration.
        navigate('/login', { replace: true });
        return;
      }
      setPhase('form');
    });
    // Local fast-path (not authoritative): if a local account record exists,
    // skip straight to login too.
    if (getAccount(address)) {
      navigate('/login', { replace: true });
    }
    return () => { cancelled = true; };
  }, [address, navigate]);

  // Discover which server-side factor channels are configured (honest state).
  useEffect(() => {
    let cancelled = false;
    fetchAccountCapabilities().then((r) => {
      if (cancelled) return;
      setCaps(r.ok ? r.data : { smsConfigured: false, whatsappConfigured: false, googleConfigured: false, faceVerificationConfigured: false });
      setCapsLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  if (!address) {
    return (
      <div className="page profile-page">
        <ProductBanner />
        <div className="auth-gate">
          <h1 className="auth-gate-title">Connect your wallet to continue.</h1>
          <p className="auth-gate-desc">A connected Midnight wallet is required to create a PRIESTATE account.</p>
          <Link to="/" className="btn btn-primary btn-lg">Return Home</Link>
        </div>
      </div>
    );
  }

  const allFactorsConfigured = caps ? (caps.smsConfigured && caps.whatsappConfigured && caps.googleConfigured) : false;

  const handleAadhaarBlur = () => {
    if (aadhaarNumber.replace(/\s/g, '').length === 12) setAadhaarMasked(true);
  };

  const handleRegister = useCallback(async () => {
    setFormError(null);
    const formErrors = validateRegistrationForm({
      fullName,
      aadhaarNumber: aadhaarNumber.replace(/\s/g, ''),
      pincode,
      dateOfBirth,
      mobile,
      password,
      passwordConfirm,
    });
    setErrors(formErrors);
    if (Object.keys(formErrors).length > 0) return;
    if (!caps || !caps.smsConfigured || !caps.whatsappConfigured || !caps.googleConfigured) {
      setFormError('Registration requires live SMS, WhatsApp, and Google login factors, which are not all configured on the verification server in this demo. Configure the provider gateways to enable account creation.');
      return;
    }
    const mobileE164 = normalizeIndianMobile(mobile);
    if (!mobileE164) {
      setErrors({ mobile: 'Enter a valid Indian mobile number.' });
      return;
    }
    const result = await registerAccount({
      walletAddress: address,
      fullName: fullName.trim(),
      aadhaarNumber: aadhaarNumber.replace(/\s/g, ''),
      addressOnAadhaar: addressOnAadhaar.trim() || undefined,
      pincode: pincode.trim() || undefined,
      dateOfBirth,
      mobile: mobileE164,
      password,
      passwordConfirm,
    });
    if (!result.ok) {
      setFormError(registerErrorMessage(result.reason, result.message));
      return;
    }
    const view = result.data.account;
    saveAccount(view);
    // Move into the sequential registration FACTOR setup. Wallet factor is
    // verified at creation; the next pending factor is driven below.
    setPhase('factors');
    setRegState({
      walletVerified: true,
      googleVerified: view.googleLinked,
      smsVerified: view.smsOtpVerified,
      whatsappVerified: view.whatsappOtpVerified,
      complete: false,
      nextPendingFactor: 'google',
      pendingStep: 'Google',
    });
    setActiveFactor('google');
    setStepMessage('Complete each factor in order to finish authenticating your registration.');
  }, [address, aadhaarNumber, addressOnAadhaar, caps, dateOfBirth, fullName, mobile, password, passwordConfirm, pincode]);

  // ── Registration factor-step handlers ────────────────────────────

  const applyFactor = (patch: Partial<Pick<RegistrationSnapshot, 'googleVerified' | 'smsVerified' | 'whatsappVerified'>>) => {
    setRegState((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      const order: Array<'google' | 'sms' | 'whatsapp'> = ['google', 'sms', 'whatsapp'];
      const nextPending = order.find((f) => (f === 'google' ? !next.googleVerified : f === 'sms' ? !next.smsVerified : !next.whatsappVerified)) ?? null;
      next.nextPendingFactor = nextPending as RegistrationFactor | null;
      next.pendingStep = nextPending === null ? null : nextPending === 'google' ? 'Google' : nextPending === 'sms' ? 'SMS OTP' : 'WhatsApp OTP';
      next.complete = nextPending === null;
      return next;
    });
  };

  // Google factor (real OAuth popup flow, J.4). Linking is server-authoritative:
  // the account is marked Google-verified only after a server-side verified
  // OAuth redirect + challenge completion. The client never sees a code.
  const handleGoogleLinked = useCallback(() => {
    applyFactor({ googleVerified: true });
    setStepMessage(regState?.whatsappVerified && regState?.smsVerified
      ? 'Google linked. Registration authentication is complete.'
      : 'Google linked. Next: SMS OTP.');
    setActiveFactor(regState?.whatsappVerified ? null : regState?.smsVerified ? 'whatsapp' : 'sms');
  }, [regState]);

  const google = useGoogleSignIn(address, handleGoogleLinked);

  const handleSendSms = useCallback(async () => {
    if (!address) return;
    setStepError(null);
    setBusyFactor('sms');
    try {
      const r = await sendSmsOtp(address);
      if (!r.ok) {
        setStepError(`SMS OTP: ${factorStepMsg(r.reason, r.message)}`);
        return;
      }
      setSmsSentAt(Date.now());
      setStepMessage('SMS code sent. Enter the 6-digit code from your mobile.');
    } finally {
      setBusyFactor(null);
    }
  }, [address]);

  const handleVerifySms = useCallback(async () => {
    if (!address) return;
    if (smsCode.length !== 6) {
      setStepError('Enter the 6-digit SMS code.');
      return;
    }
    setStepError(null);
    setBusyFactor('sms');
    try {
      const r = await verifySmsOtp(address, smsCode);
      if (!r.ok) {
        setStepError(`SMS OTP: ${factorStepMsg(r.reason, r.message)}`);
        return;
      }
      applyFactor({ smsVerified: true });
      setSmsCode('');
      setSmsSentAt(null);
      setStepMessage(regState?.whatsappVerified ? 'SMS verified. Registration authentication is complete.' : 'SMS verified. Next: WhatsApp OTP.');
      setActiveFactor(regState?.whatsappVerified ? null : 'whatsapp');
    } finally {
      setBusyFactor(null);
    }
  }, [address, smsCode, regState]);

  const handleSendWhatsapp = useCallback(async () => {
    if (!address) return;
    setStepError(null);
    setBusyFactor('whatsapp');
    try {
      const r = await sendWhatsappOtp(address);
      if (!r.ok) {
        setStepError(`WhatsApp OTP: ${factorStepMsg(r.reason, r.message)}`);
        return;
      }
      setWhatsappSentAt(Date.now());
      setStepMessage('WhatsApp code sent. Enter the 6-digit code you received.');
    } finally {
      setBusyFactor(null);
    }
  }, [address]);

  const handleVerifyWhatsapp = useCallback(async () => {
    if (!address) return;
    if (whatsappCode.length !== 6) {
      setStepError('Enter the 6-digit WhatsApp code.');
      return;
    }
    setStepError(null);
    setBusyFactor('whatsapp');
    try {
      const r = await verifyWhatsappOtp(address, whatsappCode);
      if (!r.ok) {
        setStepError(`WhatsApp OTP: ${factorStepMsg(r.reason, r.message)}`);
        return;
      }
      applyFactor({ whatsappVerified: true });
      setWhatsappCode('');
      setWhatsappSentAt(null);
      setStepMessage('All registration authentication factors are verified. Enjoy your account!');
      setActiveFactor(null);
    } finally {
      setBusyFactor(null);
    }
  }, [address, whatsappCode]);

  // Existence check in progress / error.
  if (phase === 'check') {
    return (
      <div className="page profile-page">
        <ProductBanner />
        <div className="auth-gate">
          <h1 className="auth-gate-title">
            {existsError ? 'Could not check this wallet' : 'Checking this wallet…'}
          </h1>
          <p className="auth-gate-desc">
            {existsError
              ? `${existsError} Please try again.`
              : 'Verifying whether your wallet already has a PRIESTATE account.'}
          </p>
          {existsError && (
            <Link to="/" className="btn btn-primary btn-lg">Return Home</Link>
          )}
        </div>
      </div>
    );
  }

  // Registration factor setup (sequential Wallet → Google → SMS → WhatsApp).
  if (phase === 'factors') {
    return (
      <div className="page profile-page">
        <ProductBanner />
        <div className="page-header">
          <h1 className="page-title">Finish Registering Your Account</h1>
          <p className="page-desc" style={{ maxWidth: 680 }}>
            Your wallet factor is verified. Complete the remaining authentication
            factors <strong>in order</strong> to finish setting up your PRIESTATE
            account. Each factor requires a real, server-configured provider —
            none is ever faked. After the factors, a live camera + location
            identity check finalizes registration.
          </p>
        </div>

        <div className="account-card">
          <RegistrationStepper
            snapshot={regState}
            configured={{
              google: Boolean(caps?.googleConfigured),
              sms: Boolean(caps?.smsConfigured),
              whatsapp: Boolean(caps?.whatsappConfigured),
            }}
            busyFactor={google.busy && !busyFactor ? 'google' : busyFactor}
            message={stepMessage || (activeFactor ? `Complete the ${activeFactor === 'google' ? 'Google' : activeFactor === 'sms' ? 'SMS OTP' : 'WhatsApp OTP'} step.` : null)}
            identityStages={[
              { label: 'Location', state: identityStage === 'pending' ? 'pending' : 'done' },
              { label: 'Camera', state: identityStage === 'pending' ? 'pending' : 'done' },
              { label: 'Liveness', state: identityStage === 'active' && !livenessPassed ? 'active' : identityStage === 'done' ? 'done' : 'pending' },
            ]}
          />

          {activeFactor && (
            <section className="account-section">
              <h2 className="account-section-title">
                {activeFactor === 'google' ? 'Google (step 2 of 4)' : activeFactor === 'sms' ? 'SMS OTP (step 3 of 4)' : 'WhatsApp OTP (step 4 of 4)'}
              </h2>

              {/* Google (step 2): real OAuth popup flow — the client never handles a code. */}
          {activeFactor === 'google' && !google.challenge && (
            <div className="account-card-actions">
              <button className="btn btn-primary" onClick={() => void google.begin()} disabled={busyFactor === 'google' || !caps?.googleConfigured || google.busy}>
                {!caps?.googleConfigured ? 'Google unavailable on server' : google.busy ? 'Starting…' : 'Start Google sign-in'}
              </button>
              {!caps?.googleConfigured && (
                <span className="status-msg error" role="alert">Google is not configured on the verification server — this factor cannot be completed.</span>
              )}
            </div>
          )}

          {activeFactor === 'google' && google.challenge && (
            <div className="form-field">
              <button className="btn btn-primary" onClick={() => void google.begin()} disabled={busyFactor === 'google' || google.busy}>
                {google.busy ? 'Starting…' : 'Reopen Google sign-in'}
              </button>
              <button className="btn btn-ghost" onClick={() => void google.checkStatus()} disabled={google.busy}>
                {google.busy ? 'Checking…' : 'I finished in the popup — check status'}
              </button>
              <button className="btn btn-ghost" onClick={() => google.reset()}>Cancel</button>
              {google.popupOpen && (
                <span className="form-hint">A sign-in popup has been opened. Complete it to link your account.</span>
              )}
              {!google.popupOpen && (
                <span className="form-hint">If the popup did not open, allow popups for this site and reopen sign-in.</span>
              )}
            </div>
          )}

          {google.notice && <div className="status-msg info" role="status">{google.notice}</div>}
          {google.error && <div className="status-msg error" role="alert">{google.error}</div>}

              {activeFactor === 'sms' && (
                <div className="form-field">
                  {smsSentAt === null ? (
                    <button className="btn btn-primary" onClick={() => void handleSendSms()} disabled={busyFactor === 'sms' || !caps?.smsConfigured}>
                      {!caps?.smsConfigured ? 'SMS unavailable on server' : busyFactor === 'sms' ? 'Sending…' : 'Send SMS code'}
                    </button>
                  ) : (
                    <>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="form-input"
                        maxLength={6}
                        placeholder="_ _ _ _ _ _"
                        value={smsCode}
                        onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      />
                      <button className="btn btn-primary" onClick={() => void handleVerifySms()} disabled={busyFactor === 'sms' || smsCode.length !== 6}>
                        {busyFactor === 'sms' ? 'Verifying…' : 'Verify SMS code'}
                      </button>
                    </>
                  )}
                  {!caps?.smsConfigured && (
                    <span className="status-msg error" role="alert">SMS is not configured on the verification server — this factor cannot be completed.</span>
                  )}
                </div>
              )}

              {activeFactor === 'whatsapp' && (
                <div className="form-field">
                  {whatsappSentAt === null ? (
                    <button className="btn btn-primary" onClick={() => void handleSendWhatsapp()} disabled={busyFactor === 'whatsapp' || !caps?.whatsappConfigured}>
                      {!caps?.whatsappConfigured ? 'WhatsApp unavailable on server' : busyFactor === 'whatsapp' ? 'Sending…' : 'Send WhatsApp code'}
                    </button>
                  ) : (
                    <>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="form-input"
                        maxLength={6}
                        placeholder="_ _ _ _ _ _"
                        value={whatsappCode}
                        onChange={(e) => setWhatsappCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      />
                      <button className="btn btn-primary" onClick={() => void handleVerifyWhatsapp()} disabled={busyFactor === 'whatsapp' || whatsappCode.length !== 6}>
                        {busyFactor === 'whatsapp' ? 'Verifying…' : 'Verify WhatsApp code'}
                      </button>
                    </>
                  )}
                  {!caps?.whatsappConfigured && (
                    <span className="status-msg error" role="alert">WhatsApp is not configured on the verification server — this factor cannot be completed.</span>
                  )}
                </div>
              )}

              {stepError && <div className="status-msg error" role="alert">{stepError}</div>}
            </section>
          )}

          {/* Registration cannot reach the camera/liveness/location stage while
              a required external factor (Google/SMS/WhatsApp) is unconfigured,
              because the server hard-blocks account creation for it. Surface
              that honestly AND keep the identity stage reachable so the real
              camera + live-location UX can be exercised directly. */}
          {!allFactorsConfigured && (
            <div className="status-msg info" role="status">
              Google, SMS and WhatsApp factor channels are not all configured on
              the verification server in this demo, so the factor steps above
              cannot complete — and account creation is blocked. This build never
              fakes a factor. You can still run the real camera, liveness and
              live-location identity check below.
            </div>
          )}

          {identityStage === 'pending' && (
            <div className="account-card-actions">
              <button
                className="btn btn-primary btn-lg"
                onClick={() => setIdentityStage('active')}
              >
                Continue to Live Identity Check
              </button>
              <span className="account-card-note">
                Runs the real camera, motion liveness, and your live location —
                even when the factor channels above are unavailable.
              </span>
            </div>
          )}

          {identityStage === 'active' && !livenessPassed && (
            <div className="liveness-insert">
              <RegistrationLiveness
                onComplete={async (result) => {
                  // Liveness is not a fabricated boolean: only a real pass —
                  // combined with a validated server-side evidence read — advances
                  // registration to its completion state.
                  if (!result.passed) return;
                  const evidenceOk = identityStage === 'active'
                    ? await submitEvidenceForRegistration(result, address)
                    : false;
                  if (evidenceOk) {
                    setLivenessPassed(true);
                    setIdentityStage('done');
                    setIdentityError(null);
                  } else {
                    setIdentityError('The liveness or location report was rejected by the server. Try again.');
                  }
                }}
              />
            </div>
          )}

          {identityError && <div className="status-msg error" role="alert">{identityError}</div>}

          {identityStage === 'done' && livenessPassed && (
            <div className="account-card-actions">
              <button className="btn btn-primary btn-lg" onClick={() => navigate('/login')}>Continue to Login</button>
              <button className="btn btn-ghost" onClick={() => navigate('/dashboard')}>Dashboard</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page profile-page">
      <ProductBanner />
      <div className="page-header">
        <h1 className="page-title">Create Your PRIESTATE Account</h1>
        <p className="page-desc" style={{ maxWidth: 680 }}>
          Level 3 registration binds a secure account to your connected wallet.
          Your password is stored only as a salted hash and your Aadhaar,
          address, date of birth, and mobile number are encrypted at rest on
          the verification server — they are never stored on the ledger and
          never kept in plaintext on this device.
        </p>
      </div>

      <div className="account-card">
        <section className="account-section">
          <h2 className="account-section-title">Identity & Contact</h2>

          <div className="form-field">
            <label className="form-label" htmlFor="reg-fullname">Full Name (as on Aadhaar)</label>
            <input
              id="reg-fullname"
              type="text"
              autoComplete="name"
              className={`form-input${errors.fullName ? ' form-input-error' : ''}`}
              value={fullName}
              onChange={(e) => { setFullName(e.target.value); setErrors((prev) => ({ ...prev, fullName: undefined })); }}
            />
            {errors.fullName && <span className="form-error">{errors.fullName}</span>}
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="reg-aadhaar">Aadhaar Number</label>
            <input
              id="reg-aadhaar"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className={`form-input${errors.aadhaarNumber ? ' form-input-error' : ''}`}
              placeholder="•••• •••• 4321"
              value={aadhaarMasked && aadhaarNumber.length === 12 ? maskAadhaar(aadhaarNumber) : aadhaarNumber}
              onChange={(e) => { setAadhaarNumber(e.target.value.replace(/\D/g, '').slice(0, 12)); setAadhaarMasked(false); setErrors((prev) => ({ ...prev, aadhaarNumber: undefined })); }}
              onBlur={handleAadhaarBlur}
            />
            {errors.aadhaarNumber ? (
              <span className="form-error">{errors.aadhaarNumber}</span>
            ) : (
              <span className="form-hint">Masked after entry; encrypted at rest server-side. Never stored on-chain.</span>
            )}
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
            <span className="form-hint">Encrypted at rest. Never displayed publicly or stored on-chain.</span>
          </div>

          <div className="form-row">
            <div className="form-field">
              <label className="form-label" htmlFor="reg-pincode">Pincode</label>
              <input
                id="reg-pincode"
                type="text"
                inputMode="numeric"
                className={`form-input${errors.pincode ? ' form-input-error' : ''}`}
                value={pincode}
                maxLength={6}
                onChange={(e) => { setPincode(e.target.value.replace(/\D/g, '').slice(0, 6)); setErrors((prev) => ({ ...prev, pincode: undefined })); }}
              />
              {errors.pincode && <span className="form-error">{errors.pincode}</span>}
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="reg-dob">Date of Birth</label>
              <input
                id="reg-dob"
                type="date"
                className={`form-input${errors.dateOfBirth ? ' form-input-error' : ''}`}
                value={dateOfBirth}
                onChange={(e) => { setDateOfBirth(e.target.value); setErrors((prev) => ({ ...prev, dateOfBirth: undefined })); }}
              />
              {errors.dateOfBirth && <span className="form-error">{errors.dateOfBirth}</span>}
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
                className={`form-input${errors.mobile ? ' form-input-error' : ''}`}
                placeholder="9876543210"
                value={mobile}
                onChange={(e) => { setMobile(e.target.value.replace(/\D/g, '').slice(0, 10)); setErrors((prev) => ({ ...prev, mobile: undefined })); }}
              />
            </div>
            {errors.mobile && <span className="form-error">{errors.mobile}</span>}
            <span className="form-hint">Used for SMS and WhatsApp OTP at login. Encrypted at rest; shown only masked.</span>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="reg-photo">Passport Photo</label>
            <input
              id="reg-photo"
              type="file"
              accept="image/*"
              className="form-input"
              onChange={(e) => { const f = e.target.files?.[0] ?? null; setPassportPhoto(f); }}
            />
            <span className="form-hint">
              {passportPhoto
                ? `Selected: ${passportPhoto.name} (${(passportPhoto.size / 1024).toFixed(1)} KB). Used only for DEMO identity verification — never stored on-chain or retained as raw data.`
                : 'Upload a passport-style photo for the DEMO identity verification step. It is used only locally for the clearly-labelled demo face match.'}
            </span>
          </div>
        </section>

        <section className="account-section">
          <h2 className="account-section-title">Password</h2>
          <div className="form-row">
            <div className="form-field">
              <label className="form-label" htmlFor="reg-password">Password</label>
              <input
                id="reg-password"
                type="password"
                autoComplete="new-password"
                className={`form-input${errors.password ? ' form-input-error' : ''}`}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setErrors((prev) => ({ ...prev, password: undefined })); }}
              />
              {errors.password && <span className="form-error">{errors.password}</span>}
              <span className="form-hint">Stored only as a salted scrypt hash — never plaintext, never on-chain.</span>
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="reg-password-confirm">Confirm Password</label>
              <input
                id="reg-password-confirm"
                type="password"
                autoComplete="new-password"
                className={`form-input${errors.passwordConfirm ? ' form-input-error' : ''}`}
                value={passwordConfirm}
                onChange={(e) => { setPasswordConfirm(e.target.value); setErrors((prev) => ({ ...prev, passwordConfirm: undefined })); }}
              />
              {errors.passwordConfirm && <span className="form-error">{errors.passwordConfirm}</span>}
            </div>
          </div>
        </section>

        <section className="account-section">
          <h2 className="account-section-title">Login Factors</h2>
          <p className="account-section-desc">
            PRIESTATE login requires <strong>all</strong> of the following
            factors — they are not alternatives. Each is gated by a real
            provider configured on the verification server.
          </p>
          <FactorRow
            name="SMS OTP"
            configured={capsLoaded ? Boolean(caps?.smsConfigured) : null}
            detail="A one-time code sent by SMS to your registered mobile."
          />
          <FactorRow
            name="WhatsApp OTP"
            configured={capsLoaded ? Boolean(caps?.whatsappConfigured) : null}
            detail="A one-time code delivered over WhatsApp."
          />
          <FactorRow
            name="Google"
            configured={capsLoaded ? Boolean(caps?.googleConfigured) : null}
            detail="Sign in with Google (OAuth)."
          />
          {capsLoaded && !allFactorsConfigured && (
            <div className="status-msg info" role="status">
              Some login factors are not configured on the verification server
              in this demo. Until all three delivery channels are live,
              account creation and login cannot complete. No fake login is
              used.
            </div>
          )}
        </section>

        {formError && <div className="status-msg error" role="alert">{formError}</div>}

        <div className="account-card-actions">
          <button
            className="btn btn-primary btn-lg"
            onClick={() => void handleRegister()}
            disabled={!capsLoaded}
          >
            Create Account
          </button>
          <span className="account-card-note">
            Already have an account? <Link to="/login">Log in</Link>
          </span>
        </div>
      </div>
    </div>
  );
}

function FactorRow({ name, configured, detail }: { name: string; configured: boolean | null; detail: string }) {
  const state = configured === null ? 'Checking…' : configured ? 'Configured' : 'Unavailable';
  return (
    <div className={`account-factor ${configured ? 'account-factor-ok' : ''}`}>
      <div>
        <span className="account-factor-name">{name}</span>
        <span className="account-factor-detail">{detail}</span>
      </div>
      <span className={`status-pill ${configured ? 'status-registered' : 'status-marked-for-review'}`}>{state}</span>
    </div>
  );
}

function registerErrorMessage(reason: string, message?: string): string {
  switch (reason) {
    case 'already-registered':
      return 'This wallet already has an account. Please log in instead.';
    case 'invalid-input':
      return 'Some of the details you entered are invalid. Check the highlighted fields.';
    case 'unavailable':
      return message ?? 'Account creation is unavailable because the login factor providers are not fully configured.';
    case 'network-error':
      return message ?? 'Could not reach the verification server. Try again.';
    default:
      return message ?? 'Registration could not be completed. Try again.';
  }
}

function factorStepMsg(reason: string, message?: string): string {
  switch (reason) {
    case 'bad-state':
      return 'The sign-in challenge was missing or malformed. Please start the step again.';
    case 'expired':
      return 'This sign-in challenge expired. Start the step again.';
    case 'replay':
      return 'This sign-in attempt was already used. Start the step again.';
    case 'unavailable':
      return message ?? 'This factor is not configured on the verification server and cannot be completed.';
    case 'invalid-input':
      return message ?? 'The value you entered is invalid. Check and try again.';
    default:
      return message ?? 'That step could not be completed. Try again.';
  }
}

/**
 * Submit the combined registration identity evidence (real landmark liveness +
 * live browser location) to the server-authoritative boundary. Returns true only
 * when the server accepts it; a bare flag (e.g. a malformed or stale report or
 * a coerced client boolean) is rejected and registration does not advance.
 */
async function submitEvidenceForRegistration(
  result: { passed: boolean; locationEvidence: { latitude: number; longitude: number; accuracyMeters: number; timestampMs: number; nonce: string } | null },
  walletAddress: string,
): Promise<boolean> {
  if (!result.locationEvidence) return false;
  const loc = result.locationEvidence;
  const payload = {
    context: 'registration' as const,
    livenessPassed: result.passed,
    location: {
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracyMeters: loc.accuracyMeters,
      timestampMs: loc.timestampMs,
      nonce: loc.nonce,
    },
  };
  const r = await submitIdentityEvidence(walletAddress, payload);
  return r.ok === true && r.data.accepted === true;
}
