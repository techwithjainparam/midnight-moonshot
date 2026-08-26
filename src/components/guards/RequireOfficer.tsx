// PRIESTATE — Route guard for the Officer Portal.
//
// Behavior:
// - authorization state loading → render NOTHING (no officer data is
//   exposed before authorization is confirmed)
// - disconnected → connect gate (same as protected user routes)
// - connected as USER → "Unauthorized — Officer access required."
// - connected as OFFICER (demo authorization) → render children
//
// Officer role determination is centralized in src/auth/roles.ts and is
// a DEMO mechanism, not production government authentication.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { grantDemoOfficer, revokeDemoOfficer, hasDemoOfficerGrant } from '../../auth/roles';
import { ConnectGate } from './RequireWallet';

function UnauthorizedOfficer() {
  const { wallet } = useAuth();
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
        <h1 className="auth-gate-title">Unauthorized — Officer access required.</h1>
        <p className="auth-gate-desc">
          Your connected wallet does not have authorized officer credentials.
          No officer data is shown.
        </p>

        <div className="auth-gate-demo">
          <p className="auth-gate-demo-label">DEMO SIMULATION — not real authentication</p>
          <p className="auth-gate-demo-text">
            Real government authentication does not exist yet. To exercise the
            Officer Portal UX you can simulate officer authorization for this
            browser session, or set <code>VITE_DEMO_OFFICER_ADDRESSES</code> to
            your wallet address at build time.
          </p>
          {simulated ? (
            <button
              className="btn btn-ghost"
              onClick={() => {
                revokeDemoOfficer();
                setSimulated(false);
              }}
            >
              Revoke Demo Officer Role
            </button>
          ) : (
            <button
              className="btn btn-ghost"
              onClick={() => {
                grantDemoOfficer();
                setSimulated(true);
              }}
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
  const { status, isOfficer } = useAuth();

  if (status === 'loading') return null;
  if (status === 'disconnected') return <ConnectGate />;
  if (!isOfficer) return <UnauthorizedOfficer />;

  return <>{children}</>;
}
