// PRIESTATE — Officer registration page (one-time commissioning).
//
// Mints the SINGLE server-backed officer account for a deployment, gated by a
// one-time commissioning code. After success, the officer is immediately logged
// in (server sets the `priestate_officer_sid` HttpOnly cookie) and redirected
// to the Officer Portal. No wallet connection is required.

import { useState, useCallback, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { registerOfficer, fetchOfficerCapabilities, type OfficerCapabilities } from '../auth/officer-api';

export default function OfficerRegistrationPage() {
  const { refreshOfficerAuth } = useAuth();
  const navigate = useNavigate();

  const [caps, setCaps] = useState<OfficerCapabilities | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [registrationCode, setRegistrationCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchOfficerCapabilities().then((r) => {
      if (cancelled) return;
      if (r.ok) setCaps(r.data.capabilities);
    });
    return () => { cancelled = true; };
  }, []);

  const handleRegister = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await registerOfficer({
        displayName: displayName.trim(),
        password,
        passwordConfirm,
        registrationCode,
      });
      if (result.ok) {
        await refreshOfficerAuth();
        navigate('/officer', { replace: true });
        return;
      }
      setError(registerErrorMessage(result.reason, result.message));
    } finally {
      setBusy(false);
    }
  }, [displayName, password, passwordConfirm, registrationCode, refreshOfficerAuth, navigate]);

  const registrationDisabled = caps !== null && !caps.registrationAvailable;
  const canSubmit = displayName.trim() && password && passwordConfirm && registrationCode && !busy && !registrationDisabled;

  return (
    <div className="page profile-page">
      <div className="page-header">
        <h1 className="page-title">Register Officer (One-Time Setup)</h1>
        <p className="page-desc">
          Mint the single commissioned officer account for this deployment.
          Registration requires a one-time commissioning code configured on the
          server. After the first officer is registered, further registrations are
          refused — officer registration is a single, one-time step.
        </p>
      </div>

      <div className="account-card">
        {registrationDisabled && (
          <div className="status-msg error" role="alert">
            Officer registration is not enabled on this deployment. No
            commissioning code is configured on the server. This is not
            simulated — it is genuinely unavailable.
          </div>
        )}

        <div className="account-section">
          <div className="form-field">
            <label className="form-label" htmlFor="officer-reg-name">Display name</label>
            <input
              id="officer-reg-name"
              type="text"
              className="form-input"
              placeholder="e.g. OfficerSingh"
              autoComplete="username"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <span className="form-hint">2–80 characters: letters, spaces, periods, apostrophes, hyphens.</span>
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="officer-reg-password">Password</label>
            <input
              id="officer-reg-password"
              type="password"
              className="form-input"
              placeholder="At least 10 characters"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="form-hint">At least 10 characters with uppercase, lowercase, a number, and a symbol.</span>
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="officer-reg-password-confirm">Confirm password</label>
            <input
              id="officer-reg-password-confirm"
              type="password"
              className="form-input"
              placeholder="Re-enter password"
              autoComplete="new-password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="officer-reg-code">Commissioning code</label>
            <input
              id="officer-reg-code"
              type="password"
              className="form-input"
              placeholder="One-time commissioning code"
              autoComplete="off"
              value={registrationCode}
              onChange={(e) => setRegistrationCode(e.target.value)}
            />
            <span className="form-hint">
              One-time code set in <code>OFFICER_REGISTRATION_CODE</code> on the server.
              Not stored or logged by this browser.
            </span>
          </div>
        </div>

        {error && <div className="status-msg error" role="alert">{error}</div>}

        <div className="account-card-actions">
          <button
            className="btn btn-primary btn-lg"
            onClick={() => void handleRegister()}
            disabled={!canSubmit}
          >
            {busy ? 'Registering…' : 'Register Officer'}
          </button>
          <span className="account-card-note">
            Already registered? <Link to="/officer/login">Officer sign-in</Link>
          </span>
        </div>

        <p className="liveness-privacy" style={{ marginTop: '1rem' }}>
          The password is hashed with salted scrypt on the server and is never
          recoverable. The commissioning code is validated then discarded from
          the request — it is never logged or stored in this browser.
        </p>
      </div>
    </div>
  );
}

function registerErrorMessage(reason: string, message?: string): string {
  switch (reason) {
    case 'registration-disabled':
      return message ?? 'Officer registration is not enabled on this deployment (no commissioning code is configured). It was not simulated.';
    case 'code-invalid':
      return 'The commissioning code is incorrect. Check the server-side OFFICER_REGISTRATION_CODE.';
    case 'officer-exists':
      return message ?? 'An officer account already exists. Officer registration is a single, one-time commissioning step.';
    case 'invalid-input':
      return message ?? 'Invalid officer details. Display name 2–80 characters, password at least 10 characters with upper/lowercase, a number and a symbol.';
    case 'unavailable':
      return message ?? 'Officer registration is not available on this deployment.';
    case 'rate-limited':
      return 'Too many attempts. Try again later.';
    case 'network-error':
      return message ?? 'Could not reach the verification server.';
    default:
      return message ?? 'Registration failed. Try again.';
  }
}
