// PRIESTATE — Officer login page (server-backed credential).
//
// Exchange display name + password for the server-backed `priestate_officer_sid`
// HttpOnly cookie. No wallet connection is required — this is a separate
// credential from the citizen identity. On success, refreshes the server
// officer auth state and redirects to the Officer Portal.

import { useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { loginOfficer } from '../auth/officer-api';

export default function OfficerLoginPage() {
  const { refreshOfficerAuth } = useAuth();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await loginOfficer(displayName.trim(), password);
      if (result.ok) {
        await refreshOfficerAuth();
        navigate('/officer', { replace: true });
        return;
      }
      setError(loginErrorMessage(result.reason, result.message));
    } finally {
      setBusy(false);
    }
  }, [displayName, password, refreshOfficerAuth, navigate]);

  return (
    <div className="page profile-page">
      <div className="page-header">
        <h1 className="page-title">Officer Sign-In</h1>
        <p className="page-desc">
          Sign in with your officer display name and password to access the
          Officer Portal. This uses a server-backed credential — no wallet
          connection is required.
        </p>
      </div>

      <div className="account-card">
        <div className="account-section">
          <div className="form-field">
            <label className="form-label" htmlFor="officer-display-name">Display name</label>
            <input
              id="officer-display-name"
              type="text"
              className="form-input"
              placeholder="e.g. OfficerSingh"
              autoComplete="username"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="officer-password">Password</label>
            <input
              id="officer-password"
              type="password"
              className="form-input"
              placeholder="Officer password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>

        {error && <div className="status-msg error" role="alert">{error}</div>}

        <div className="account-card-actions">
          <button
            className="btn btn-primary btn-lg"
            onClick={() => void handleLogin()}
            disabled={busy || !displayName.trim() || !password}
          >
            {busy ? 'Signing in…' : 'Officer Sign-In'}
          </button>
          <span className="account-card-note">
            Need an officer account?{' '}
            <Link to="/officer/register">Register officer (one-time setup)</Link>
          </span>
        </div>

        <p className="liveness-privacy" style={{ marginTop: '1rem' }}>
          The server validates your password against a salted scrypt hash. No
          password is ever returned or stored in this browser.
        </p>
      </div>
    </div>
  );
}

function loginErrorMessage(reason: string, message?: string): string {
  switch (reason) {
    case 'unauthorized':
      return 'Invalid officer credentials. Check your display name and password.';
    case 'unavailable':
      return message ?? 'Officer login is not available on this deployment.';
    case 'rate-limited':
      return 'Too many attempts. Try again later.';
    case 'network-error':
      return message ?? 'Could not reach the verification server.';
    default:
      return message ?? 'Officer login failed. Try again.';
  }
}
