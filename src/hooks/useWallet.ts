import { useState, useEffect, useCallback, useRef } from 'react';
import type { InitialAPI, ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { combineLatest, type Observable, type Subscription } from 'rxjs';
import pino from 'pino';
import { BrowserPriestateManager, type PriestateDeployment } from '../browser-manager';
import { describeConnectionError, getFirstCompatibleWallet, getWalletAvailability, isAPIError } from '../dapp-wallet';

const VALID_NETWORK_IDS = ['undeployed', 'preview', 'preprod'] as const;
type ValidNetworkId = (typeof VALID_NETWORK_IDS)[number];

function validatedNetworkId(): ValidNetworkId {
  const raw = import.meta.env.VITE_NETWORK_ID ?? 'preprod';
  if ((VALID_NETWORK_IDS as readonly string[]).includes(raw)) return raw as ValidNetworkId;
  return 'preprod';
}

export const NETWORK_ID = validatedNetworkId();

export type WalletState = 'detecting' | 'no-wallet' | 'incompatible' | 'ready' | 'connecting' | 'connected';

function friendlyError(e: unknown): string {
  const raw = extractSafeErrorMessage(e);
  for (const { match, safe } of ERROR_PATTERNS) {
    if (match(raw)) return safe;
  }
  return 'An unexpected error occurred. Please try again.';
}

function extractSafeErrorMessage(e: unknown): string {
  if (!e) return '';
  let msg = '';
  if (typeof e === 'object' && e !== null) {
    const err = e as Record<string, unknown>;
    if (typeof err.message === 'string') msg = err.message;
    else if (err.cause && typeof err.cause === 'object') {
      const cause = err.cause as Record<string, unknown>;
      if (typeof cause.message === 'string') msg = cause.message;
      else if (cause.failure && typeof cause.failure === 'object') {
        const failure = cause.failure as Record<string, unknown>;
        if (typeof failure.message === 'string') msg = failure.message;
      }
    }
  }
  if (!msg && typeof e === 'string') msg = e;
  if (!msg) return '';
  msg = msg.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (msg.length > 200) msg = msg.slice(0, 200);
  return msg;
}

const ERROR_PATTERNS: Array<{ match: (msg: string) => boolean; safe: string }> = [
  { match: (m) => m.includes('User rejected'), safe: 'Transaction cancelled.' },
  { match: (m) => m.includes('Failed to fetch') || m.includes('Failed Proof Server'),
    safe: 'Could not reach the proof server. Check your connection and try again.' },
  { match: (m) => m.includes('mismatched verifier keys'),
    safe: 'Contract version mismatch. Try deploying a new PRIESTATE contract.' },
  { match: (m) => m.includes('not authorized'),
    safe: 'Wallet connection was rejected. Try connecting again.' },
  { match: (m) => m.includes('insufficient') || m.includes('DUST'),
    safe: 'Insufficient funds. Request tokens from the Preprod faucet.' },
  { match: (m) => m.includes('Network ID'),
    safe: 'Network configuration error. Make sure your wallet is set to Preprod.' },
  { match: (m) => m.includes('submission') || m.includes('Submission'),
    safe: 'Transaction failed to submit. Please try again.' },
  { match: (m) => m.includes('timed out') || m.includes('timeout'),
    safe: 'The operation timed out. Please try again.' },
  { match: (m) => m.includes('disconnect') || m.includes('Disconnected'),
    safe: 'Wallet connection was lost. Reconnect and try again.' },
];

export function describeError(e: unknown): string {
  if (isAPIError(e)) return describeConnectionError(e);
  return friendlyError(e);
}

export interface UseWalletReturn {
  walletState: WalletState;
  walletAPI: InitialAPI | undefined;
  wallet: ConnectedAPI | null;
  address: string | null;
  error: string | null;
  deployments: PriestateDeployment[];
  manager: BrowserPriestateManager;
  connect: () => Promise<void>;
  disconnect: () => void;
  setError: (err: string | null) => void;
  /** Re-run wallet presence detection after a transient 'no-wallet'/'incompatible' result. */
  redetect: () => void;
}

export function useWallet(): UseWalletReturn {
  const [walletState, setWalletState] = useState<WalletState>('detecting');
  const [walletAPI, setWalletAPI] = useState<InitialAPI | undefined>();
  const [wallet, setWallet] = useState<ConnectedAPI | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deployments, setDeployments] = useState<PriestateDeployment[]>([]);
  const managerRef = useRef<BrowserPriestateManager | null>(null);
  // Guards against opening a second wallet-connect prompt while one is already
  // awaiting approval (duplicate prompts on double-click / re-render races).
  const connectingRef = useRef(false);
  // Incremented to re-run the presence-detection poll (e.g. after the wallet
  // was installed later so the UI was not stuck on 'no-wallet').
  const [detectKey, setDetectKey] = useState(0);

  const getManager = useCallback(() => {
    if (!managerRef.current) {
      const logger = pino({ level: 'warn', browser: { asObject: true } });
      managerRef.current = new BrowserPriestateManager(logger);
    }
    return managerRef.current;
  }, []);

  useEffect(() => {
    const manager = getManager();
    let innerSub: Subscription | undefined;
    const outerSub = (manager.deployments$ as Observable<Array<Observable<PriestateDeployment>>>).subscribe(
      (deploymentObservables) => {
        innerSub?.unsubscribe();
        innerSub = combineLatest(deploymentObservables).subscribe(setDeployments);
      },
    );
    return () => {
      innerSub?.unsubscribe();
      outerSub.unsubscribe();
    };
  }, [getManager]);

  useEffect(() => {
    const found = getFirstCompatibleWallet();
    if (found) {
      setWalletAPI(found);
      setWalletState('ready');
      return;
    }
    let elapsed = 0;
    const t = setInterval(() => {
      elapsed += 100;
      const w = getFirstCompatibleWallet();
      if (w) {
        setWalletAPI(w);
        setWalletState('ready');
        clearInterval(t);
      } else if (elapsed >= 5_000) {
        setWalletState(getWalletAvailability() === 'incompatible' ? 'incompatible' : 'no-wallet');
        clearInterval(t);
      }
    }, 100);
    return () => clearInterval(t);
  }, [detectKey]);

  // Re-run presence detection (recovers from a transient 'no-wallet' /
  // 'incompatible' result without a full reload).
  const redetect = useCallback(() => {
    setError(null);
    setWalletState('detecting');
    setDetectKey((k) => k + 1);
  }, []);

  const connect = useCallback(async () => {
    if (!walletAPI) return;
    // Never open a second connect prompt while one is already in flight.
    if (connectingRef.current) return;
    if (walletState !== 'ready') return;
    connectingRef.current = true;
    setWalletState('connecting');
    setError(null);
    try {
      const c = await walletAPI.connect(NETWORK_ID);
      setWallet(c);
      getManager().setConnectedAPI(c);
      const { unshieldedAddress } = await c.getUnshieldedAddress();
      setAddress(unshieldedAddress);
      setWalletState('connected');
    } catch (e: unknown) {
      setError(describeError(e));
      setWalletState('ready');
    } finally {
      connectingRef.current = false;
    }
  }, [walletAPI, getManager, walletState]);

  const disconnect = useCallback(() => {
    const manager = managerRef.current;
    manager?.disconnect();
    connectingRef.current = false;
    setWallet(null);
    setAddress(null);
    setWalletState('ready');
    setError(null);
    setDeployments([]);
  }, []);

  return {
    walletState,
    walletAPI,
    wallet,
    address,
    error,
    deployments,
    manager: getManager(),
    connect,
    disconnect,
    setError,
    redetect,
  };
}
