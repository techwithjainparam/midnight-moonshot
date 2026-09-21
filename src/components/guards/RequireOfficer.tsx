// PRIESTATE — Route guard for the Officer Portal.
//
// Authorization hierarchy:
//   1. Server-backed officer credential (`priestate_officer_sid` HttpOnly
//      cookie, validated by the server) — PRIMARY gate, checked first.
//   2. Wallet-based demo officer grant (allow-list or session-scoped
//      simulation) — DEMO FALLBACK, clearly labelled.
//
// If neither holds, the user sees an honest "Officer access required" page
// with both options explained. No real officer data is ever exposed before
// authorization is confirmed.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { grantDemoOfficer, revokeDemoOfficer, hasDemoOfficerGrant } from '../../auth/roles';
import { ConnectGate } from './RequireWallet';
import { Link } from 'react-router-dom';

function UnauthorizedOfficer() {
  const { wallet, officerAuthorized } = useAuth();
  const [simulated, setSimulated] = useState(hasDemoOfficerGrant);

  return (
    <div className="page auth-gate-page">
      <div className="auth-gate auth-gate-unauthorized">
        <div className="auth-gate-icon auth-gate-icon-error" aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <h1 className="auth-gate-title">Officer access required.</h1>
        <p className="auth-gate-desc">
          No valid server-backed officer credential was found for this
          browser, and no demo officer role is active. No officer data is
          shown.
        </p>

        {!officerAuthorized && (
          <div className="auth-gate-actions">
            <Link to="/officer/login" className="btn btn-primary">
              Officer Sign-In (Server Credential)
            </Link>
            <Link to="/officer/register" className="btn btn-ghost">
              Register Officer (One-Time Setup)
            </Link>
          </div>
        )}

        <div className="auth-gate-demo">
          <p className="auth-gate-demo-label">DEMO FALLBACK — not real authentication</p>
        <p className="auth-gate-demo-text">
          When no server-backed officer credential is available (or the
          server reports registration unavailable), you can exercise the
          Officer Portal UX by simulating the officer role for this browser
          session. This is labelled and easy to revoke. This is not a
          government identity system. Real government authentication does not exist yet — the
          server-backed credential is an application credential only.
        </p>
          {simulated ? (
            <button
              className="btn btn-ghost"
              onClick={() => { revokeDemoOfficer(); setSimulated(false); }}
            >
              Revoke Demo Officer Role
            </button>
          ) : (
            <button
              className="btn btn-ghost"
              onClick={() => { grantDemoOfficer(); setSimulated(true); }}
            >
              Simulate Officer Sign-In (DEMO)
            </button>
          )}
        </div>

        {wallet.error && (
          <div className="status-msg error auth-gate-error" role="alert">{wallet.error}</div>
        )}
      </div>
    </div>
  );
}

interface RequireOfficerProps {
  children: ReactNode;
}

export default function RequireOfficer({ children }: RequireOfficerProps) {
  const { status, isOfficer, officerAuthorized } = useAuth();

  if (status === 'loading') return null;
  if (status === 'disconnected') return <ConnectGate />;

  // PRIMARY: server-backed officer credential (checked first).
  if (officerAuthorized) return <>{children}</>;

  // DEMO FALLBACK: wallet-based demo officer grant (clearly labelled).
  if (isOfficer) return <>{children}</>;

  return <UnauthorizedOfficer />;
}
