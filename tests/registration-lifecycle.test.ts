// Level 2 PART 2 — frontend → contract lifecycle integration tests.
//
// Verify the real on-chain wiring that the registration UI relies on:
//   * applicant/officer SECRET sourcing (env-configured demo secrets),
//   * district encoding / area parsing / status handling for the on-chain
//     Registration public metadata,
//   * privacy: the private property VALUE is never fed to any registry field
//     and is never rendered by the registration UI pages.
//
// These run fully offline (node:test + tsx) — no Midnight network, wallet, or
// proof server is contacted. React components are not mounted (no jsdom); the
// pure helper modules are exercised directly, matching the repo's test style.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RegistrationStatus } from '../src/common-types.js';
import {
  encodeDistrict,
  decodeDistrict,
  registrationStatusLabel,
  registrationStatusClass,
  formatTimestamp,
  parseAreaFromLandString,
} from '../src/registration-utils.js';
import { parseSecret, getApplicantSecretKey, getOfficerSecretKey } from '../src/secret-keys.js';

// ─── Secret sourcing (demo) ────────────────────────────────────────────────

test('[secrets] parseSecret decodes 64-hex into 32 bytes and falls back when unset', () => {
  const fallback = new Uint8Array(32);
  fallback[31] = 0xaa;
  const empty = parseSecret(undefined, fallback, 'K');
  assert.deepEqual(empty, fallback);
  assert.equal(empty.length, 32);

  const hex = '00'.repeat(31) + 'ff';
  const parsed = parseSecret(`0x${hex}`, fallback, 'K');
  assert.equal(parsed.length, 32);
  assert.equal(parsed[31], 0xff);
});

test('[secrets] malformed secret config throws loudly (never silently ignored)', () => {
  assert.throws(() => parseSecret('not-hex', new Uint8Array(32), 'K'), /64 hex chars/);
  assert.throws(() => parseSecret('00'.repeat(31), new Uint8Array(32), 'K'), /64 hex chars/);
});

test('[secrets] getters always return a 32-byte key (empty env → all-zero demo)', () => {
  assert.equal(getApplicantSecretKey().length, 32);
  assert.equal(getOfficerSecretKey().length, 32);
});

// ─── Public registry metadata helpers (real status handling) ───────────────

test('[metadata] district string round-trips through Bytes<32> encoding', () => {
  for (const district of ['Pune', 'Mumbai', 'A very long district name that exceeds thirty two bytes!']) {
    const bytes = encodeDistrict(district);
    assert.equal(bytes.length, 32);
    assert.equal(decodeDistrict(bytes), district.slice(0, 32) || district);
  }
  assert.equal(decodeDistrict(new Uint8Array(32)), ''); // all-zero → empty
});

test('[metadata] area is parsed from a human land string into Uint<64>', () => {
  assert.equal(parseAreaFromLandString('2,400 sq ft'), 2400n);
  assert.equal(parseAreaFromLandString('5 acres'), 5n);
  assert.equal(parseAreaFromLandString('1200'), 1200n);
  assert.equal(parseAreaFromLandString(''), 0n);
});

test('[metadata] real RegistrationStatus maps to honest labels and CSS classes', () => {
  assert.equal(registrationStatusLabel(RegistrationStatus.PENDING), 'PENDING_REVIEW');
  assert.equal(registrationStatusLabel(RegistrationStatus.APPROVED), 'APPROVED');
  assert.equal(registrationStatusLabel(RegistrationStatus.REJECTED), 'REJECTED');
  assert.equal(registrationStatusClass(RegistrationStatus.PENDING), 'status-pending');
  assert.equal(registrationStatusClass(RegistrationStatus.APPROVED), 'status-registered');
  assert.equal(registrationStatusClass(RegistrationStatus.REJECTED), 'status-rejected');
});

test('[metadata] timestamps render honestly (zero/epoch only where present)', () => {
  assert.equal(formatTimestamp(0n), '—');
  assert.ok(typeof formatTimestamp(1700000000000n) === 'string');
});

// ─── Privacy: private VALUE never enters registry metadata or the UI ───────

test('[privacy] registration metadata helpers never reference the valuation figure', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/registration-utils.ts', import.meta.url)), 'utf8');
  // The public-metadata helpers must never name or handle the confidential
  // valuation figure — it belongs only to the private eligibility witness.
  assert.ok(!/propertyValue/i.test(src));
});

test('[privacy] registration UI pages render only a PRIVATE badge, never the value', () => {
  for (const file of ['OfficerPage.tsx', 'RegistrationReviewPage.tsx']) {
    const src = readFileSync(fileURLToPath(new URL(`../src/pages/${file}`, import.meta.url)), 'utf8');
    // The on-chain value is only ever a placeholder badge — never an inline value.
    assert.ok(src.includes('PRIVATE'), `${file} must render a PRIVATE badge`);
    assert.ok(
      !/\{(data|selected)\.propertyValue\}/.test(src),
      `${file} must not render the raw property value`,
    );
  }
});

test('[privacy] no demo secret key value is committed as a concrete secret', () => {
  const example = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
  // The .env.example only documents the variables; it must not ship a real secret.
  assert.ok(example.includes('VITE_PRIESTATE_APPLICANT_SECRET'));
  assert.ok(example.includes('VITE_PRIESTATE_OFFICER_SECRET'));
  assert.ok(!/[0-9a-f]{64}/.test(example), '.env.example must not contain a 64-hex secret value');
});
