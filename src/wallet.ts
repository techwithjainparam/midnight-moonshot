// Wallet construction + sync-state restore.
//
// CLI wallet helper for PRIESTATE deploy/check-balance scripts.
// The on-disk format and pure I/O live in wallet-state.ts (unit-tested
// from the scaffolder workspace, no SDK deps); this file is the glue
// between that format and the wallet SDK.

import { Buffer } from 'buffer';

// Ledger types now come from the midnight-js-protocol barrel, which re-exports
// ledger-v8 (8.1.0) under a stable subpath instead of depending on it directly.
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
// As of Midnight.js 4.1.x / ledger-v8 8.1.0 the wallet SDK is consolidated behind
// the single @midnight-ntwrk/wallet-sdk barrel, which re-exports the former
// wallet-sdk-facade / -hd / -shielded / -dust-wallet / -unshielded-wallet packages.
import {
  WalletFacade,
  DustWallet,
  HDWallet,
  Roles,
  ShieldedWallet,
  createKeystore,
  NoOpTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk';
import * as Rx from 'rxjs';

import type { NetworkConfig, NetworkId } from './network';
import {
  CHILD_KINDS,
  loadWalletState,
  saveWalletState,
  type ChildKind,
  type PersistedWalletState,
} from './wallet-state';

export { unshieldedToken };
export type { PersistedWalletState };
export {
  loadWalletState,
  saveWalletState,
  clearWalletState,
  WALLET_STATE_DIR,
  WALLET_STATE_VERSION,
} from './wallet-state';

function deriveKeys(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hdWallet.hdWallet.clear();
  return result.keys;
}

export interface WalletContext {
  wallet: Awaited<ReturnType<typeof WalletFacade.init>>;
  shieldedSecretKeys: ReturnType<typeof ledger.ZswapSecretKeys.fromSeed>;
  dustSecretKey: ReturnType<typeof ledger.DustSecretKey.fromSeed>;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
  restored: { shielded: boolean; unshielded: boolean; dust: boolean };
}

export interface CreateWalletOptions {
  network: NetworkId;
  networkConfig: NetworkConfig;
  seed: string;
  /**
   * Whether to attempt to restore each child wallet from saved state.
   * Defaults to true. Pass false to force a from-seed sync (used by tests).
   */
  restore?: boolean;
  cwd?: string;
}

function warnRestoreFailure(kind: ChildKind, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`  ⚠ Could not restore ${kind} wallet state (${msg}); falling back to fresh sync.\n`);
}

/**
 * Build the wallet facade, restoring each child from saved state when
 * available and falling back to a from-seed start when not (or when restore
 * throws, e.g. after an SDK upgrade with an incompatible state format).
 *
 * Caller is responsible for `await wallet.waitForSyncedState()` afterwards.
 */
export async function createWallet(opts: CreateWalletOptions): Promise<WalletContext> {
  setNetworkId(opts.networkConfig.networkId);

  const keys = deriveKeys(opts.seed);
  const networkId = getNetworkId();
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

  const saved: PersistedWalletState = opts.restore === false
    ? {}
    : loadWalletState(opts.network, { cwd: opts.cwd });

  const restored = { shielded: false, unshielded: false, dust: false };

  const walletConfig = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: opts.networkConfig.indexer,
      indexerWsUrl: opts.networkConfig.indexerWS,
    },
    provingServerUrl: new URL(opts.networkConfig.proofServer),
    relayURL: new URL(opts.networkConfig.node.replace(/^http/, 'ws')),
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };

  const wallet = await WalletFacade.init({
    configuration: walletConfig,
    shielded: async (config) => {
      const cls = ShieldedWallet(config);
      if (saved.shielded !== undefined) {
        try {
          const restoredWallet = await (cls as any).restore(saved.shielded);
          restored.shielded = true;
          return restoredWallet;
        } catch (err) {
          warnRestoreFailure('shielded', err);
        }
      }
      return cls.startWithSecretKeys(shieldedSecretKeys);
    },
    unshielded: async (config) => {
      const cls = UnshieldedWallet(config);
      if (saved.unshielded !== undefined) {
        try {
          const restoredWallet = await (cls as any).restore(saved.unshielded);
          restored.unshielded = true;
          return restoredWallet;
        } catch (err) {
          warnRestoreFailure('unshielded', err);
        }
      }
      return cls.startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));
    },
    dust: async (config) => {
      const cls = DustWallet(config);
      if (saved.dust !== undefined) {
        try {
          const restoredWallet = await (cls as any).restore(saved.dust);
          restored.dust = true;
          return restoredWallet;
        } catch (err) {
          warnRestoreFailure('dust', err);
        }
      }
      return cls.startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);
    },
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, restored };
}

