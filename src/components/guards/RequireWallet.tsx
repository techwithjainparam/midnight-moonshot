// PRIESTATE — Route guard for wallet-protected routes.
//
// Behavior:
// - authorization state loading → render NOTHING (no protected content
//   flashes while wallet state is unknown)
// - disconnected → render the connect gate:
//       "Connect your wallet to access PRIESTATE."
// - connected → render children
//
// Uses the shared AuthContext (single instance of the existing
// useWallet integration) — no duplicated wallet logic.

import type { ReactNode } from 'react';
import { useAuth } from '../../auth/AuthContext';

export function ConnectGate() {
  const { wallet } = useAuth();
  return (
    <div className="page auth-gate-page">
      <div className="auth-gate">
        <div className="auth-gate-icon" aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <h1 className="auth-gate-title">Connect your wallet to access PRIESTATE.</h1>
        <p className="auth-gate-desc">
          This area is protected. A connected Midnight wallet is required.
        </p>
        {wallet.walletState === 'no-wallet' || wallet.walletState === 'incompatible' ? (
          <>
            <p className="auth-gate-note">
              {wallet.walletState === 'incompatible'
                ? 'A Midnight wallet was found, but its version is incompatible.'
                : 'No compatible Midnight wallet was detected in this browser.'}
            </p>
            <div className="account-card-actions">
              <button className="btn btn-ghost" onClick={wallet.redetect}>
                Re-check for wallet
              </button>
            </div>
          </>
        ) : (
          <button
            className="btn btn-primary btn-lg"
            onClick={wallet.connect}
            disabled={wallet.walletState !== 'ready'}
          >
            {wallet.walletState === 'ready'
              ? 'Connect Wallet'
              : wallet.walletState === 'connecting'
                ? 'Connecting…'
                : 'Detecting wallet…'}
          </button>
        )}
        {wallet.error && (
          <div className="status-msg error auth-gate-error" role="alert">{wallet.error}</div>
        )}
      </div>
    </div>
  );
}

interface RequireWalletProps {
  children: ReactNode;
}

export default function RequireWallet({ children }: RequireWalletProps) {
  const { status } = useAuth();

  if (status === 'loading') return null;
  if (status === 'disconnected') return <ConnectGate />;

  return <>{children}</>;
}
