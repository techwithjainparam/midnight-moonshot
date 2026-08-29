/**
 * Deploy the PRIESTATE contract to a Midnight network (undeployed by default;
 * use --network preview|preprod for public networks).
 *
 * Non-interactive: scaffold → npm run setup runs straight through.
 * No readline prompts, no .midnight-seed file.
 *
 * PRIESTATE specifics vs the hello-world reference:
 *  - The constructor takes an `eligibilityThreshold: Uint<64>` argument —
 *    supplied via --threshold <n> or the PRIESTATE_THRESHOLD env var
 *    (defaults to 100000, matching the frontend's VITE_DEFAULT_THRESHOLD).
 *  - The `checkEligibility` circuit consumes the private `propertyValue`
 *    witness; the deployed contract is built with the real witnesses from
 *    src/contract/index.ts. PRIESTATE has no private state, so
 *    initialPrivateState is {}.
 *  - On public networks (preview, preprod) a strong PRIVATE_STATE_PASSWORD
 *    (>= 16 chars) is required to encrypt the local private-state level-db.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

// Midnight SDK imports
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';

import { resolveNetwork, getOrCreateWallet, formatWalletBackupNotice, recordDeployment } from './network';
import { createWallet, persistWalletState, unshieldedToken, waitForSyncedStateWithProgress, type WalletContext } from './wallet';
import { CompiledPriestateContract, createPriestatePrivateState } from './contract/index.js';
import { retryWithBackoff, DEFAULT_DUST_RETRY_ATTEMPTS } from './dust-registration';
import { readLatestWalletState, readTNightBalance } from './faucet-funding';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

// Identifier under which this contract's private state is stored. PRIESTATE
// has no private state, so it is empty ({}). Matches priestatePrivateStateKey
// in src/common-types.ts used by the browser path.
const PRIVATE_STATE_ID = 'priestatePrivateState';

// ─── Eligibility threshold (constructor arg) ───────────────────────────────────

function parseThreshold(argv: string[]): bigint {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--threshold') {
      const v = argv[i + 1];
      if (v === undefined) throw new Error('--threshold requires a value');
      return BigInt(v);
    }
    if (arg.startsWith('--threshold=')) {
      return BigInt(arg.slice('--threshold='.length));
    }
  }
  const env = process.env.PRIESTATE_THRESHOLD;
  if (env && env.trim() !== '') return BigInt(env.trim());
  return 100000n;
}

const THRESHOLD = parseThreshold(process.argv);

// ─── Designated officer (constructor arg) ──────────────────────────────────────
//
// The deployer-designated officer DApp public key is a 32-byte value (the
// domain-separated public key of the officer secret, as derived by the
// contract's `deriveDappKey` circuit). Supply it as 64 hex chars via
// `--officer <hex>` or the PRIESTATE_OFFICER env var.
//
// NOTE: The 32-byte all-zero placeholder is deliberately NOT a useable officer
// key — no secret derives to it — so officer operations stay de-authorized
// unless a real officer public key is configured before a real deployment.

const ZERO_OFFICER = new Uint8Array(32);

function parseOfficer(argv: string[]): Uint8Array {
  let raw: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--officer') {
      raw = argv[i + 1];
      break;
    }
    if (arg.startsWith('--officer=')) {
      raw = arg.slice('--officer='.length);
      break;
    }
  }
  if (raw === undefined) raw = process.env.PRIESTATE_OFFICER?.trim() || undefined;
  if (raw === undefined || raw === '') {
    console.warn('\n  ⚠  No designated officer public key supplied (--officer or PRIESTATE_OFFICER).');
    console.warn('     The officer role will be unusable after deploy unless a real key is set.\n');
    return ZERO_OFFICER;
  }
  const hex = raw.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Invalid --officer "${raw}" — expected exactly 64 hex chars (32-byte DApp public key).`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const OFFICER = parseOfficer(process.argv);

// ─── Network configuration ─────────────────────────────────────────────────────
//
// Resolved from --network flag, .midnight-state.json, or defaulting to
// 'undeployed' (local devnet). Switch networks with: npm run network <name>

const { network, config: networkConfig } = resolveNetwork();
const WALLET = getOrCreateWallet(network);
const SEED = WALLET.seed;
{
  const notice = formatWalletBackupNotice(WALLET, network);
  if (notice) console.log(notice);
}

// ─── Proof server readiness ────────────────────────────────────────────────────
//
// The proof-server image is distroless and has no shell, so it can't run a
// container-side healthcheck. Poll it from the host before we submit anything
// that needs proofs.

async function waitForProofServer(maxAttempts = 60, delayMs = 2000): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fetch(networkConfig.proofServer, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      return true;
    } catch (err: any) {
      const code = err?.cause?.code || err?.code || '';
      if (code !== 'ECONNREFUSED' && code !== 'UND_ERR_CONNECT_TIMEOUT' && code !== 'UND_ERR_SOCKET') {
        return true;
      }
    }
    if (attempt < maxAttempts) {
      process.stdout.write(`\r  Waiting for proof server... (${attempt}/${maxAttempts})   `);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

// ─── Bounded waits for the DUST setup ─────────────────────────────────────────
//
// The DUST block below contains two unbounded waits that can hang the deploy
// right after a successful sync:
//
//   1. Re-reading the facade state gated on FacadeState.isSynced. That getter
//      requires STRICT completion (applyLag === 0, connected) of all three
//      children at the same emission (wallet-sdk-facade). The sync step above
//      already tolerated a bounded gap per child (waitForSyncedState(50)); if a
//      child keeps a small permanent gap (the known public-network dust-decode
//      issue discussed in wallet.ts) or drops its RPC/WS connection, isSynced
//      stays false forever and firstValueFrom never resolves.
//
//   2. Awaiting dust.balance(new Date()) > 0n. The DUST balance is a wall-clock
//      projection computed only when the wallet state observable emits, and
//      wallet.state() has no periodic tick — durable emissions stop on a quiet
//      wallet — so the filter can never pass. The SDK's own
//      DustWallet.waitForGeneratedDust solves this with a 1s timer tick.
//
// Every wait on this path gets a bounded budget (DUST_SETUP_TIMEOUT_MS, default
// 10 minutes); on expiry we report a clear diagnostic instead of hanging
// forever. We never fabricate a DUST balance and never bypass the DUST
// requirement — we only make the failure loud and actionable.

const DEFAULT_DUST_SETUP_TIMEOUT_MS = 10 * 60 * 1000;

function resolveDustSetupTimeoutMs(): number {
  const raw = process.env.DUST_SETUP_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_DUST_SETUP_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid DUST_SETUP_TIMEOUT_MS "${raw}" — must be a positive number of milliseconds.`,
    );
  }
  return parsed;
}

class DustSetupTimeoutError extends Error {
  constructor(timeoutMs: number, detail: string) {
    super(`Timed out during DUST setup after ${Math.round(timeoutMs / 1000)}s.\n  ${detail}`);
    this.name = 'DustSetupTimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, detail: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DustSetupTimeoutError(timeoutMs, detail)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function formatChildProgress(label: string, progress: any): string {
  if (!progress) return `${label}: n/a`;
  const applied = progress.appliedIndex ?? progress.appliedId ?? '?';
  const highest = progress.highestRelevantWalletIndex ?? progress.highestTransactionId ?? '?';
  return (
    `${label}: applied=${String(applied)} highest=${String(highest)} ` +
    `connected=${progress.isConnected ?? false} strict=${progress.isStrictlyComplete?.() ?? false}`
  );
}

/**
 * Best-effort snapshot of the current DUST projection and per-child sync state,
 * for the diagnostic shown when a bounded DUST wait expires.
 */
