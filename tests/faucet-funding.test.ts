// Focused tests for the bounded, non-strict wallet-state read used by the
// faucet-funding pre-check / poll in src/deploy.ts (src/faucet-funding.ts).
//
// Regression target: the faucet block previously waited on
// `wallet.state().pipe(Rx.filter((s) => s.isSynced))` with NO timeout. The
// facade's strict `isSynced` requires all three child wallets to be strictly
// complete (applyLag === 0) at the same emission; on preprod a child can keep
// a small permanent gap, so that observable never emits and the deploy hung
// forever right after a successful sync. These tests prove the replacement
// reads the latest state without gating on `isSynced` and is always bounded.
//
// Pure logic: rxjs Observables only, no SDK, no network, no wallet state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Subject, Observable } from 'rxjs';

import {
  readLatestWalletState,
  readTNightBalance,
  DEFAULT_WALLET_STATE_READ_TIMEOUT_MS,
} from '../src/faucet-funding';

const TOKEN = '0000000000000000000000000000000000000000000000000000000000000000';

function fakeWallet(state$: Observable<unknown>): { state: () => unknown } {
  return { state: () => state$ };
}

// ── readTNightBalance ────────────────────────────────────────────────────────

test('readTNightBalance returns 0n for empty/missing shapes', () => {
  assert.equal(readTNightBalance(undefined, TOKEN), 0n);
  assert.equal(readTNightBalance(null, TOKEN), 0n);
  assert.equal(readTNightBalance({}, TOKEN), 0n);
  assert.equal(readTNightBalance({ unshielded: {} }, TOKEN), 0n);
  assert.equal(readTNightBalance({ unshielded: { balances: {} } }, TOKEN), 0n);
  assert.equal(readTNightBalance({ unshielded: { balances: { other: 5n } } }, TOKEN), 0n);
});

test('readTNightBalance reads the balance for the requested token raw', () => {
  const state = { unshielded: { balances: { [TOKEN]: 42n } } };
  assert.equal(readTNightBalance(state, TOKEN), 42n);
});

// ── readLatestWalletState: the regression — must NOT gate on strict isSynced ─

test('resolves with the latest state even when strict isSynced is always false', async () => {
  const states = new Subject<unknown>();
  const result = readLatestWalletState(fakeWallet(states.asObservable()), 200);

  states.next({
    isSynced: false,
    unshielded: { balances: { [TOKEN]: 2_000_000_000n } },
  });

  const r = await result;
  assert.equal(r.ok, true);
  assert.equal(r.state?.isSynced, false);
  assert.equal(r.state?.unshielded?.balances?.[TOKEN], 2_000_000_000n);
});

test('resolves whenever the observable emits — even though isSynced is never true', async () => {
  // A single (cached) emission with isSynced:false must resolve the read. The
  // old filter-gated code would drop it and wait forever for a true emission.
  const states = new Subject<unknown>();
  const started = Date.now();
  const result = readLatestWalletState(fakeWallet(states.asObservable()), 200);

  states.next({ isSynced: false, unshielded: { balances: { [TOKEN]: 7n } } });

  const r = await result;
  const elapsed = Date.now() - started;
  assert.equal(r.ok, true);
  assert.equal(r.state?.isSynced, false);
  assert.equal(r.state?.unshielded?.balances?.[TOKEN], 7n);
  // Resolves from the first emission — no wait-forever behavior.
  assert.ok(elapsed < 2000, `should resolve quickly, took ${elapsed}ms`);
});

// ── readLatestWalletState: bounded even when the observable never emits ──────

test('does not hang when the observable never emits — times out bounded', async () => {
  const never = new Observable<unknown>(() => undefined); // no emissions
  const started = Date.now();
  const r = await readLatestWalletState(fakeWallet(never), 150);
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  // Bounded: far less than the old behavior (hang forever). Give headroom for
  // scheduler overhead while still asserting the wait didn't hang.
  assert.ok(elapsed < 2000, `should time out quickly, took ${elapsed}ms`);
});

test('a quiet-but-never-strictly-synced wallet times out rather than hang', async () => {
  // The field failure mode: the wallet has already emitted only isSynced:false
  // states (consumed before this read begins) and now sits quiet. A fresh read
  // must not wait for a strict isSynced emission that can never arrive.
  const states = new Subject<unknown>();
  // Consumed before the read starts (nothing replays in a Subject).
  states.next({ isSynced: false, unshielded: { balances: { [TOKEN]: 0n } } });

  const started = Date.now();
  const r = await readLatestWalletState(fakeWallet(states.asObservable()), 150);
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  assert.ok(elapsed < 2000, `should time out quickly, took ${elapsed}ms`);
});

// ── readLatestWalletState: error handling ────────────────────────────────────

test('surfaces a broken observable as ok:false instead of hanging', async () => {
  const broken = new Observable<unknown>((subscriber) => {
    subscriber.error(new Error('wallet observable exploded'));
  });
  const r = await readLatestWalletState(fakeWallet(broken), 150);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /exploded/);
});

test('default read timeout constant is a finite positive number of ms', () => {
  assert.equal(typeof DEFAULT_WALLET_STATE_READ_TIMEOUT_MS, 'number');
  assert.ok(Number.isFinite(DEFAULT_WALLET_STATE_READ_TIMEOUT_MS));
  assert.ok(DEFAULT_WALLET_STATE_READ_TIMEOUT_MS > 0);
});