// Access-control and append-only record model tests (pure logic, no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// sessionStorage is not available in node — roles.ts guards access.
import {
  determineRole,
  isDemoOfficerAddress,
  hasDemoOfficerGrant,
  grantDemoOfficer,
  revokeDemoOfficer,
} from '../src/auth/roles';
import {
  getHistory,
  getLatestStatusEvent,
  appendApproval,
  appendRejection,
} from '../src/data/record-history';

test('determineRole defaults every connected wallet to USER', () => {
  assert.equal(determineRole('addr-0'.padEnd(56, '0')), 'USER');
});

test('demo officer grant elevates role to OFFICER for the session', () => {
  const addr = 'demo-officer-address';
  assert.equal(determineRole(addr), 'USER');
  grantDemoOfficer();
  assert.equal(hasDemoOfficerGrant(), true);
  assert.equal(determineRole(addr), 'OFFICER');
  revokeDemoOfficer();
  assert.equal(determineRole(addr), 'USER');
});

test('allow-list check is exact-match and case-insensitive', () => {
  // No allow-list configured in test env — nothing matches.
  assert.equal(isDemoOfficerAddress('anything'), false);
});

test('record history is seeded from mock data and read-only', () => {
  const log = getHistory('reg-001');
  assert.ok(log.length >= 2, 'approved mock record should have submitted + approved events');
  assert.equal(log[0].type, 'REGISTRATION_SUBMITTED');
  assert.equal(getLatestStatusEvent('reg-001')?.type, 'REGISTRATION_APPROVED');
});

test('approve appends a new event without rewriting prior history', () => {
  const before = getHistory('reg-003').map((e) => ({ ...e }));
  assert.equal(getLatestStatusEvent('reg-003'), undefined);

  appendApproval('reg-003');

  const after = getHistory('reg-003');
  assert.equal(after.length, before.length + 1);
  // Every pre-existing entry is untouched and in the same order.
  before.forEach((e, i) => assert.deepEqual(after[i], e));
  assert.equal(after[after.length - 1].type, 'REGISTRATION_APPROVED');
  assert.equal(after[after.length - 1].actor, 'OFFICER');
  assert.equal(getLatestStatusEvent('reg-003')?.type, 'REGISTRATION_APPROVED');

  // A later rejection does not overwrite the approval — it appends.
  appendRejection('reg-003');
  const log = getHistory('reg-003');
  assert.equal(log.length, before.length + 2);
  assert.equal(log.some((e) => e.type === 'REGISTRATION_APPROVED'), true, 'approval remains in history');
  assert.equal(getLatestStatusEvent('reg-003')?.type, 'REGISTRATION_REJECTED');
});
