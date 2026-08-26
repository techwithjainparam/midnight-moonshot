// PRIESTATE — Route guard for first-time USER contact verification.
//
// Behavior (layered ON TOP of the existing wallet guard — it never
// replaces it):
// - authorization state loading → render NOTHING
// - disconnected → connect gate (existing ConnectGate)
// - connected OFFICER → render children unchanged (officer flow is not
//   gated by contact verification)
// - connected USER without a verified contact profile → redirect to
//   /profile/verify
// - connected USER with verified profile → render children
//
// The wallet remains the authorization identity; this gate only adds the
// one-time contact-profile step for first-time users.

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { hasVerifiedProfile } from '../../profile/contact-verification';
import { ConnectGate } from './RequireWallet';

interface RequireProfileProps {
  children: ReactNode;
}

export default function RequireProfile({ children }: RequireProfileProps) {
  const { status, role, address } = useAuth();

  if (status === 'loading') return null;
  if (status === 'disconnected') return <ConnectGate />;
  if (role === 'OFFICER') return <>{children}</>;
  if (!address || !hasVerifiedProfile(address)) {
    return <Navigate to="/profile/verify" replace />;
  }

  return <>{children}</>;
}
