import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyZswapLocalState } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits, contractReferenceLocations } from '../contracts/managed/priestate/contract/index.js';

test('generated contract module exposes the expected API', () => {
  assert.equal(typeof Contract, 'function');
  assert.equal(typeof ledger, 'function');
  assert.ok(typeof pureCircuits === 'object' && pureCircuits !== null);
  assert.ok(contractReferenceLocations !== undefined);
});

test('Contract can be instantiated with a propertyValue witness', () => {
  const contract = new Contract({ propertyValue: () => [0n, 0n] });

  assert.ok(contract.witnesses);
  assert.equal(typeof contract.witnesses.propertyValue, 'function');
  assert.equal(typeof contract.circuits.checkEligibility, 'function');
  assert.equal(typeof contract.impureCircuits.checkEligibility, 'function');
  assert.equal(typeof contract.provableCircuits.checkEligibility, 'function');
});

test('Contract constructor rejects a missing propertyValue witness', () => {
  assert.throws(() => new Contract({} as never));
});

test('initialState is available and validates its threshold argument', () => {
  const contract = new Contract({ propertyValue: () => [0n, 0n] });
  assert.equal(typeof contract.initialState, 'function');
  const context = {
    initialPrivateState: {},
    initialZswapLocalState: emptyZswapLocalState({ bytes: new Uint8Array(32) }),
  };
  const initialState = contract.initialState(context, 100_000n);
  assert.ok(initialState.currentContractState);
  assert.deepEqual(ledger(initialState.currentContractState.data), {
    eligibilityThreshold: 100_000n,
    eligibilityResult: false,
  });
});
