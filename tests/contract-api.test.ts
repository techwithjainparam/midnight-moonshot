import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyZswapLocalState } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits, contractReferenceLocations } from '../contracts/managed/priestate/contract/index.js';

const ZERO = new Uint8Array(32);
const OFFICER = new Uint8Array(32);
OFFICER[0] = 0xaa;

type PS = Record<string, never>;
const ps: PS = {};

const witnesses = {
  propertyValue: (): [PS, bigint] => [ps, 0n],
  applicantSecretKey: (): [PS, Uint8Array] => [ps, ZERO],
  officerSecretKey: (): [PS, Uint8Array] => [ps, ZERO],
};

test('generated contract module exposes the expected API', () => {
  assert.equal(typeof Contract, 'function');
  assert.equal(typeof ledger, 'function');
  assert.ok(typeof pureCircuits === 'object' && pureCircuits !== null);
  assert.ok(contractReferenceLocations !== undefined);
});

test('Contract can be instantiated with all witnesses', () => {
  const contract = new Contract(witnesses);

  assert.ok(contract.witnesses);
  assert.equal(typeof contract.witnesses.propertyValue, 'function');
  assert.equal(typeof contract.witnesses.applicantSecretKey, 'function');
  assert.equal(typeof contract.witnesses.officerSecretKey, 'function');

  for (const c of [
    'checkEligibility',
    'submitRegistration',
    'approveRegistration',
    'rejectRegistration',
  ] as const) {
    assert.equal(typeof contract.circuits[c], 'function');
    assert.equal(typeof contract.impureCircuits[c], 'function');
    assert.equal(typeof contract.provableCircuits[c], 'function');
  }
});

test('Contract constructor rejects a missing witness', () => {
  assert.throws(() => new Contract({ propertyValue: witnesses.propertyValue } as never));
});

test('initialState configures threshold and designated officer', () => {
  const contract = new Contract(witnesses);
  assert.equal(typeof contract.initialState, 'function');
  const context = {
    initialPrivateState: {},
    initialZswapLocalState: emptyZswapLocalState({ bytes: new Uint8Array(32) }),
  };
  const initialState = contract.initialState(context, 100_000n, OFFICER);
  assert.ok(initialState.currentContractState);

  const l = ledger(initialState.currentContractState.data);
  assert.equal(l.eligibilityThreshold, 100_000n);
  assert.equal(l.eligibilityResult, false);
  assert.deepEqual(l.officer, OFFICER);
  assert.equal(l.registrationCounter, 0n);
  assert.equal(l.registrations.size(), 0n);
  assert.ok(l.registrations.isEmpty());
});
