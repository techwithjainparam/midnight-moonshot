// Level 2 wiring tests: fixed contract address, on-chain eligibility result,
// and private propertyValue preservation.
//
// These run fully offline (node:test + tsx) — no Midnight network, wallet, or
// proof server is contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Subject, Observable } from 'rxjs';

import {
  getFixedContractAddress,
  isValidContractAddress,
  activeNetworkId,
} from '../src/contract-address.js';
import { BrowserPriestateManager } from '../src/browser-manager.js';
import {
  firstResultAfterTx,
  PriestateAPI,
  type PriestateDerivedState,
} from '../src/priestate-api.js';
import { setPropertyValue, createWitnesses } from '../src/contract/witnesses.js';
import {
  saveOnChainEligibility,
  loadOnChainEligibility,
} from '../src/data/on-chain-result.js';
import type { PriestateRegistration } from '../src/common-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const ADDRESS_A = 'a'.repeat(64);
const ADDRESS_B = 'b'.repeat(64);

function state(result: boolean): PriestateDerivedState {
  return {
    eligibilityThreshold: 100000n,
    eligibilityResult: result,
    officer: new Uint8Array(32),
    registrationCounter: 0n,
    registrations: new Map<bigint, PriestateRegistration>(),
  };
}

function withEnv(key: string, value: string | undefined, fn: () => void | Promise<void>): void | Promise<void> {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  const restore = () => {
    if (had) process.env[key] = old as string;
    else delete process.env[key];
  };
  const out = fn();
  if (out instanceof Promise) return out.finally(restore);
  restore();
}

// ─── a. Fixed contract-address wiring ────────────────────────────────────────

test('[wiring] getFixedContractAddress prefers VITE_DEFAULT_CONTRACT', () => {
  withEnv('VITE_DEFAULT_CONTRACT', ADDRESS_A, () => {
    const r = getFixedContractAddress('preprod');
    assert.deepEqual(r, { address: ADDRESS_A, source: 'VITE_DEFAULT_CONTRACT' });
  });
});

test('[wiring] falls back to deployment-state injection only for the matching network', () => {
  withEnv('VITE_DEFAULT_CONTRACT', undefined, () => {
    const g = globalThis as Record<string, unknown>;
    g.__PRIESTATE_DEPLOYED__ = { network: 'preprod', address: ADDRESS_B };
    try {
      assert.deepEqual(getFixedContractAddress('preprod'), {
        address: ADDRESS_B,
        source: 'deployment-state',
      });
      // Network mismatch → no fabricated address; deploy fallback applies.
      assert.equal(getFixedContractAddress('preview'), undefined);
      assert.equal(getFixedContractAddress('undeployed'), undefined);
    } finally {
      delete g.__PRIESTATE_DEPLOYED__;
    }
  });
});

test('[wiring] resolves to undefined — never fabricates an address — when unconfigured', () => {
  withEnv('VITE_DEFAULT_CONTRACT', undefined, () => {
    assert.equal(getFixedContractAddress('preprod'), undefined);
  });
  assert.equal(isValidContractAddress(ADDRESS_A), true);
  assert.equal(isValidContractAddress(ADDRESS_A.slice(0, 63)), false);
  assert.equal(isValidContractAddress('not-an-address'), false);
});

test('[wiring] activeNetworkId defaults to preprod like useWallet', () => {
  withEnv('VITE_NETWORK_ID', undefined, () => {
    assert.equal(activeNetworkId(), 'preprod');
  });
  withEnv('VITE_NETWORK_ID', 'preview', () => {
    assert.equal(activeNetworkId(), 'preview');
  });
});

test('[wiring] manager JOINS the fixed address instead of deploying fresh', async () => {
  const logger = { info() {}, warn() {}, error() {}, child() { return this; } } as never;
  await withEnv('VITE_DEFAULT_CONTRACT', ADDRESS_A, async () => {
    const manager = new BrowserPriestateManager(logger);
    // Deploy path requires a threshold synchronously. With a fixed address
    // configured, resolve must take the JOIN path even without a threshold —
    // so it must NOT throw the deploy-gate error here.
    let obs: Observable<unknown>;
    try {
      obs = manager.resolve(undefined, undefined);
    } catch (e) {
      assert.fail(`resolve() took the DEPLOY path despite a configured address: ${String(e)}`);
    }
    const terminal = await new Promise<unknown>((resolve) => {
      const sub = obs.subscribe({
        next: (d) => {
          const status = (d as { status?: string }).status;
          if (status === 'failed') {
            sub.unsubscribe();
            resolve(d);
          }
        },
        error: (e) => resolve({ status: 'failed', error: e }),
      });
    });
    // Offline node env cannot reach a wallet/indexer, so the join attempt
    // fails — but it must fail as a CONNECTION error, proving join (not the
    // threshold-gated deploy) was attempted.
    const err = (terminal as { error?: Error }).error;
    assert.ok(err instanceof Error);
    assert.doesNotMatch(err.message, /threshold/i);
    manager.disconnect();
  });
});

