import { useState, useCallback, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import { useAuth } from '../auth/AuthContext';
import type { AccountCapabilities } from '../auth/account-types';
import {
  loginAccount,
  sendSmsOtp,
  verifySmsOtp,
  sendWhatsappOtp,
  verifyWhatsappOtp,
  completeGoogle,
  fetchAccountCapabilities,
} from '../auth/account-api';
import { getAccount, isAccountFullyVerified } from '../auth/account-store';

// FEATURE 4 — Mandatory multi-factor login (`/login`).
//
// Every factor below is REQUIRED (not a menu of alternatives): a connected
// wallet, the account password, a Google sign-in, an SMS OTP, a WhatsApp OTP,
// AND a completed identity/selfie verification. The UI routes to the identity
// verification step when it is still pending. When a provider is not
// configured on the server the factor is shown as unavailable and login
// cannot complete — no fake auth, no hard-coded credentials.

// Feature 4 — mandatory multi-factor login. See header above.

export default function LoginPage() {
  const { address } = useAuth();
  const navigate = useNavigate();

  const [caps, setCaps] = useState<AccountCapabilities | null>(null);
  const [capsLoaded, setCapsLoaded] = useState(false);
  const [password, setPassword] = useState('');
  const [googleHasAuthed, setGoogleHasAuthed] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [whatsappCode, setWhatsappCode] = useState('');
  const [smsSentAt, setSmsSentAt] = useState<number | null>(null);
  const [whatsappSentAt, setWhatsappSentAt] = useState<number | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [factorError, setFactorError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAccountCapabilities().then((r) => {
      if (cancelled) return;
      setCaps(r.ok ? r.data : { smsConfigured: false, whatsappConfigured: false, googleConfigured: false });
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
          <p className="auth-gate-desc">A connected Midnight wallet is the first factor of PRIESTATE login.</p>
          <Link to="/" className="btn btn-primary btn-lg">Return Home</Link>
        </div>
      </div>
    );
  }

  const local = getAccount(address);
  const allFactorsConfigured = caps ? (caps.smsConfigured && caps.whatsappConfigured && caps.googleConfigured) : false;
  const identityPending = local !== null && !isAccountFullyVerified(local);
  const isNewAccount = local === null;

  const handleSendSms = useCallback(async () => {
    if (!address) return;
    setFactorError(null);
    const r = await sendSmsOtp(address);
    if (r.ok) setSmsSentAt(Date.now());
    else setFactorError(`SMS OTP: ${factorMsg(r.reason, r.message)}`);
  }, [address]);

  const handleVerifySms = useCallback(async () => {
    if (!address) return;
    setFactorError(null);
    const r = await verifySmsOtp(address, smsCode);
    if (r.ok) setSmsSentAt(null);
    else setFactorError(`SMS OTP: ${otpMsg(r.reason, r.message)}`);
  }, [address, smsCode]);

  const handleSendWhatsapp = useCallback(async () => {
    if (!address) return;
    setFactorError(null);
    const r = await sendWhatsappOtp(address);
    if (r.ok) setWhatsappSentAt(Date.now());
    else setFactorError(`WhatsApp OTP: ${factorMsg(r.reason, r.message)}`);
  }, [address]);

  const handleVerifyWhatsapp = useCallback(async () => {
    if (!address) return;
    setFactorError(null);
    const r = await verifyWhatsappOtp(address, whatsappCode);
    if (r.ok) setWhatsappSentAt(null);
    else setFactorError(`WhatsApp OTP: ${otpMsg(r.reason, r.message)}`);
  }, [address, whatsappCode]);

  const handleGoogleComplete = useCallback(async () => {
    if (!address) return;
    setFactorError(null);
    const r = await completeGoogle(address, authCode);
    if (r.ok) setGoogleHasAuthed(true);
    else setFactorError(`Google: ${factorMsg(r.reason, r.message)}`);
  }, [address, authCode]);

  const handleLogin = useCallback(async () => {
    if (!address) return;
    setLoginError(null);
    setBusy(true);
    try {
      if (!capsLoaded || !caps || !allFactorsConfigured) {
        setLoginError('Login requires live SMS, WhatsApp, and Google factors, which are not all configured on the verification server in this demo.');
        return;
      }
      if (isNewAccount) {
        setLoginError('No account is registered for this wallet yet. Please create an account first.');
        return;
      }
      const r = await loginAccount(address, password);
      if (r.ok) {
        navigate('/dashboard', { replace: true });
        return;
      }
      setLoginError(loginMsg(r.reason));
    } finally {
      setBusy(false);
    }
  }, [address, allFactorsConfigured, caps, capsLoaded, isNewAccount, navigate, password]);

  const localStatus = local === null ? 'No account for this wallet' : isAccountFullyVerified(local) ? 'All factors verified — ready to log in' : 'Account registered — identity verification still pending';

  return (
    <div className="page profile-page">
      <ProductBanner />
      <div className="page-header">
        <h1 className="page-title">Log In</h1>
        <p className="page-desc" style={{ maxWidth: 680 }}>
          PRIESTATE requires a <strong>mandatory multi-factor</strong> login:
          your wallet, your password, Google, an SMS OTP, a WhatsApp OTP, and a
          completed identity verification. Every factor below is required — none
          is optional, and none is an alternative to another.
        </p>
      </div>

      <div className="account-card">
        <div className={`account-item status-${isNewAccount ? 'new' : 'existing'}`}>
          <span className="account-item-label">Wallet</span>
          <span className="account-item-value">{address.slice(0, 6)}…{address.slice(-6)}</span>
          <span className="status-pill status-registered">{isNewAccount ? 'NEW' : 'ACCOUNT'}</span>
        </div>
        <p className="account-local-status">
          {isNewAccount
            ? 'This wallet is not yet registered as a PRIESTATE account.'
            : `Stored status on this device: ${localStatus}.`}
        </p>
        {isNewAccount && (
          <div className="status-msg info" role="status">
            No PRIESTATE account is linked to this wallet yet.
            {` `}<Link to="/register-account">Create your account</Link> or connect a different wallet.
          </div>
        )}

        <section className="account-section">
          <h2 className="account-section-title">Password</h2>
          <div className="form-field">
            <input
              type="password"
              autoComplete="current-password"
              className="form-input"
              placeholder="Account password"
              value={password}
              disabled={isNewAccount}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="form-hint">Verified against a salted scrypt hash on the server — never transmitted in plaintext storage.</span>
          </div>
        </section>

        <section className="account-section">
          <h2 className="account-section-title">Google (required)</h2>
          <p className="account-section-desc">
            Sign in with Google via the real OAuth exchange on the server.
          </p>
          <div className="form-field">
            <input
              type="text"
              autoComplete="off"
              className="form-input"
              placeholder="Authorization code from the Google authenticator"
              value={authCode}
              disabled={!capsLoaded || !caps?.googleConfigured}
              onChange={(e) => setAuthCode(e.target.value)}
            />
            <span className="form-hint">
              {!capsLoaded
                ? 'Checking server configuration…'
                : caps?.googleConfigured
                  ? 'Paste the one-time authorization code your authenticator produced.'
                  : 'Google login is not configured on the verification server in this demo.'}
            </span>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => void handleGoogleComplete()}
            disabled={!capsLoaded || !caps?.googleConfigured || googleHasAuthed || !authCode}
          >
            {googleHasAuthed ? '✓ Linked' : 'Link Google'}
          </button>
        </section>

        <section className="account-section">
          <h2 className="account-section-title">SMS OTP (required)</h2>
          {smsSentAt === null ? (
            <button className="btn btn-primary" onClick={() => void handleSendSms()} disabled={!capsLoaded || !caps?.smsConfigured}>
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
            </div>
          )}
        </section>

        <section className="account-section">
          <h2 className="account-section-title">WhatsApp OTP (required)</h2>
          {whatsappSentAt === null ? (
            <button className="btn btn-primary" onClick={() => void handleSendWhatsapp()} disabled={!capsLoaded || !caps?.whatsappConfigured}>
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
            </div>
          )}
        </section>

        <section className="account-section">
          <h2 className="account-section-title">Identity / Selfie Verification (required)</h2>
          <p className="account-section-desc">
            {identityPending
              ? 'Your identity/selfie verification is not complete for this wallet. Complete it to log in.'
              : isNewAccount
                ? 'You must create and verify an account before logging in.'
                : 'Identity/selfie verification is complete for this wallet.'}
          </p>
          {identityPending && (
            <Link to="/identity-verification" className="btn btn-primary">
              Continue identity verification
            </Link>
          )}
        </section>

        {factorError && <div className="status-msg error" role="alert">{factorError}</div>}
        {loginError && <div className="status-msg error" role="alert">{loginError}</div>}

        <div className="account-card-actions">
          <button
            className="btn btn-primary btn-lg"
            onClick={() => void handleLogin()}
            disabled={busy || isNewAccount}
          >
            {busy ? 'Logging in…' : 'Log in'}
          </button>
          <span className="account-card-note">
            New here? <Link to="/register-account">Create an account</Link>
          </span>
        </div>
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
    default:
      return 'Login failed. Try again.';
  }
}
