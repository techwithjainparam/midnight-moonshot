// Level 2 PART 4 — Officer authorization alignment tests.
//
// The agreed model is ONE designated officer whose public key is sealed in
// the Compact contract at deploy. approveRegistration / rejectRegistration
// derive the DApp public key from the OFFICER SECRET witness and assert it
// equals that sealed key on-chain. This is NOT a government credential /
// identity system.
//
// These tests assert the frontend↔on-chain boundary stays honest:
//   * the frontend role gate is explicitly a DEMO / UX-only gate (it never
//     claims to be real authentication),
//   * approve/reject forward the REAL officer secret into the circuit (no
//     client-side authorization shortcut, no fabricated success),
//   * secret key values are never rendered or logged,
//   * incorrect officer credentials are allowed to fail at the contract
//     boundary (the circuit, not the client, authorizes).
//
// Runs fully offline (node:test + tsx) — no network, wallet, or proof server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createWitnesses, setOfficerSecretKey } from '../src/contract/witnesses.js';
import { PriestateAPI } from '../src/priestate-api.js';
import { getOfficerSecretKey, parseSecret } from '../src/secret-keys.js';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
const root = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

// ── 1. Frontend gate is DEMO / UX-only — never real authentication ──────────

test('[authz] the frontend officer gate is explicitly documented as DEMO-only', () => {
  const roles = src('auth/roles.ts');
  const guard = src('components/guards/RequireOfficer.tsx');

  // Both the role logic and the route guard must carry honest DEMO wording and
  // explicitly disclaim any real government authentication.
  assert.ok(/DEMO/i.test(roles), 'roles.ts must be clearly marked DEMO');
  assert.ok(
    /not.+production (authentication|auth)|not real auth|demo authorization/i.test(roles),
    'roles.ts must not claim real authorization',
  );
  assert.ok(/DEMO/i.test(guard), 'RequireOfficer gate must be clearly marked DEMO');
  assert.ok(
    /not real authentication|demo authorization/i.test(guard),
    'RequireOfficer must not claim real authentication',
  );
});

test('[authz] the frontend gate never pretends to be a government credential system', () => {
  const guard = src('components/guards/RequireOfficer.tsx');
  // It must state that government authentication "does not exist yet".
  assert.ok(
    /government authentication does not exist yet/i.test(guard),
    'RequireOfficer must say real government auth does not exist',
  );
});

// ── 2. Real approve/reject forward the officer secret into the circuit ──────