test('[wiring] explicit address still joins; no address keeps deploy gate', async () => {
  const logger = { info() {}, warn() {}, error() {}, child() { return this; } } as never;
  await withEnv('VITE_DEFAULT_CONTRACT', undefined, async () => {
    // No config + no explicit address + no threshold → existing deploy gate.
    const manager = new BrowserPriestateManager(logger);
    assert.throws(() => manager.resolve(undefined, undefined), /threshold/i);

    // Explicit address bypasses the gate (join), same as env-configured.
    let obs: Observable<unknown>;
    try {
      obs = manager.resolve(ADDRESS_B, undefined);
    } catch (e) {
      assert.fail(`explicit-address resolve() should not hit the deploy gate: ${String(e)}`);
    }
    const terminal = await new Promise<unknown>((resolve) => {
      const sub = obs.subscribe({
        next: (d) => {
          if ((d as { status?: string }).status === 'failed') {
            sub.unsubscribe();
            resolve(d);
          }
        },
        error: (e) => resolve({ status: 'failed', error: e }),
      });
    });
    const err = (terminal as { error?: Error }).error;
    assert.ok(err instanceof Error);
    assert.doesNotMatch(err.message, /threshold/i);
    manager.disconnect();
  });
});

// ─── a2. Registration lifecycle wiring ───────────────────────────────────────

test('[lifecycle] PriestateAPI exposes submit/approve/reject alongside eligibility', () => {
  const proto = PriestateAPI.prototype as unknown as Record<string, unknown>;
  for (const method of [
    'checkEligibility',
    'submitRegistration',
    'approveRegistration',
    'rejectRegistration',
  ]) {
    assert.equal(typeof proto[method], 'function', `PriestateAPI.${method} is missing`);
  }
});

test('[lifecycle] browser-manager deploy fallback requires the designated officer key', () => {
  const logger = { info() {}, warn() {}, error() {}, child() { return this; } } as never;
  const manager = new BrowserPriestateManager(logger);
  // No fixed address, threshold present but no officer key → the fresh-deploy
  // fallback (used only as a last resort) must not proceed without the
  // designated officer designated at deployment.
  assert.throws(() => manager.resolve(undefined, 100000n), /officer key/i);
  manager.disconnect();
});

test('[lifecycle] firstRegistrationIdAfterTx reads the assigned ID after finalize', async () => {
  const { firstRegistrationIdAfterTx } = await import('../src/priestate-api.js');
  const tx = Promise.resolve({ txId: '0x2' });
  // state() returns registrationCounter = 0n, so (counter-1) would underflow —
  // instead verify the helper surfaces the post-tx counter minus one via a
  // bespoke emission where the counter is 3n.
  const custom = new Observable<PriestateDerivedState>((subscriber) => {
    subscriber.next({
      ...state(true),
      registrationCounter: 3n,
    });
    subscriber.complete();
  });
  assert.equal(await firstRegistrationIdAfterTx(tx, custom), 2n);
});

// ─── b. On-chain eligibilityResult (never client-side recomputed) ────────────

test('[result] reads eligibilityResult from the post-transaction ledger emission', async () => {
  const tx = Promise.resolve({ txId: '0x1' });
  let emissions = 0;
  const state$ = new Observable<PriestateDerivedState>((subscriber) => {
    subscriber.next(state(true)); // first ledger state after finalization
    emissions++;
    subscriber.complete();
  });
  const result = await firstResultAfterTx(tx, state$);
  assert.equal(emissions, 1);
  assert.equal(result, true); // exactly what the contract's ledger says
});

test('[result] surfaces a false on-chain result verbatim — no local override', async () => {
  // Even when the private input "would pass" locally, the helper has no
  // access to any input and must return the ledger's false untouched.
  const tx = Promise.resolve(undefined);
  const result = await firstResultAfterTx(
    tx,
    new Observable<PriestateDerivedState>((s) => {
      s.next(state(false));
      s.complete();
    }),
  );
  assert.equal(result, false);
});

