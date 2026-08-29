// Pure helpers for the DUST-registration retry/backoff in src/deploy.ts.
//
// Preprod public RPC intermittently drops the wallet's WebSocket subscription
// (state_subscribeRuntimeVersion closed with code 1000 / "Normal Closure") and
// occasionally fails to answer RPC calls within the polkadot-js 60s window,
// right after wallet sync during the DUST phase. Those are transient infra
// failures that are safe to retry with backoff.
//
// This module has NO SDK imports and NO `main()` side effects, so it can be
// unit-tested without starting a deployment, touching the wallet, or hitting
// the network.

export const DEFAULT_DUST_RETRY_ATTEMPTS = 5;
export const DEFAULT_DUST_RETRY_BASE_DELAY_MS = 2000;
export const DEFAULT_DUST_RETRY_MAX_DELAY_MS = 30000;

/**
 * Decide whether an error is a transient RPC/WebSocket/Wallet.Sync failure
 * worth retrying. Returns `{ retry: boolean; reason: string }`.
 *
 * - `retry: true`  → transient RPC/WS/Wallet.Sync failure; safe to retry.
 * - `retry: false` → deterministic / non-transient error; fail immediately.
 */
export function isTransientDustError(err: unknown): { retry: boolean; reason: string } {
  const text = flattenError(err).toLowerCase();

  // Non-transient: never mask a real, deterministic problem.
  const NON_TRANSIENT: ReadonlyArray<[RegExp, string]> = [
    [/not enough dust/i, 'DUST shortage is a real balancing failure'],
    [/insufficient funds/i, 'insufficient funds is a real failure'],
    [/custom error: 17[01]/i, 'on-chain DUST validity/spend rejection is not transient'],
    [/invaliddustspendproof/i, 'invalid DUST spend proof is not transient'],
    [/outofdustvaliditywindow/i, 'DUST validity window rejection is not transient'],
    [/inputs signatures length mismatch/i, 'signature mismatch is a logic error'],
    [/proof server unreachable/i, 'proof server unreachability is a config/env failure'],
    [/ec\w*refused 127\.0\.0\.1:6300/i, 'proof server not running'],
    [/dust setup budget exhausted/i, 'DUST setup budget exhausted, not transient'],
    [/timed out during dust setup/i, 'DUST setup budget exhausted, not transient'],
    [/malformedtransaction/i, 'malformed transaction is not transient'],
  ];
  for (const [re, reason] of NON_TRANSIENT) {
    if (re.test(text)) return { retry: false, reason };
  }

  // Transient: RPC/WebSocket/Wallet.Sync instabilities.
  const TRANSIENT: ReadonlyArray<[RegExp, string]> = [
    [/wallet\.sync/i, 'recoverable Wallet.Sync error'],
    [/disconnected from/i, 'RPC WebSocket disconnected'],
    [/no response received from rpc endpoint/i, 'RPC endpoint timed out'],
    [/subscribeRuntimeVersion/i, 'runtime-version subscription dropped'],
    [/connectionerror/i, 'node client connection error'],
    [/connection reset/i, 'connection reset'],
    [/ec\w*resett/i, 'TCP connection reset'],
    [/econnreset/i, 'TCP connection reset'],
    [/etimedout/i, 'connection timed out'],
    [/websocket/i, 'websocket failure'],
    [/1000::|1006::/i, 'websocket close during RPC'],
    [/runtimeversion/i, 'runtime-version subscription failure'],
    [/reconnect/i, 'RPC reconnection failure'],
  ];
  for (const [re, reason] of TRANSIENT) {
    if (re.test(text)) return { retry: true, reason };
  }

  return { retry: false, reason: 'no transient signal detected' };
}

/** Flatten an Error (including causes) into a searchable string. */
export function flattenError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current != null && depth < 6) {
    if (typeof current === 'string') {
      const s = current.trim();
      if (s) parts.push(s);
      break;
    }
    if (current instanceof Error) {
      if (current.message && current.message.trim()) parts.push(current.message);
      current = current.cause;
      depth++;
      continue;
    }
    // Non-Error object: dig for a .message / .cause, else stringify once.
    const c = current as { message?: unknown; cause?: unknown };
    if (typeof c.message === 'string' && c.message.trim()) parts.push(c.message);
    const cause = c.cause;
    if (cause === undefined || cause === null) {
      try {
        const s = JSON.stringify(current);
        if (s) parts.push(s);
      } catch {
        parts.push(String(current));
      }
      break;
    }
    current = cause;
    depth++;
  }
  return parts.join(' | ');
}

/** Bounded exponential backoff delay for the given retry attempt (1-based). */
export function backoffDelay(
  attempt: number,
  baseDelayMs = DEFAULT_DUST_RETRY_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_DUST_RETRY_MAX_DELAY_MS,
): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
}

export interface DustRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Run `op`, retrying ONLY transient RPC/WS/Wallet.Sync failures with bounded
 * exponential backoff. Non-transient errors fail immediately. Never retries
 * forever: caps at `maxAttempts` total tries.
 *
 * - Returns `{ ok: true; value }` on success.
 * - Returns `{ ok: false; error; attempts }` when all attempts fail.
 * - `op` is re-invoked as-is on retry; it is expected to read the DUST phase's
 *   state again (unregistered UTXOs) each time so a partially-submitted
 *   registration is not re-submitted blindly.
 */
export async function retryWithBackoff<T>(
  op: () => Promise<T>,
  options: DustRetryOptions = {},
  snooze: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ ok: true; value: T } | { ok: false; error: unknown; attempts: number }> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_DUST_RETRY_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_DUST_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_DUST_RETRY_MAX_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await op();
      return { ok: true, value };
    } catch (err) {
      lastError = err;
      const classification = isTransientDustError(err);
      if (!classification.retry) {
        return { ok: false, error: err, attempts: attempt };
      }
      if (attempt === maxAttempts) break;
      await snooze(backoffDelay(attempt, baseDelayMs, maxDelayMs));
    }
  }
  return { ok: false, error: lastError, attempts: maxAttempts };
}