async function describeWalletState(walletCtx: WalletContext): Promise<string> {
  try {
    const s: any = await Rx.firstValueFrom(
      (walletCtx.wallet as any).state().pipe(Rx.timeout({ first: 15_000 })),
    );
    return [
      `  DUST projection now: ${s.dust.balance(new Date()).toLocaleString()}`,
      formatChildProgress('  shielded', s.shielded?.state?.progress),
      formatChildProgress('  unshielded', s.unshielded?.progress),
      formatChildProgress('  dust', s.dust?.state?.progress),
    ].join('\n');
  } catch {
    return '  (could not read latest wallet state)';
  }
}

// ─── Compiled contract loading ─────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'priestate');

// Compiled assets must be present; the compiled contract module itself is
// imported statically via src/contract/index.ts (CompiledPriestateContract).
for (const rel of ['zkir/checkEligibility.zkir', 'zkir/checkEligibility.bzkir', 'keys/checkEligibility.prover']) {
  if (!fs.existsSync(path.join(zkConfigPath, rel))) {
    console.error('\n❌ Contract not compiled! Run: npm run compile\n');
    process.exit(1);
  }
}

// ─── Providers ─────────────────────────────────────────────────────────────────

const PLACEHOLDER_PASSWORD = 'Local-Devnet-Development-Placeholder-1';

