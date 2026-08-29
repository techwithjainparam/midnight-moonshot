// Focused tests for the DUST-registration retry/backoff classification logic
// in src/dust-registration.ts. Pure logic, no SDK, no network, no wallet state.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTransientDustError,
  flattenError,
  backoffDelay,
  retryWithBackoff,
  DEFAULT_DUST_RETRY_ATTEMPTS,
} from '../src/dust-registration';

// ── Classification ────────────────────────────────────────────────────────────

test('flattenError walks the cause chain', () => {
  const inner = new Error('inner');
  (inner as { cause?: unknown }).cause = 'leaf';
  const err = new Error('outer');
  (err as { cause?: unknown }).cause = inner;
  const text = flattenError(err);
  assert.ok(text.includes('outer'));
  assert.ok(text.includes('inner'));
  assert.ok(text.includes('leaf'));
});

test('recognizes transient Wallet.Sync errors', () => {
  const r = isTransientDustError(new Error('Wallet.Sync: [object Object]'));
  assert.equal(r.retry, true);
  assert.match(r.reason, /wallet\.sync/i);
});

test('recognizes RPC RuntimeVersion subscription disconnects (code 1000)', () => {
  const msg =
    'RPC-CORE: subscribeRuntimeVersion(): RuntimeVersion:: disconnected from ' +
    'wss://rpc.preprod.midnight.network/: 1000:: Normal Closure';
  const r = isTransientDustError(new Error(msg));
  assert.equal(r.retry, true);
});

test('recognizes ChainProperties RPC timeout', () => {
  const r = isTransientDustError(new Error('ChainProperties:: No response received from RPC endpoint in 60s'));
  assert.equal(r.retry, true);
});

test('recognizes connection reset / timeout as transient', () => {
  assert.equal(isTransientDustError(new Error('connect ECONNRESET')).retry, true);
  assert.equal(isTransientDustError(new Error('fetch failed: ETIMEDOUT')).retry, true);
});

test('classifies non-transient on-chain DUST rejections as non-transient', () => {
  assert.equal(isTransientDustError(new Error('1010: Invalid Transaction: Custom error: 171')).retry, false);
  assert.equal(isTransientDustError(new Error('InvalidDustSpendProof')).retry, false);
});

test('classifies proof-server unreachable as non-transient', () => {
  assert.equal(
    isTransientDustError(
      new Error('Failed to connect to Proof Server: connect ECONNREFUSED 127.0.0.1:6300'),
    ).retry,
    false,
  );
});

test('classifies DUST setup budget timeout as non-transient', () => {
  const r = isTransientDustError({ name: 'DustSetupTimeoutError', message: 'Timed out during DUST setup' });
  assert.equal(r.retry, false);
});

test('classifies an unknown error as non-transient (no false retries)', () => {
  assert.equal(isTransientDustError(new Error('some unrelated deterministic error')).retry, false);
});

// ── Backoff delay ────────────────────────────────────────────────────────────

test('backoffDelay doubles and caps at max', () => {
  assert.equal(backoffDelay(1, 2000, 30000), 2000);
  assert.equal(backoffDelay(2, 2000, 30000), 4000);
  assert.equal(backoffDelay(3, 2000, 30000), 8000);
  assert.equal(backoffDelay(4, 2000, 30000), 16000);
  assert.equal(backoffDelay(5, 2000, 30000), 30000); // capped
});

// ── retryWithBackoff ─────────────────────────────────────────────────────────

// Deterministic snooze that records delays instead of sleeping.
function fakeSnooze(): { fn: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const fn = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { fn, delays };
}

test('succeeds without retry when op succeeds first try', async () => {
  const r = await retryWithBackoff(async () => 7);
  assert.deepEqual(r, { ok: true, value: 7 });
});

test('retries transient failures and succeeds on a later attempt', async () => {
  let calls = 0;
  const { fn } = fakeSnooze();
  const r = await retryWithBackoff(
    async () => {
      calls++;
      if (calls < 3) throw new Error('Wallet.Sync: transient');
      return 'done';
    },
    { maxAttempts: DEFAULT_DUST_RETRY_ATTEMPTS },
    fn,
  );
  assert.deepEqual(r, { ok: true, value: 'done' });
  assert.equal(calls, 3);
});

test('gives up after maxAttempts on persistent transient failures', async () => {
  let calls = 0;
  const { fn, delays } = fakeSnooze();
  const r = await retryWithBackoff(
    async () => {
      calls++;
      throw new Error('disconnected from wss://rpc.preprod.midnight.network');
    },
    { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 400 },
    fn,
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.attempts, 4);
    assert.match((r.error as Error).message, /disconnected/);
  }
  // exponential: 100, 200, 400 (capped)
  assert.deepEqual(delays, [100, 200, 400]);
});

test('fails immediately (1 attempt, no retry) on non-transient errors', async () => {
  let calls = 0;
  const { fn, delays } = fakeSnooze();
  const r = await retryWithBackoff(
    async () => {
      calls++;
      throw new Error('1010: Invalid Transaction: Custom error: 171');
    },
    { maxAttempts: 5, baseDelayMs: 100 },
    fn,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.attempts, 1);
  assert.equal(calls, 1);
  assert.deepEqual(delays, []); // never slept
});

test('respects maxDelayMs cap across many attempts', async () => {
  let calls = 0;
  const { fn, delays } = fakeSnooze();
  const r = await retryWithBackoff(
    async () => {
      calls++;
      throw new Error('Wallet.Sync: still transient');
    },
    { maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 500 },
    fn,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.attempts, 6);
  assert.deepEqual(delays, [100, 200, 400, 500, 500]); // capped at 500
});
