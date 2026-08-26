// PRIESTATE — Auth context.
//
// Single source of truth for access control. Wraps the EXISTING wallet
// integration (`useWallet`) — no duplicated wallet logic — and derives:
//
//   status      'loading'       wallet state not yet known / connection
//                               in progress → render NO protected content
//               'disconnected'  no connected wallet → public only
//               'connected'     wallet connected → role determined
//
//   role        USER | OFFICER (only meaningful when connected)
//
// Route guards and the navbar consume this context so that wallet state
// is evaluated in exactly one place.

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useWallet, type UseWalletReturn } from '../hooks/useWallet';
import { determineRole, type Role } from './roles';

export type AuthStatus = 'loading' | 'disconnected' | 'connected';

export interface AuthContextValue {
  status: AuthStatus;
  role: Role | null;
  isOfficer: boolean;
  address: string | null;
  wallet: UseWalletReturn;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function toAuthStatus(walletState: UseWalletReturn['walletState']): AuthStatus {
  switch (walletState) {
    case 'detecting':
    case 'connecting':
      // Authorization state unknown or unconfirmed — never render
      // protected content during this window.
      return 'loading';
    case 'connected':
      return 'connected';
    default:
      // 'ready' | 'no-wallet' | 'incompatible'
      return 'disconnected';
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const status = toAuthStatus(wallet.walletState);

  const value = useMemo<AuthContextValue>(() => {
    const connected = status === 'connected' && wallet.address !== null;
    const role: Role | null = connected && wallet.address ? determineRole(wallet.address) : null;
    return {
      status,
      role,
      isOfficer: role === 'OFFICER',
      address: connected ? wallet.address : null,
      wallet,
    };
  }, [status, wallet]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
