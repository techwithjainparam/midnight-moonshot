// Level 2 PART 3 — real on-chain registry data display tests.
//
// Verify the pure display-mapping logic that turns the contract's on-chain
// `registrations` state into the PUBLIC registry / property detail views:
//   * the public registry lists ONLY finalized (APPROVED) on-chain records,
//   * counts are derived from real status values (never fabricated),
//   * detail views expose only what the thin ledger record actually stores
//     and mark the rest as Unavailable,
//   * privacy: the module never references the confidential property value.
//
// Runs fully offline (node:test + tsx) — no network, wallet, or proof server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RegistrationStatus, type PriestateRegistration } from '../src/common-types.js';
import { encodeDistrict } from '../src/registration-utils.js';
import {
  publicRegistryItems,
  registrationCounts,
  toRegistryItem,
  toRegistrationDetail,
  shortHexKey,
  hasAnyBytes,
} from '../src/registration-view.js';

function registration(overrides: Partial<PriestateRegistration> = {}): PriestateRegistration {
  return {
    owner: new Uint8Array(32),
    area: 2400n,
    status: RegistrationStatus.PENDING,
    district: encodeDistrict('Pune'),
    submittedAt: 1700000000000n,
    reviewedBy: new Uint8Array(32),
    reviewedAt: 0n,
    ...overrides,
  };
}

function regMap(entries: Array<[bigint, PriestateRegistration]>): ReadonlyMap<bigint, PriestateRegistration> {
  return new Map(entries);
}

// ── Public registry (approved-only, sorted) ────────────────────────────────

test('[registry] public registry lists only APPROVED on-chain records', () => {
  const m = regMap([
    [1n, registration({ status: RegistrationStatus.PENDING })],
    [2n, registration({ status: RegistrationStatus.APPROVED })],
    [3n, registration({ status: RegistrationStatus.REJECTED })],
    [4n, registration({ status: RegistrationStatus.APPROVED })],
  ]);
  const items = publicRegistryItems(m);
  assert.deepEqual(items.map((i) => i.id), ['2', '4']);
});

test('[registry] public registry items are sorted by registration ID ascending', () => {
  const m = regMap([
    [9n, registration({ status: RegistrationStatus.APPROVED })],
    [2n, registration({ status: RegistrationStatus.APPROVED })],
    [7n, registration({ status: RegistrationStatus.APPROVED })],
  ]);
  assert.deepEqual(publicRegistryItems(m).map((i) => i.id), ['2', '7', '9']);
});

test('[registry] registry item maps public on-chain metadata (never the value)', () => {
  const item = toRegistryItem(5n, registration({
    area: 3600n,
    district: encodeDistrict('Mumbai'),
    status: RegistrationStatus.APPROVED,
  }));
  assert.equal(item.id, '5');
  assert.equal(item.idBigint, 5n);
  assert.equal(item.area, '3600');
  assert.equal(item.district, 'Mumbai');
  assert.equal(item.statusLabel, 'APPROVED');
  assert.equal(item.statusClass, 'status-registered');
  assert.equal(typeof item.ownerKey, 'string');
  assert.equal(typeof item.submittedLabel, 'string');
});

test('[registry] empty registrations yields an empty public registry', () => {
  assert.deepEqual(publicRegistryItems(regMap([])), []);
});

// ── Status counts from on-chain state ──────────────────────────────────────

test('[registry] counts are derived from real on-chain status values', () => {
  const m = regMap([
    [1n, registration({ status: RegistrationStatus.PENDING })],
    [2n, registration({ status: RegistrationStatus.PENDING })],
    [3n, registration({ status: RegistrationStatus.APPROVED })],
    [4n, registration({ status: RegistrationStatus.REJECTED })],
  ]);
  assert.deepEqual(registrationCounts(m), { total: 4, approved: 1, pending: 2, rejected: 1 });
});

test('[registry] counts are zero for an empty map', () => {
  assert.deepEqual(registrationCounts(regMap([])), { total: 0, approved: 0, pending: 0, rejected: 0 });
});

// ── Detail view: honest availability ───────────────────────────────────────

test('[registry] detail shows reviewer/reviewed only when a reviewer is recorded', () => {
  const owner = new Uint8Array(32);
  owner[0] = 0xab;
  const reviewer = new Uint8Array(32);
  reviewer[31] = 0xcd;

  const unreviewed = toRegistrationDetail(1n, registration({
    owner,
    status: RegistrationStatus.PENDING,
    reviewedBy: new Uint8Array(32),
    reviewedAt: 0n,
  }));
  assert.equal(unreviewed.finalized, false);
  assert.equal(unreviewed.reviewedLabel, '—');
  assert.equal(unreviewed.reviewedByLabel, '—');

  const reviewed = toRegistrationDetail(2n, registration({
    owner,
    status: RegistrationStatus.APPROVED,
    reviewedBy: reviewer,
    reviewedAt: 1701234000000n,
  }));
  assert.equal(reviewed.finalized, true);
  assert.notEqual(reviewed.reviewedLabel, '—');
  assert.equal(reviewed.reviewedByLabel, shortHexKey(reviewer));
});

test('[registry] detail exposes the disclosed owner key binding', () => {
  const owner = new Uint8Array(32);
  owner[0] = 0xfe;
  const d = toRegistrationDetail(7n, registration({ owner }));
  assert.equal(d.ownerKey, shortHexKey(owner));
  assert.equal(hasAnyBytes(owner), true);
  assert.equal(hasAnyBytes(new Uint8Array(32)), false);
});

// ── Privacy ────────────────────────────────────────────────────────────────

test('[privacy] registry display module never references the valuation figure', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/registration-view.ts', import.meta.url)), 'utf8');
  assert.ok(!/propertyValue/i.test(src));
});