async function createProviders(walletCtx: WalletContext) {
  // The SDK requires the private-state password to be at least 16 characters.
  // On public networks the placeholder would silently leave the local
  // private-state level-db weakly encrypted — require a strong real password
  // there instead.
  const envPassword = process.env.PRIVATE_STATE_PASSWORD?.trim();
  if (network !== 'undeployed' && !envPassword) {
    console.error('\n❌ PRIVATE_STATE_PASSWORD is required on public networks.');
    console.error('   Set a strong password (>= 16 chars) before deploying to preview/preprod.\n');
    process.exit(1);
  }
  if (envPassword && envPassword.length < 16) {
    console.error('\n❌ PRIVATE_STATE_PASSWORD must be at least 16 characters.\n');
    process.exit(1);
  }
  const privateStatePassword = envPassword || PLACEHOLDER_PASSWORD;

  const walletProvider = {
    // In Midnight.js 4.1.x the WalletProvider interface returns the key objects
    // (CoinPublicKey / EncPublicKey) directly — no longer hex strings.
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      // balanceUnboundTransaction -> finalizeRecipe is the complete balancing
      // path in wallet-sdk 1.x; the earlier explicit signRecipe step is gone.
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'priestate-state',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Deploy PRIESTATE to ${network}`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log(`  Eligibility threshold: ${THRESHOLD}\n`);

  const seed = SEED;

  console.log('─── Wallet setup ───────────────────────────────────────────────\n');
  console.log('  Creating wallet...');
  const walletCtx = await createWallet({ network, networkConfig, seed });
  const restoredCount = Object.values(walletCtx.restored).filter(Boolean).length;
  if (restoredCount > 0) {
    console.log(`  Restored ${restoredCount}/3 child wallets from .midnight-wallet-state — sync will resume from saved point.`);
  }

  console.log('  Syncing with network...');
  console.log('  ℹ  This may take several minutes depending on network size.');
  console.log('     RPC disconnection messages during sync are normal and can be safely ignored.\n');
  const syncStart = Date.now();
  const syncInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - syncStart) / 1000);
    process.stdout.write(`\r  ⏳ Still syncing... (${elapsed}s elapsed)   `);
  }, 5000);
  const state = await waitForSyncedStateWithProgress(network, walletCtx);
  clearInterval(syncInterval);
  process.stdout.write('\r  ✓ Synced with network.                                      \n');

  // Persist sync state now so a later deploy failure doesn't waste the sync work.
  await persistWalletState(network, walletCtx);

  const address = walletCtx.unshieldedKeystore.getBech32Address();
  let balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  console.log(`\n  Wallet Address: ${address}`);
  console.log(`  Balance: ${balance.toLocaleString()} tNight\n`);

  if (network === 'undeployed' && balance === 0n) {
    console.error(
      '\n❌ Genesis-seed wallet has zero NIGHT. The devnet preset may not have minted to it.\n' +
        '   Check `docker compose ps` and `docker compose logs node`. Then `docker compose down -v` and retry.\n',
    );
    await walletCtx.wallet.stop();
    process.exit(1);
  }

  // Faucet poll for public networks. The wallet has 0 tNIGHT until the user
  // funds the address from the network's faucet. The display balance is
  // authoritative here (unlike DUST, tNIGHT shows up immediately once the
  // faucet tx lands).
  //
  // NOTE: Never gate these reads on the facade's strict `isSynced`. That
  // getter requires all three child wallets to be strictly complete
  // (applyLag === 0) at the same emission; on preprod a child can keep a small
  // permanent gap, so `isSynced` never becomes true and a filter-gated read
  // blocks forever (the pre-deploy hang seen in the field). The sync step
  // above already used the tolerant per-child `waitForSyncedState(allowedGap)`
  // approach; the snapshot it produced is authoritative for the initial check,
  // and each poll re-reads the latest state with a bounded timeout instead of
  // re-gating on `isSynced`.
  if (network !== 'undeployed' && networkConfig.faucet) {
    const initialTNight = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    if (initialTNight === 0n) {
      console.log('─── Fund Wallet ────────────────────────────────────────────────\n');
      console.log(`  Wallet address: ${address}`);
      console.log(`  Faucet:         ${networkConfig.faucet}`);
      console.log('');
      console.log('  Waiting for tNIGHT to arrive (poll every 10s)...');
      const rawTimeout = Number(process.env.MIDNIGHT_FAUCET_TIMEOUT_MS);
      const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 600_000;
      const start = Date.now();
      while (true) {
        await new Promise((r) => setTimeout(r, 10_000));
        const s = await readLatestWalletState(walletCtx.wallet);
        const tn = s.ok ? readTNightBalance(s.state, unshieldedToken().raw) : 0n;
        if (tn > 0n) {
          console.log(`\n  Funded! tNIGHT balance: ${tn.toLocaleString()}\n`);
          break;
        }
        if (Date.now() - start > timeoutMs) {
          console.log(`\n  ❌ Funding not received within ${Math.round(timeoutMs / 60_000)} min.`);
          console.log(`  Address: ${address}`);
          console.log(`  Faucet:  ${networkConfig.faucet}`);
          console.log('  Re-run setup after funding — your seed is preserved.\n');
          await walletCtx.wallet.stop();
          process.exit(1);
        }
        const elapsed = Math.round((Date.now() - start) / 1000);
        process.stdout.write(`\r  ...still waiting (${elapsed}s elapsed)`);
      }
    }
  }

  // Register for DUST.
  console.log('─── DUST Token Setup ───────────────────────────────────────────\n');
  const dustSetupTimeoutMs = resolveDustSetupTimeoutMs();

  // The sync step above already confirmed all children are caught up (tolerant
  // per-child gap). Read the latest cached state here instead of re-gating on
  // the facade's strict isSynced, which can never become true when a child has
  // a persistent small gap and would otherwise block forever. The 15s guard
  // still turns a wedged wallet observable into a clear error.
  let dustState: any;
  try {
    dustState = await withTimeout(
      Rx.firstValueFrom((walletCtx.wallet as any).state().pipe(Rx.timeout({ first: 15_000 }))),
      dustSetupTimeoutMs,
      'Could not read the latest wallet state before DUST registration.',
    );
  } catch (err) {
    if (err instanceof DustSetupTimeoutError) {
      console.error(`\n❌ ${err.message}`);
      await walletCtx.wallet.stop();
      process.exit(1);
    }
    throw err;
  }

  // The Preprod public RPC is intermittently unstable during the DUST phase
  // (drops the runtime-version subscription with close code 1000, or times out
  // an RPC call in the 60s window), surfacing recoverable Wallet.Sync errors.
  // Those are transient and safe to retry with bounded exponential backoff.
  // Non-transient failures fail immediately, and retries never run forever.
  //
  // Each attempt re-reads the current unregistered-UTXO set so a registration
  // that the SDK actually submitted (despite throwing) is never blindly
  // re-submitted, and each attempt is wrapped in its own per-attempt timeout so
  // a hung RPC call cannot stall the whole retry.
  const refreshUnregisteredUtxos = async (): Promise<any[]> => {
    try {
      const s: any = await Rx.firstValueFrom(
        (walletCtx.wallet as any).state().pipe(Rx.timeout({ first: 15_000 })),
      );
      return s.unshielded.availableCoins.filter((c: any) => !c.meta?.registeredForDustGeneration);
    } catch {
      // If we cannot read a fresh state, fall back to the snapshot captured
      // just before the retry loop began (still safe: idempotent re-check).
      return dustStateUnregisteredUtxosSnapshot;
    }
  };

  const dustStateUnregisteredUtxosSnapshot = dustState.unshielded.availableCoins.filter(
    (c: any) => !c.meta?.registeredForDustGeneration,
  );
  if (dustStateUnregisteredUtxosSnapshot.length > 0) {
    console.log(`  Registering ${dustStateUnregisteredUtxosSnapshot.length} NIGHT UTXOs for DUST generation...`);
    const result = await retryWithBackoff(
      () =>
        withTimeout(
          (async () => {
            // Refresh the current unregistered set before this attempt.
            const current = await refreshUnregisteredUtxos();
            if (current.length === 0) {
              return 0;
            }
            // The signDustRegistration callback (3rd arg) already produces a
            // recipe with N signatures matching N inputs. Do NOT call
            // signRecipe again — that would double-sign and the chain rejects
            // with InputsSignaturesLengthMismatch (Custom error 192). Matches
            // upstream example-counter and example-bboard.
            const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
              current,
              walletCtx.unshieldedKeystore.getPublicKey(),
              (payload) => walletCtx.unshieldedKeystore.signData(payload),
            );
            const finalized = await walletCtx.wallet.finalizeRecipe(recipe);
            await walletCtx.wallet.submitTransaction(finalized);
            return current.length;
          })(),
          dustSetupTimeoutMs,
          `Registering NIGHT UTXOs for DUST generation did not complete. ` +
            'This usually means the proof server (npm run proof-server:start) is down or the ' +
            'registration transaction was not accepted on-chain.',
        ),
      { maxAttempts: DEFAULT_DUST_RETRY_ATTEMPTS },
    );
    if (result.ok) {
      if (result.value > 0) console.log('  DUST registration submitted.');
    } else if (result.error instanceof DustSetupTimeoutError) {
      console.error(`\n❌ ${result.error.message}`);
      console.error('  The wallet state is preserved; re-run setup once the proof server is healthy.\n');
      await walletCtx.wallet.stop();
      process.exit(1);
    } else {
      throw result.error;
    }
  }

  // Wait for the wall-clock DUST projection to exceed zero. This must re-run on
  // a periodic tick: wallet.state() does not re-emit on a quiet wallet, so the
  // projection would never be recomputed and the wait would hang forever. The
  // wait requires the projected DUST to actually appear (never fabricated) and
  // is bounded so a stuck generation (e.g. the registration tx never landing)
  // fails loudly instead of silently running for an hour.
  if (dustState.dust.balance(new Date()) === 0n) {
    console.log('  Waiting for DUST tokens...');
    try {
      await withTimeout(
        Rx.firstValueFrom(
          Rx.combineLatest([(walletCtx.wallet as any).state(), Rx.timer(0, 1000)]).pipe(
            Rx.filter(([s]: [any]) => s.dust.balance(new Date()) > 0n),
          ),
        ),
        dustSetupTimeoutMs,
        `DUST tokens never became available within ${dustSetupTimeoutMs / 60_000} min. ` +
          'If a registration was submitted above it may not have landed, or the wallet is ' +
          'disconnected from the indexer. The block below shows the latest state.',
      );
    } catch (err) {
      if (err instanceof DustSetupTimeoutError) {
        console.error(`\n❌ ${err.message}`);
        console.error(await describeWalletState(walletCtx));
        console.error('\n  The wallet state is preserved; re-run setup to retry.\n');
        await walletCtx.wallet.stop();
        process.exit(1);
      }
      throw err;
    }
  }
  console.log('  DUST tokens ready!\n');

  // Deploy.
  console.log('─── Deploy Contract ────────────────────────────────────────────\n');

  console.log('  Checking proof server...');
  const proofServerReady = await waitForProofServer();
  if (!proofServerReady) {
    console.log('\n  ❌ Proof server not responding. Run: npm run proof-server:start\n');
    await walletCtx.wallet.stop();
    process.exit(1);
  }
  process.stdout.write('\r  Proof server ready!                                 \n');

  console.log('  Setting up providers...');
  const providers = await createProviders(walletCtx);

  // The wallet's reported DUST balance is a *time-projection* of what its
  // registered NIGHT will eventually generate; the tx-builder spends only
  // what the next block's timestamp accounts for, which lags wall-clock by
  // ~1 block on a fresh devnet. Sleeping ~1 block-time before attempt 1
  // closes that gap in the common case; the retry loop covers outliers.
  process.stdout.write('  Generating DUST...');
  await new Promise((r) => setTimeout(r, 6000));
  process.stdout.write(' done.\n');

  console.log('  Deploying contract...\n');

  // Fallback timing. The 6s pre-pause above handles the common case; this
  // loop covers genuine outliers (slow blocks, proof-server worker-pool
  // settling). 20 × 5 = 100s total budget.
  const MAX_RETRIES = 20;
  const RETRY_DELAY_MS = 5000;
  let deployed: Awaited<ReturnType<typeof deployContract>> | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // The constructor takes the eligibility threshold and the designated
      // officer DApp public key. The private witnesses (propertyValue, secret
      // keys) are not exercised at deploy time — only the later registration /
      // eligibility circuits consume them.
      deployed = await deployContract(providers, {
        compiledContract: CompiledPriestateContract as any,
        args: [THRESHOLD, OFFICER],
        privateStateId: PRIVATE_STATE_ID,
        initialPrivateState: createPriestatePrivateState(),
      });
      break;
    } catch (err: any) {
      const errMsg = err?.message || err?.toString() || '';
      const errCause = err?.cause?.message || err?.cause?.toString() || '';
      const fullError = `${errMsg} ${errCause}`;

      // DUST shortage is the most common transient failure on a fresh devnet —
      // check it BEFORE proof-server connectivity, because dust-balancing errors
      // can surface through proof-server-shaped messages (the wallet talks to
      // the proof-server while building the dust portion of the tx).
      const isDustShortage =
        fullError.includes('Not enough Dust') ||
        fullError.includes('Insufficient Funds') ||
        fullError.includes('could not balance dust');

      // Quiet the first DUST-shortage retry: it's the expected race between
      // wall-clock projection and block-timestamp accounting and the loud
      // `Insufficient Funds: <huge number>` message scares first-time users.
      // Real failures still get the full diagnostic from attempt 2 onward.
      if (!(isDustShortage && attempt === 1)) {
        console.error(`\n  Attempt ${attempt} error: ${errMsg}`);
        if (errCause && errCause !== errMsg) console.error(`  Cause: ${errCause}`);
      }

      if (
        !isDustShortage &&
        (fullError.includes('Failed to connect to Proof Server') ||
          fullError.includes('connect ECONNREFUSED 127.0.0.1:6300'))
      ) {
        console.log('  ❌ Proof server unreachable. Run: npm run proof-server:start\n');
        await walletCtx.wallet.stop();
        process.exit(1);
      }

      if (isDustShortage) {
        const currentState = await waitForSyncedStateWithProgress(network, walletCtx);
        const dustBalance = currentState.dust.balance(new Date());
        if (attempt < MAX_RETRIES) {
          if (attempt === 1) {
            console.log(`  Still generating DUST, retrying in ${RETRY_DELAY_MS / 1000}s...`);
          } else {
            console.log(`  ⏳ DUST balance: ${dustBalance.toLocaleString()} (attempt ${attempt}/${MAX_RETRIES}); retrying in ${RETRY_DELAY_MS / 1000}s...`);
          }
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        } else {
          console.log(`  ❌ Not enough DUST after ${MAX_RETRIES} retries (current: ${dustBalance.toLocaleString()})`);
          await walletCtx.wallet.stop();
          process.exit(1);
        }
      } else {
        throw err;
      }
    }
  }

  if (!deployed) throw new Error('Deployment failed after all retries');

  const contractAddress = deployed.deployTxData.public.contractAddress;
  console.log('  ✅ Contract deployed successfully!\n');
  console.log(`  Contract Address: ${contractAddress}\n`);

  recordDeployment(network, contractAddress, address.toString());
  console.log('  Saved to .midnight-state.json\n');

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('─── Deployment complete ────────────────────────────────────────\n');
  console.log('  Next: npm run network\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