/**
 * Serialize each child wallet's current state and persist it for the next run.
 * Safe to call multiple times. Logs but does not throw on individual failures —
 * losing one child's state means the next run re-syncs that child only.
 */
export async function persistWalletState(
  network: NetworkId,
  ctx: WalletContext,
  cwd?: string,
): Promise<void> {
  const next: PersistedWalletState = {};

  for (const kind of CHILD_KINDS) {
    try {
      const child = (ctx.wallet as unknown as Record<ChildKind, { serializeState: () => Promise<unknown> }>)[kind];
      const serialized = await child.serializeState();
      if (kind === 'dust') {
        next.dust = serialized as string;
      } else {
        next[kind] = serialized;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  ⚠ Could not serialize ${kind} wallet state (${msg}); next run will re-sync.\n`);
    }
  }

  saveWalletState(network, next, { cwd });
}

// ─── Sync progress reporting ────────────────────────────────────────────────
//
// Normalizes the per-child progress objects (which have different shapes for
// shielded / unshielded / dust) into a uniform ChildSyncProgress and reports
// aggregated progress to a callback at a fixed interval.

export interface ChildSyncProgress {
  appliedIndex: bigint;
  highestRelevant: bigint;
  isConnected: boolean;
}

export interface SyncProgressReport {
  elapsedMs: number;
  shielded: ChildSyncProgress;
  unshielded: ChildSyncProgress;
  dust: ChildSyncProgress;
  stalled: boolean;
}

interface SyncProgressOptions {
  onReport?: (report: SyncProgressReport) => void;
  /** Interval between progress reports in ms. Default 5000. */
  reportIntervalMs?: number;
}

/** Extract a normalized ChildSyncProgress from a child wallet's progress object. */
function normalizeProgress(childState: any): ChildSyncProgress {
  const p = childState?.progress;
  if (!p) {
    return { appliedIndex: 0n, highestRelevant: 0n, isConnected: false };
  }
  // Shielded and Dust use highestRelevantWalletIndex; Unshielded uses highestTransactionId.
  const highestRelevant = p.highestRelevantWalletIndex ?? p.highestTransactionId ?? 0n;
  const appliedIndex = p.appliedIndex ?? p.appliedId ?? 0n;
  return { appliedIndex, highestRelevant, isConnected: p.isConnected ?? false };
}

/**
 * Wait for the wallet facade to reach a fully synced state while reporting
 * per-child progress at a configurable interval. Resolves with the final
 * FacadeState once all children report complete.
 */
export async function waitForSyncedStateWithProgress(
  _network: NetworkId,
  ctx: WalletContext,
  options: SyncProgressOptions = {},
): Promise<any> {
  const reportIntervalMs = options.reportIntervalMs ?? 5000;
  const startTime = Date.now();
  let lastApplied = { shielded: -1n, unshielded: -1n, dust: -1n };
  let stalledCount = 0;

  return new Promise<any>((resolve, reject) => {
    let reportTimer: ReturnType<typeof setInterval> | undefined;
    let subscription: Rx.Subscription | undefined;

    const cleanup = () => {
      if (reportTimer) clearInterval(reportTimer);
      if (subscription) subscription.unsubscribe();
    };

    reportTimer = setInterval(() => {
      const state = (ctx.wallet as any)._state?.getValue?.();
      if (!state) return;

      const shielded = normalizeProgress(state.shielded);
      const unshielded = normalizeProgress(state.unshielded);
      const dust = normalizeProgress(state.dust);

      // Detect stall: no progress on any child since last report.
      const stalled =
        lastApplied.shielded >= 0n &&
        shielded.appliedIndex === lastApplied.shielded &&
        unshielded.appliedIndex === lastApplied.unshielded &&
        dust.appliedIndex === lastApplied.dust;
      if (stalled) stalledCount++;
      else stalledCount = 0;

      lastApplied = {
        shielded: shielded.appliedIndex,
        unshielded: unshielded.appliedIndex,
        dust: dust.appliedIndex,
      };

      options.onReport?.({
        elapsedMs: Date.now() - startTime,
        shielded,
        unshielded,
        dust,
        stalled: stalledCount >= 2,
      });
    }, reportIntervalMs);

    // Subscribe to wallet state; resolve once isSynced flips to true.
    subscription = (ctx.wallet as any).state().pipe(
      Rx.filter((s: any) => s.isSynced),
      Rx.take(1),
    ).subscribe({
      next: (finalState: any) => {
        cleanup();
        resolve(finalState);
      },
      error: (err: unknown) => {
        cleanup();
        reject(err);
      },
    });
  });
}
