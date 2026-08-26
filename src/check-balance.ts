/**
 * Check the PRIESTATE deployer wallet balance (tNIGHT + DUST) on the active
 * network. Useful before/after `npm run setup` to verify faucet funding.
 */
import { WebSocket } from 'ws';

// Midnight SDK imports
import { resolveNetwork, getOrCreateWallet, formatWalletBackupNotice } from './network';
import {
  createWallet,
  persistWalletState,
  unshieldedToken,
  waitForSyncedStateWithProgress,
  type ChildSyncProgress,
  type SyncProgressReport,
  type WalletContext,
} from './wallet';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

// ─── Network configuration ─────────────────────────────────────────────────────

const { network, config: networkConfig } = resolveNetwork();
const WALLET = getOrCreateWallet(network);
const SEED = WALLET.seed;
{
  const notice = formatWalletBackupNotice(WALLET, network);
  if (notice) console.log(notice);
}

// ─── Sync timeout ──────────────────────────────────────────────────────────────

const DEFAULT_SYNC_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class SyncTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Timed out waiting for the wallet to reach a synced state after ${Math.round(timeoutMs / 1000)}s.`,
    );
    this.name = 'SyncTimeoutError';
  }
}

function resolveSyncTimeoutMs(): number {
  const raw = process.env.WALLET_SYNC_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_SYNC_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid WALLET_SYNC_TIMEOUT_MS "${raw}" — must be a positive number of milliseconds.`);
  }
  return parsed;
}

async function withSyncTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new SyncTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                   Wallet Balance Checker                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  let walletCtx: WalletContext | undefined;
  try {
    console.log('  Building wallet...');
    walletCtx = await createWallet({ network, networkConfig, seed: SEED });
    const restoredCount = Object.values(walletCtx.restored).filter(Boolean).length;
    if (restoredCount > 0) {
      console.log(`  Restored ${restoredCount}/3 child wallets from .midnight-wallet-state — sync will resume from saved point.`);
    }

    console.log('  Syncing with network...');
    console.log('  ℹ  This may take several minutes depending on network size.');
    console.log('     Progress is reported below; RPC disconnection messages during');
    console.log('     sync are normal and can be safely ignored.');
    console.log('     State is checkpointed every minute, so an interrupted sync resumes');
    console.log('     from the checkpoint on the next run instead of restarting.\n');

    function fmtIndex(n: bigint): string {
      return n.toLocaleString('en-US');
    }

    function formatChild(name: string, c: ChildSyncProgress): string {
      const pct =
        c.highestRelevant > 0n
          ? Math.min(100, Math.round(Number((c.appliedIndex * 100n) / c.highestRelevant)))
          : 0;
      const status = c.isConnected ? 'connected' : 'connecting';
      return `  ${name.padEnd(11)} ${fmtIndex(c.appliedIndex).padStart(13)} / ${fmtIndex(
        c.highestRelevant,
      ).padStart(13)}  (${String(pct).padStart(3)}%)  ${status}`;
    }

    const state = await withSyncTimeout(
      waitForSyncedStateWithProgress(network, walletCtx, {
        onReport: (r: SyncProgressReport) => {
          const elapsed = Math.round(r.elapsedMs / 1000);
          process.stdout.write(`\r\x1b[K  ⏳ Syncing... ${elapsed}s elapsed\n`);
          process.stdout.write(`${formatChild('shielded', r.shielded)}\n`);
          process.stdout.write(`${formatChild('dust', r.dust)}\n`);
          process.stdout.write(`${formatChild('unshielded', r.unshielded)}\n`);
          if (r.stalled) {
            process.stdout.write('  ⚠ A connected child has not advanced since the last report. If this\n');
            process.stdout.write('    persists across several reports, sync may be stuck (a known preprod\n');
            process.stdout.write('    issue: some historical dust events fail to decode). Ctrl-C to stop;\n');
            process.stdout.write('    progress is checkpointed and resumes next run.\n');
          }
          process.stdout.write('\x1b[4A');
        },
      }),
      resolveSyncTimeoutMs(),
      () => {
        process.stdout.write('\n');
      },
    );
    process.stdout.write('\r\x1b[K  ✓ Synced with network.                                      \n');

    const address = walletCtx.unshieldedKeystore.getBech32Address();
    const tNightBalance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    const dustBalance = state.dust.balance(new Date());

    console.log('\n─── Wallet Details ─────────────────────────────────────────────\n');
    console.log(`  Address: ${address}`);
    console.log(`  Network: ${networkConfig.networkId}\n`);

    console.log('─── Balances ───────────────────────────────────────────────────\n');
    console.log(`  tNight: ${tNightBalance.toLocaleString()}`);
    console.log(`  DUST:   ${dustBalance.toLocaleString()}\n`);

    if (tNightBalance === 0n) {
      if (network === 'undeployed') {
        console.log('  ⚠ Wallet has no tNight. Make sure the local devnet is running');
        console.log('     (npm run setup) — the genesis seed is pre-funded by the dev preset.\n');
      } else if (networkConfig.faucet) {
        console.log(`  ⚠ Wallet has no tNight. Fund it from the faucet:`);
        console.log(`     ${networkConfig.faucet}`);
        console.log(`     Wallet address: ${address}\n`);
      } else {
        console.log('  ⚠ Wallet has no tNight.\n');
      }
    } else {
      console.log('  ✅ Wallet is funded and ready!\n');
    }

    await persistWalletState(network, walletCtx);
    await walletCtx.wallet.stop();
  } catch (error) {
    if (error instanceof SyncTimeoutError) {
      console.error(`\n❌ ${error.message}`);
      if (walletCtx) await persistWalletState(network, walletCtx);
      console.error('   Progress was checkpointed to .midnight-wallet-state — the next run');
      console.error('   resumes from the checkpoint instead of replaying the ledger from the');
      console.error('   beginning. To reach a fully synced state in one go, set');
      console.error('   WALLET_SYNC_TIMEOUT_MS to a larger value (e.g. 3600000) and re-run.\n');
      process.exit(1);
    }
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
    if (walletCtx) await persistWalletState(network, walletCtx).catch(() => undefined);
    process.exit(1);
  }
}

main();