test('[authz] approve/reject hand the officer secret to the circuit (no local auth)', () => {
  const apiSrc = src('priestate-api.ts');
  const pageSrc = src('pages/OfficerPage.tsx');

  // The API must feed the secret to the officer-secret witness and then invoke
  // the real contract circuit — it must never short-circuit with a local role
  // decision or fake success.
  assert.ok(/setOfficerSecretKey\(officerSecretKey\)/.test(apiSrc));
  assert.ok(/callTx\.approveRegistration\(registrationId, reviewedAt\)/.test(apiSrc));
  assert.ok(/callTx\.rejectRegistration\(registrationId, reviewedAt\)/.test(apiSrc));

  // The Officer portal passes the env-configured officer secret into those calls.
  assert.ok(
    /api\.approveRegistration\(\s*getOfficerSecretKey\(\)\s*,/.test(pageSrc),
    'OfficerPage must call approve with the officer secret',
  );
  assert.ok(
    /api\.rejectRegistration\(\s*getOfficerSecretKey\(\)\s*,/.test(pageSrc),
    'OfficerPage must call reject with the officer secret',
  );
});

test('[authz] the officer-secret witness reads the module-held secret and leaves state untouched', () => {
  const secret = new Uint8Array(32);
  secret[0] = 0xde;
  secret[31] = 0xad;
  setOfficerSecretKey(secret);

  const ps: Record<string, never> = {};
  const [returnedPs, value] = createWitnesses().officerSecretKey({ privateState: ps });
  assert.equal(returnedPs, ps, 'officerSecretKey must not write into public/private state');
  assert.deepEqual(value, secret, 'the exact officer secret is fed to the circuit');
});

test('[authz] no fabricated approval/rejection success exists in the portal', () => {
  const pageSrc = src('pages/OfficerPage.tsx');
  // Status is displayed ONLY from the on-chain ledger, never hardcoded to a
  // finalized verdict. Any "approved/rejected" text must come from the real
  // status or from a post-transaction result message — never fabricated.
  assert.ok(
    !/registrationStatus\s*=\s*'APPROVED'|registrationStatus\s*=\s*'REJECTED'/.test(pageSrc),
    'OfficerPage must not hardcode a fabricated finalized status',
  );
  // The success message is set only after awaiting the real on-chain call.
  assert.match(pageSrc, /await api\.approveRegistration/);
  assert.match(pageSrc, /await api\.rejectRegistration/);
});

// ── 3. Secrets are never rendered or logged ─────────────────────────────────

test('[authz] API logging never includes the secret-key values', () => {
  const apiSrc = src('priestate-api.ts');
  // The logger calls must not serialize the secret keys.
  assert.ok(
    !/logger\?\.(info|warn|debug)\(\{[^}]*officerSecretKey/.test(apiSrc),
    'approve/reject logging must not include officerSecretKey',
  );
  assert.ok(
    !/logger\?\.(info|warn|debug)\(\{[^}]*applicantSecretKey/.test(apiSrc),
    'submit logging must not include applicantSecretKey',
  );
});

test('[authz] the officer secret is never rendered or written to the DOM', () => {
  const pageSrc = src('pages/OfficerPage.tsx');
  const keysSrc = src('secret-keys.ts');
  // Nothing in the portal may interpolate / display the secret bytes or short
  // form of the secret key value.
  // Must not RENDER the secret: no JSX interpolation of the key result, and no
  // transformation of the key bytes into a displayable form. (Importing the
  // getter for forwarding into the API is fine and is covered above.)
  assert.ok(
    !/getOfficerSecretKey\(\)\s*[^;]*\.(toString|slice|map)/.test(pageSrc),
    'OfficerPage must not transform/render the secret key value',
  );
  assert.ok(
    !/\{\s*getOfficerSecretKey\s*\(/.test(pageSrc),
    'OfficerPage must not interpolate the secret key into the DOM',
  );
  assert.ok(!/render|display|document\.|console\./.test(keysSrc));
});

test('[authz] malformed officer secret config fails loudly (never silently used)', () => {
  assert.throws(() => parseSecret('zz'.repeat(32), new Uint8Array(32), 'VITE_PRIESTATE_OFFICER_SECRET'),
    /64 hex chars/);
});

// ── 4. Incorrect credentials fail at the contract boundary ─────────────────

test('[authz] on-chain approve/reject enforce the single designated officer', () => {
  const contract = root('contracts/priestate.compact');
  assert.ok(contract.includes('sealed ledger officer: Bytes<32>'));
  // Both circuits must derive the officer public key from the secret and assert
  // it equals the sealed officer — so a wrong secret is rejected by the circuit.
  assert.ok(
    /approveRegistration[\s\S]*?assert\(disclose\(officerPk\) == officer/.test(contract),
    'approveRegistration must assert the derived officer key equals the sealed officer',
  );
  assert.ok(
    /rejectRegistration[\s\S]*?assert\(disclose\(officerPk\) == officer/.test(contract),
    'rejectRegistration must assert the derived officer key equals the sealed officer',
  );
});

test('[authz] the officer secret is not stored on the public ledger', () => {
  const contract = root('contracts/priestate.compact');
  // The ledger discloses only the officer PUBLIC key, never the secret.
  assert.ok(!/ledger\s+officerSecretKey/.test(contract));
});

// ── 5. Env demo secrets remain DEMO-only helpers ────────────────────────────

test('[authz] getOfficerSecretKey always yields a 32-byte key (empty → demo zero)', () => {
  assert.equal(getOfficerSecretKey().length, 32);
  assert.ok(PriestateAPI !== undefined);
});