test('[result] ignores ledger states emitted BEFORE the transaction finalizes', async () => {
  let releaseTx!: () => void;
  const tx = new Promise<void>((resolve) => (releaseTx = resolve));
  const subject = new Subject<PriestateDerivedState>();

  const pending = firstResultAfterTx(tx, subject.asObservable());
  subject.next(state(false)); // pre-tx stale emission — must be ignored
  await new Promise((r) => setTimeout(r, 10));
  releaseTx(); // transaction finalizes
  await new Promise((r) => setTimeout(r, 10));
  subject.next(state(true)); // post-tx ledger truth
  assert.equal(await pending, true);
  subject.complete();
});

test('[result] times out instead of guessing when no post-tx state arrives', async () => {
  const neverState$ = new Subject<PriestateDerivedState>();
  await assert.rejects(
    firstResultAfterTx(Promise.resolve(undefined), neverState$.asObservable(), 100),
    /Timed out waiting for the on-chain eligibilityResult/i,
  );
  neverState$.complete();
});

// ─── c. Private propertyValue preservation ───────────────────────────────────

test('[privacy] secret-key witnesses feed the module-held values and leave privateState untouched', () => {
  const witnesses = createWitnesses();
  const ps = {}; // PRIESTATE has empty private state
  setPropertyValue(123456789n);
  const secret = new Uint8Array(32);
  secret[0] = 0x42;
  // NB: the secret-key setters are exercised through the API layer; here we
  // confirm the propertyValue witness reads the module-held value and that
  // private state is never written.
  const [returnedPs, value] = witnesses.propertyValue({ privateState: ps });
  assert.equal(returnedPs, ps, 'private state object identity preserved');
  assert.equal(value, 123456789n);
  assert.equal(typeof witnesses.applicantSecretKey, 'function');
  assert.equal(typeof witnesses.officerSecretKey, 'function');
  assert.deepEqual(ps, {}, 'witnesses must NOT write into private/public state');
});

test('[privacy] generated contract ledger exposes only public metadata — never the private witnesses', () => {
  const info = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, 'contracts/managed/priestate/compiler/contract-info.json'),
      'utf-8',
    ),
  ) as {
    circuits: Array<{ name: string }>;
    witnesses: Array<{ name: string }>;
    ledger: Array<{ name: string }>;
  };

  const circuitNames = info.circuits.map((c) => c.name);
  assert.ok(circuitNames.includes('checkEligibility'));
  for (const name of ['submitRegistration', 'approveRegistration', 'rejectRegistration']) {
    assert.ok(circuitNames.includes(name));
  }

  const witnessNames = info.witnesses.map((w) => w.name);
  assert.deepEqual(
    [...witnessNames].sort(),
    ['applicantSecretKey', 'officerSecretKey', 'propertyValue'],
  );

  // The PUBLIC ledger schema is the privacy boundary: only the threshold, the
  // boolean eligibility result, the designated officer, and public registry
  // metadata may appear there. The private propertyValue and the secret keys
  // must never be public ledger fields.
  const ledgerNames = info.ledger.map((l) => l.name).sort();
  assert.deepEqual(ledgerNames, [
    'eligibilityResult',
    'eligibilityThreshold',
    'officer',
    'registrationCounter',
    'registrations',
  ]);
  for (const forbidden of ['propertyValue', 'applicantSecretKey', 'officerSecretKey']) {
    assert.ok(!ledgerNames.includes(forbidden), `${forbidden} must stay off the public ledger`);
  }
});


// ─── b2. Result-record helper passes the ON-CHAIN value through verbatim ─────

function withSessionStorage(fn: () => void): void {
  const g = globalThis as Record<string, unknown>;
  const backing = new Map<string, string>();
  g.sessionStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
  };
  try {
    fn();
  } finally {
    delete g.sessionStorage;
  }
}

test('[result-record] returns the stored on-chain boolean verbatim — no local derivation', () => {
  withSessionStorage(() => {
    saveOnChainEligibility({
      propertyId: 'prop-1',
      result: false,
      finalizedAt: '2026-08-24T18:00:00.000Z',
    });

    const rec = loadOnChainEligibility('prop-1');
    assert.deepEqual(rec, {
      propertyId: 'prop-1',
      result: false,
      finalizedAt: '2026-08-24T18:00:00.000Z',
    });

    saveOnChainEligibility({
      propertyId: 'prop-2',
      result: true,
      finalizedAt: '2026-08-24T18:01:00.000Z',
    });
    assert.equal(loadOnChainEligibility('prop-2')?.result, true);
  });
});

test('[result-record] absent record resolves to null — never derived from property data', () => {
  withSessionStorage(() => {
    // Nothing saved for this id → null. Callers must show an unverified
    // state instead of recomputing eligibility from the private input.
    assert.equal(loadOnChainEligibility('never-verified'), null);
  });
  // No sessionStorage at all (plain Node / SSR) behaves identically.
  assert.equal(loadOnChainEligibility('never-verified'), null);
});
