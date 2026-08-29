// Pure helpers for the faucet-funding wait in src/deploy.ts.
//
// The wallet facade's strict `isSynced` getter only becomes true when ALL
// three child wallets (shielded, unshielded, dust) report strict completion
// (applyLag === 0) at the same emission. On preprod a child wallet can keep a
// small permanent lag (the known historical dust-decode issue), so strict
// `isSynced` can stay false forever. Gating a state read on `isSynced` then
// hangs the wait indefinitely — this is what froze the pre-deploy faucet check.
//
// These helpers read the LATEST wallet state WITHOUT any `isSynced` filter and
// always bound the read to `readTimeoutMs`, so the faucet/pre-check path can
// never wait forever: a wedged wallet observable surfaces as `{ ok: false }`
// instead of hanging. No SDK imports and no side effects, so this module can be
// unit-tested without the network or a wallet.

import * as Rx from 'rxjs';

export const DEFAULT_WALLET_STATE_READ_TIMEOUT_MS = 15_000;

export interface LatestWalletStateResult {
  ok: boolean;
  state?: any;
  reason?: string;
}

/**
 * Extract the tNIGHT balance for `tokenRaw` from a wallet facade state object.
 * Returns `0n` for any missing/empty shape rather than throwing.
 */
export function readTNightBalance(state: any, tokenRaw: string): bigint {
  return (state?.unshielded?.balances?.[tokenRaw] as bigint | undefined) ?? 0n;
}

/**
 * Read the latest wallet facade state from `wallet.state()` with a bounded
 * first-emission timeout and no strict-`isSynced` gating.
 *
 * - `{ ok: true, state }`  → a fresh state emission arrived in time.
 * - `{ ok: false, reason }` → the observable never emitted within
 *   `readTimeoutMs` (or errored). Never throws, so a wedged observable cannot
 *   stall the caller; the caller's own deadline still bounds any loop.
 */
export async function readLatestWalletState(
  wallet: { state: () => unknown },
  readTimeoutMs: number = DEFAULT_WALLET_STATE_READ_TIMEOUT_MS,
): Promise<LatestWalletStateResult> {
  const source = (wallet.state as () => any)();
  try {
    const state = await Rx.firstValueFrom(source.pipe(Rx.timeout({ first: readTimeoutMs })));
    return { ok: true, state };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}