import { useState, useCallback, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import LoginStepper from '../components/LoginStepper';
import LoginFaceVerification from '../components/LoginFaceVerification';
import { useAuth } from '../auth/AuthContext';
import type { AccountCapabilities, FaceVerificationSnapshot, LoginSnapshot, LoginFactor } from '../auth/account-types';
import { isLoginReady } from '../auth/account-types';
import {
  loginAccount,
  sendSmsOtp,
  verifySmsOtp,
  sendWhatsappOtp,
  verifyWhatsappOtp,
  fetchAccountCapabilities,
  fetchLoginState,
  fetchFaceVerificationState,
} from '../auth/account-api';
import { useGoogleSignIn } from '../auth/google-oauth';
import { getAccount, isAccountFullyVerified } from '../auth/account-store';

// PRIESTATE — User login (wallet + mandatory multi-factor).
//
// This is the citizen/user login flow, moved to /login/user behind the wallet
// gate. See /login (the account-type chooser) for how a user reaches it.

// Phases:  check → factors → complete → face
//
//   * check     after a wallet is connected, call the authoritative server
//     account-existence endpoint. No account  → route to Registration.
//     An account exists → proceed to the login factor flow. Login NEVER
//     creates an account.
//   * factors   render the sequential login stepper
//     (Wallet → Google → SMS OTP → WhatsApp OTP). Every factor is REQUIREd,
//     in order. After each successful factor the login state is re-fetched
//     from the server and the stepper advances. A factor whose provider is
//     unconfigured is shown as unavailable and cannot be skipped — this UI
//     never fakes a factor.
//   * complete  the password step. ONLY after every required factor holds
//     does the password unlock the existing server login endpoint, which
//     mints the opaque, wallet-bound, HttpOnly server session. The session is
//     never created before all factors pass and never stored in localStorage.
//   * face      the terminal subsequent-identity stage. It runs AFTER the
//     password has minted the session (the face endpoint requires the session),
//     as a separate explicit identity step — never a login factor. The client
//     navigates to the dashboard only when the server reports a REAL biometric
//     match (`identity_verified`); anything else fails closed here.

// Security notes: no password/OTP/token/session secret is ever placed in URLs,
// query params, localStorage, logs, or VITE_* variables. The client only
// reflects server-authoritative state — it never decides authentication.

export default function UserLoginPage() {
  const { address } = useAuth();
  const navigate = useNavigate();

  const [caps, setCaps] = useState<AccountCapabilities | null>(null);
  const [capsLoaded, setCapsLoaded] = useState(false);
  // Login snapshot (server-authoritative). null while unknown.
  const [login, setLogin] = useState<LoginSnapshot | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);
  // Phase: 'check' | 'factors' | 'complete' | 'face'.
  const [phase, setPhase] = useState<'check' | 'factors' | 'complete' | 'face'>('check');
  const [password, setPassword] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [whatsappCode, setWhatsappCode] = useState('');
  const [smsSentAt, setSmsSentAt] = useState<number | null>(null);
  const [whatsappSentAt, setWhatsappSentAt] = useState<number | null>(null);
  const [busyFactor, setBusyFactor] = useState<LoginFactor | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [factorError, setFactorError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Server-authoritative subsequent identity (face) verification stage.
  const [faceSnap, setFaceSnap] = useState<FaceVerificationSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAccountCapabilities().then((r) => {
      if (cancelled) return;
      setCaps(r.ok ? r.data : { smsConfigured: false, whatsappConfigured: false, googleConfigured: false, faceVerificationConfigured: false });
      setCapsLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  // Fetch the honest, server-authoritative face-verification stage for this
  // wallet whenever a wallet is connected and an account exists.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetchFaceVerificationState(address).then((r) => {
      if (cancelled) return;
      setFaceSnap(r.ok ? r.data.faceVerification : null);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // On connect, run the authoritative check phase.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setPhase('check');
    setExists(null);
    fetchLoginState(address).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        // If the login-state endpoint is unreachable we cannot safely route;
        // surface an honest failure rather than guessing.
        setLoginError('Could not reach the verification server to check your account.');
        setPhase('factors');
        return;
      }
      setExists(r.data.exists);
      setLogin(r.data.login);
      if (!r.data.exists) {
        // No account for this wallet → Registration.
        navigate('/register-account', { replace: true });
        return;
      }
      setPhase('factors');
      advancePhase(r.data.login);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, navigate]);

  /** Re-fetch login state after a factor completes; return the fresh snapshot. */
  const refreshLogin = useCallback(async (): Promise<LoginSnapshot | null> => {
    if (!address) return null;
    const r = await fetchLoginState(address);
    if (!r.ok) {
      setFactorError('Could not re-check your login state.');
      return null;
    }
    setExists(r.data.exists);
    const snap = r.data.login;
    setLogin(snap);
    // Only return a snapshot when the account still exists for this wallet.
    return r.data.exists ? snap : null;
  }, [address]);

  const advancePhase = useCallback((snap: LoginSnapshot | null) => {
    if (isLoginReady(snap)) setPhase('complete');
    else setPhase('factors');
  }, []);

  if (!address) {
    return (
      <div className="page profile-page">
        <ProductBanner />
        <div className="auth-gate">
          <h1 className="auth-gate-title">Connect your wallet to continue.</h1>
          <p className="auth-gate-desc">A connected Midnight wallet is the first factor of PRIESTATE login.</p>
          <Link to="/" className="btn btn-primary btn-lg">Return Home</Link>
        </div>
      </div>
    );
  }

  const local = getAccount(address);
  const allFactorsConfigured = caps ? (caps.smsConfigured && caps.whatsappConfigured && caps.googleConfigured) : false;
  const canFactor = (f: LoginFactor): boolean => {
    if (!caps) return false;
    return f === 'google' ? caps.googleConfigured : f === 'sms' ? caps.smsConfigured : caps.whatsappConfigured;
  };

  // ── Factor handlers ───────────────────────────────────────────────

  const handleSendSms = useCallback(async () => {
    if (!address) return;
    setFactorError(null);
    setSmsSentAt(null);
    const r = await sendSmsOtp(address);
    if (r.ok) setSmsSentAt(Date.now());
    else setFactorError(`SMS OTP: ${factorMsg(r.reason, r.message)}`);
  }, [address]);

  const handleVerifySms = useCallback(async () => {
    if (!address) return;
    setFactorError(null);
    setBusyFactor('sms');
    try {
      const r = await verifySmsOtp(address, smsCode);
      if (r.ok) {
        setSmsSentAt(null);
        // Advance using the FRESH server snapshot — never the stale `login`
        // captured before the re-fetch settled (a stale snapshot could leave
        // the stepper stuck on a factor that actually completed).
        const snap = await refreshLogin();
        if (snap !== null) advancePhase(snap);
      } else {
        setFactorError(`SMS OTP: ${otpMsg(r.reason, r.message)}`);
      }
    } finally {
      setBusyFactor(null);
    }
  }, [address, smsCode, refreshLogin, advancePhase]);

  const handleSendWhatsapp = useCallback(async () => {
    if (!address) return;
    setFactorError(null);
    setWhatsappSentAt(null);
    const r = await sendWhatsappOtp(address);
    if (r.ok) setWhatsappSentAt(Date.now());
    else setFactorError(`WhatsApp OTP: ${factorMsg(r.reason, r.message)}`);
  }, [address]);

  const handleVerifyWhatsapp = useCallback(async () => {
    if (!address) return;
    setFactorError(null);
    setBusyFactor('whatsapp');
    try {
      const r = await verifyWhatsappOtp(address, whatsappCode);
      if (r.ok) {
        setWhatsappSentAt(null);
        // Advance using the FRESH server snapshot (see SMS handler).
        const snap = await refreshLogin();
        if (snap !== null) advancePhase(snap);
      } else {
        setFactorError(`WhatsApp OTP: ${otpMsg(r.reason, r.message)}`);
      }
    } finally {
      setBusyFactor(null);
    }
  }, [address, whatsappCode, refreshLogin, advancePhase]);

  // Google factor (real OAuth popup flow, J.4). Linking is server-authoritative:
  // the account is marked verified only after a server-side verified redirect.
  const handleGoogleLinked = useCallback(async () => {
    if (!address) return;
    setFactorError(null);
    setBusyFactor('google');
    try {
      const r = await fetchLoginState(address);
      if (!r.ok || !r.data.exists) {
        setFactorError('Could not re-check your login state after linking Google.');
        return;
      }
      setExists(r.data.exists);
      setLogin(r.data.login);
      setPhase(isLoginReady(r.data.login) ? 'complete' : 'factors');
    } finally {
      setBusyFactor(null);
    }
  }, [address]);

  const google = useGoogleSignIn(address, handleGoogleLinked);

  const handleLogin = useCallback(async () => {
    if (!address) return;
    setLoginError(null);
    setBusy(true);
    try {
      if (!capsLoaded || !caps || !allFactorsConfigured) {
        setLoginError('Login requires live SMS, WhatsApp, and Google factors, which are not all configured on the verification server in this demo.');
        return;
      }
      if (exists === false) {
        setLoginError('No account is registered for this wallet yet. Please create an account first.');
        return;
      }
      if (!isLoginReady(login)) {
        setLoginError('One or more login factors are incomplete. Complete Google, SMS, and WhatsApp, then log in.');
        return;
      }
      const r = await loginAccount(address, password);
      if (r.ok) {
        // The server has minted the session via HttpOnly cookie. Per Decision 2
        // the dashboard is reached ONLY through the real face match below —
        // password success alone transitions to the 'face' stage, it does NOT
        // navigate. Re-fetch the authoritative snapshot so the face stage sees
        // the post-login identity state.
        const fr = await fetchFaceVerificationState(address);
        setFaceSnap(fr.ok ? fr.data.faceVerification : null);
        setPhase('face');
        return;
      }
      setLoginError(loginMsg(r.reason));
    } finally {
      setBusy(false);
    }
  }, [address, allFactorsConfigured, caps, capsLoaded, exists, login, password]);

  // ── Check phase ───────────────────────────────────────────────────
  if (phase === 'check') {
    return (
      <div className="page profile-page">
        <ProductBanner />
        <div className="page-header">
          <h1 className="page-title">Log In</h1>
        </div>
        <div className="account-card">
          <div className="account-item status-existing">
            <span className="account-item-label">Wallet</span>
            <span className="account-item-value">{address.slice(0, 6)}…{address.slice(-6)}</span>
          </div>
          <div className="status-msg info" role="status">
            Checking your account… <span className="spinner-inline" aria-hidden="true" />
          </div>
          {loginError && <div className="status-msg error" role="alert">{loginError}</div>}
        </div>
      </div>
    );
  }

  const nextFactor = login?.nextPendingFactor;
  const allReady = isLoginReady(login);
  const isNewAccount = local === null;

  return (
    <div className="page profile-page">
      <ProductBanner />
      <div className="page-header">
        <h1 className="page-title">Log In</h1>
        <p className="page-desc" style={{ maxWidth: 680 }}>
          PRIESTATE requires a <strong>mandatory multi-factor</strong> login:
          your wallet, Google, an SMS OTP, a WhatsApp OTP, then your password.
          Factors already verified for this account are shown as complete; the
          current required factor is the only actionable one.
        </p>
      </div>

      <div className="account-card">
        <div className={`account-item status-${isNewAccount ? 'new' : 'existing'}`}>
          <span className="account-item-label">Wallet</span>
          <span className="account-item-value">{address.slice(0, 6)}…{address.slice(-6)}</span>
          <span className="status-pill status-registered">{isNewAccount ? 'NEW' : 'ACCOUNT'}</span>
        </div>

        {!isNewAccount && !isAccountFullyVerified(local) && (
          <div className="status-msg info" role="status">
            Identity verification is still pending for this account.
            {` `}<Link to="/identity-verification">Complete identity verification</Link>.
          </div>
        )}

        <LoginStepper
          snapshot={login}
          configured={{
            google: caps ? caps.googleConfigured : false,
            sms: caps ? caps.smsConfigured : false,
            whatsapp: caps ? caps.whatsappConfigured : false,
          }}
          busyFactor={busyFactor}
          completing={phase === 'complete'}
          message={factorError}
        />

        {/* ── Pending factors ─────────────────────────────────────── */}
        {!allReady && nextFactor === 'google' && (
          <section className="account-section">
            <h2 className="account-section-title">Google (required)</h2>
            <p className="account-section-desc">
              Sign in with Google via the real OAuth exchange on the server. A
              popup opens to complete the sign-in; the authorization code is
              exchanged and verified entirely server-side and never handled by
              this browser.
            </p>
            {!google.challenge ? (
              <button
                className="btn btn-primary"
                onClick={() => void google.begin()}
                disabled={!canFactor('google') || google.busy}
              >
                {!canFactor('google') ? 'Google unavailable on server' : google.busy ? 'Starting…' : 'Sign in with Google'}
              </button>
            ) : (
              <div className="form-field">
                <button className="btn btn-primary" onClick={() => void google.begin()} disabled={google.busy}>
                  Reopen Google sign-in
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
            {!canFactor('google') && (
              <span className="form-hint">Google login is not configured on the verification server in this demo.</span>
            )}
          </section>
        )}

        {!allReady && nextFactor === 'sms' && (
          <section className="account-section">
            <h2 className="account-section-title">SMS OTP (required)</h2>
            {smsSentAt === null ? (
              <button className="btn btn-primary" onClick={() => void handleSendSms()} disabled={!canFactor('sms')}>
                Send SMS code
              </button>
            ) : (
              <div className="form-field">
                <input
                  type="text"
                  inputMode="numeric"
                  className="form-input"
                  maxLength={6}
                  placeholder="_ _ _ _ _ _"
                  value={smsCode}
                  onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                <button className="btn btn-primary" onClick={() => void handleVerifySms()} disabled={smsCode.length !== 6}>
                  Verify SMS code
                </button>
                <button className="btn btn-ghost" onClick={() => void handleSendSms()}>Resend</button>
              </div>
            )}
            {!canFactor('sms') && <span className="form-hint">SMS verification is not configured on the server in this demo.</span>}
          </section>
        )}

        {!allReady && nextFactor === 'whatsapp' && (
          <section className="account-section">
            <h2 className="account-section-title">WhatsApp OTP (required)</h2>
            {whatsappSentAt === null ? (
              <button className="btn btn-primary" onClick={() => void handleSendWhatsapp()} disabled={!canFactor('whatsapp')}>
                Send WhatsApp code
              </button>
            ) : (
              <div className="form-field">
                <input
                  type="text"
                  inputMode="numeric"
                  className="form-input"
                  maxLength={6}
                  placeholder="_ _ _ _ _ _"
                  value={whatsappCode}
                  onChange={(e) => setWhatsappCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                <button className="btn btn-primary" onClick={() => void handleVerifyWhatsapp()} disabled={whatsappCode.length !== 6}>
                  Verify WhatsApp code
                </button>
                <button className="btn btn-ghost" onClick={() => void handleSendWhatsapp()}>Resend</button>
              </div>
            )}
            {!canFactor('whatsapp') && <span className="form-hint">WhatsApp verification is not configured on the server in this demo.</span>}
          </section>
        )}

        {/* ── Complete / password ─────────────────────────────────── */}
        {allReady && phase === 'complete' && (
          <section className="account-section">
            <h2 className="account-section-title">Complete (password)</h2>
            <p className="account-section-desc">
              All required login factors are verified. Enter your password to obtain your
              authenticated session.
            </p>
            <div className="form-field">
              <input
                type="password"
                autoComplete="current-password"
                className="form-input"
                placeholder="Account password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className="form-hint">Verified against a salted scrypt hash on the server — never stored as plaintext.</span>
            </div>
          </section>
        )}

        {/* ── Subsequent identity stage: face verification (Part 6) ───
            Runs AFTER the password completes the five-factor login and the
            server has minted the session (the face endpoint is
            session-required). This is a separate explicit identity step —
            never a login factor — and the dashboard is reached ONLY through
            a real server-side face match (`onPassed`). Fail-closed otherwise. */}
        {phase === 'face' && (
          <section className="account-section">
            <h2 className="account-section-title">Identity verification (face)</h2>
            <p className="account-section-desc">
              Your login factors and password are complete and your session is
              active. Verifying your identity with your live face is the final,
              separate step before you reach the dashboard — it only succeeds
              on a real match against your encrypted enrollment reference, and
              honestly fails closed otherwise.
            </p>
            <LoginFaceVerification
              snapshot={faceSnap}
              walletAddress={address ?? undefined}
              onPassed={() => navigate('/dashboard', { replace: true })}
            />
          </section>
        )}

        {factorError && <div className="status-msg error" role="alert">{factorError}</div>}
        {loginError && <div className="status-msg error" role="alert">{loginError}</div>}

        {allReady && phase === 'complete' ? (
          <div className="account-card-actions">
            <button
              className="btn btn-primary btn-lg"
              onClick={() => void handleLogin()}
              disabled={busy || !isLoginReady(login)}
            >
              {busy ? 'Logging in…' : `Complete Login`}
            </button>
          </div>
        ) : (
          <div className="account-card-actions">
            {allReady && phase === 'face' && (
              <span className="account-card-note">
                Face verification is the final step. The dashboard opens only on a real
                identity match.
              </span>
            )}
            {!allFactorsConfigured && (
              <span className="account-card-note">
                Login cannot complete while any required factor channel is unavailable.
              </span>
            )}
            {phase !== 'face' && (
              <span className="account-card-note">
                New here? <Link to="/register-account">Create an account</Link>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function factorMsg(reason: string, message?: string): string {
  switch (reason) {
    case 'unavailable':
      return message ?? 'not configured on the server in this demo.';
    case 'unauthorized':
      return 'authorization failed.';
    case 'expired':
      return 'the code expired — request a new one.';
    case 'cooldown':
      return 'please wait before requesting another code.';
    case 'rate-limited':
      return 'too many attempts — try again later.';
    case 'invalid':
      return 'the code was incorrect.';
    case 'too-many-attempts':
      return 'too many incorrect attempts — request a new code.';
    default:
      return message ?? 'request failed.';
  }
}

function otpMsg(reason: string, _message?: string): string {
  switch (reason) {
    case 'expired':
      return 'this code expired — request a new one.';
    case 'invalid':
      return 'incorrect code.';
    case 'too-many-attempts':
      return 'too many incorrect attempts — request a new code.';
    case 'unavailable':
      return 'not configured on the server in this demo.';
    default:
      return 'verification failed.';
  }
}

function loginMsg(reason: string): string {
  switch (reason) {
    case 'unauthorized':
      return 'Incorrect password or the account does not match this wallet.';
    case 'factor-missing':
      return 'One or more required login factors are incomplete. Complete Google, SMS, and WhatsApp verification, then try again.';
    case 'identity-verification-required':
      return 'Identity verification is still required before you can log in.';
    case 'not-found':
      return 'No PRIESTATE account is registered for this wallet.';
    case 'unavailable':
      return 'Login is unavailable because the login factor providers are not fully configured.';
    case 'rate-limited':
      return 'Too many login attempts. Try again later.';
    default:
      return 'Login failed. Try again.';
  }
}