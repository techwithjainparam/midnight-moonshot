// PRIESTATE — Auth context.
//
// Single source of truth for access control. Wraps the EXISTING wallet
// integration (`useWallet`) — no duplicated wallet logic — and derives:
//
//   status      'disconnected'  no connected wallet → public only (this also
//                               covers the wallet being *detected* or
//                               *connecting*: guards render a live connect
//                               gate with detecting/connecting labels instead
//                               of blanking the page)
//               'connected'     wallet connected → role determined
//
//   role        USER | OFFICER (only meaningful when connected)
//
//   officerAuthorized   true only when the server confirms a valid
//                       `priestate_officer_sid` session cookie. This is
//                       the PRIMARY gate for RequireOfficer; the wallet-based
//                       `isOfficer` remains for the demo fallback.
//
// Route guards and the navbar consume this context so that wallet state
// is evaluated in exactly one place.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useWallet, type UseWalletReturn } from '../hooks/useWallet';
import { determineRole, type Role } from './roles';
import { fetchOfficerMe, logoutOfficer as apiLogoutOfficer, type OfficerCapabilities } from './officer-api';

export type AuthStatus = 'loading' | 'disconnected' | 'connected';

export interface AuthContextValue {
  status: AuthStatus;
  role: Role | null;
  /** Wallet-based demo officer flag (allow-list or explicit demo grant). */
  isOfficer: boolean;
  /** Server-backed: true only when the server confirms a valid officer session cookie. */
  officerAuthorized: boolean;
  /** Server capabilities snapshot (null until fetched). */
  officerCapabilities: OfficerCapabilities | null;
  address: string | null;
  wallet: UseWalletReturn;
  /** Re-check the server officer session (call after officer login/register/logout). */
  refreshOfficerAuth: () => Promise<void>;
  /** Log out the server officer session and clear local state. */
  officerLogout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function toAuthStatus(walletState: UseWalletReturn['walletState']): AuthStatus {
  switch (walletState) {
    case 'connected':
      return 'connected';
    default:
      // 'detecting' | 'connecting' | 'ready' | 'no-wallet' | 'incompatible'
      //
      // 'detecting' and 'connecting' intentionally map to 'disconnected' (NOT
      // 'loading'): the route guards render the connect gate with a live
      // "Detecting wallet… / Connecting…" label while the state is in flux,
      // instead of blanking the page while a wallet prompt is open. No
      // protected content ever renders for these states — guards only let
      // children through when `status === 'connected'`.
      return 'disconnected';
  }
}

/**
 * Try to validate the server-backed officer session cookie on mount. This is
 * a lightweight check that does not block rendering — it fires in the
 * background and updates state once the server responds.
 */
function useServerOfficerAuth() {
  const [officerAuthorized, setOfficerAuthorized] = useState(false);
  const [officerCapabilities, setOfficerCapabilities] = useState<OfficerCapabilities | null>(null);

  const refreshOfficerAuth = useCallback(async () => {
    const result = await fetchOfficerMe();
    setOfficerAuthorized(result.ok);
    if (result.ok) setOfficerCapabilities(result.data.capabilities);
  }, []);

  const officerLogout = useCallback(async () => {
    await apiLogoutOfficer();
    setOfficerAuthorized(false);
  }, []);

  useEffect(() => {
    void refreshOfficerAuth();
  }, [refreshOfficerAuth]);

  return { officerAuthorized, officerCapabilities, refreshOfficerAuth, officerLogout };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const status = toAuthStatus(wallet.walletState);
  const serverOfficer = useServerOfficerAuth();

  const value = useMemo<AuthContextValue>(() => {
    const connected = status === 'connected' && wallet.address !== null;
    const role: Role | null = connected && wallet.address ? determineRole(wallet.address) : null;
    return {
      status,
      role,
      isOfficer: role === 'OFFICER',
      officerAuthorized: serverOfficer.officerAuthorized,
      officerCapabilities: serverOfficer.officerCapabilities,
      address: connected ? wallet.address : null,
      wallet,
      refreshOfficerAuth: serverOfficer.refreshOfficerAuth,
      officerLogout: serverOfficer.officerLogout,
    };
  }, [status, wallet, serverOfficer]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
