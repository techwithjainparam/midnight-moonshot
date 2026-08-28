import { useState, useEffect } from 'react';
import { useWallet, describeError, type UseWalletReturn } from './useWallet';
import type { PriestateAPI } from '../priestate-api';
import type { PriestateRegistration } from '../common-types';

export interface PriestateRegistrations {
  connectState: 'connecting' | 'connected' | 'failed';
  connectError: string | null;
  api: PriestateAPI | null;
  /** The REAL on-chain registrations map from the contract ledger. */
  registrations: ReadonlyMap<bigint, PriestateRegistration>;
}

/**
 * Resolve the PRIESTATE contract and subscribe to its public ledger
 * `registrations` state, shared by the registry-facing pages.
 *
 * Status is read from the contract's ledger state (`state$.registrations`)
 * — it is never fabricated. When no contract is reachable the caller sees
 * 'connecting' / 'failed' and must render its own honest empty/error state.
 *
 * Callers that already own a wallet (e.g. from `useAuth`) should pass it in
 * via `wallet` so the same manager/connection is reused rather than opening
 * a second one.
 */
export function usePriestateRegistrations(
  threshold = 1_000_000n,
  wallet?: UseWalletReturn,
): PriestateRegistrations {
  const ownWallet = useWallet();
  const activeWallet = wallet ?? ownWallet;

  const [connectState, setConnectState] = useState<'connecting' | 'connected' | 'failed'>('connecting');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [api, setApi] = useState<PriestateAPI | null>(null);
  const [registrations, setRegistrations] = useState<ReadonlyMap<bigint, PriestateRegistration>>(
    new Map(),
  );

  useEffect(() => {
    if (activeWallet.walletState !== 'connected') {
      setConnectState('connecting');
      return;
    }
    let cancelled = false;
    let depSub: { unsubscribe: () => void } | undefined;
    let stateSub: { unsubscribe: () => void } | undefined;

    const deployment$ = activeWallet.manager.resolve(undefined, threshold);
    depSub = deployment$.subscribe({
      next: (d) => {
        if (cancelled) return;
        if (d.status === 'deployed') {
          setApi(d.api);
          setConnectState('connected');
          setConnectError(null);
          stateSub = d.api.state$.subscribe((s) => {
            if (!cancelled) setRegistrations(s.registrations);
          });
        } else if (d.status === 'failed') {
          setConnectState('failed');
          setConnectError(d.error.message);
        }
      },
      error: (e: unknown) => {
        if (!cancelled) {
          setConnectState('failed');
          setConnectError(describeError(e));
        }
      },
    });

    return () => {
      cancelled = true;
      depSub?.unsubscribe();
      stateSub?.unsubscribe();
    };
  }, [activeWallet, activeWallet.walletState, threshold]);

  return { connectState, connectError, api, registrations };
}
