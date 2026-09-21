// PRIESTATE — Route guard for account/identity verification (Level 3).
//
// Behavior (layered ON TOP of the wallet guard — it never replaces it):
// - authorization loading → render NOTHING
// - disconnected → connect gate
// - connected and this wallet has a fully-verified Level 3 account →
//   render children
// - connected but account is missing or not fully verified → redirect to
//   /login/user (which routes on to /register-account or
//   /identity-verification as needed)
//
// Note: the authoritative multi-factor enforcement lives on the verification
// server; this gate is a UX convenience like the other demo guards.

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { getAccount, isAccountFullyVerified } from '../../auth/account-store';
import { ConnectGate } from './RequireWallet';

export default function RequireAccount({ children }: { children: ReactNode }) {
  const { status, address } = useAuth();

  if (status === 'loading') return null;
  if (status === 'disconnected') return <ConnectGate />;
  if (!address || !isAccountFullyVerified(getAccount(address))) {
    return <Navigate to="/login/user" replace />;
  }
  return <>{children}</>;
}
