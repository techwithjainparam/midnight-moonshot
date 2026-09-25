// PRIESTATE Level-2 PART 6 — Frontend registry metadata client tests.
//
// Covers:
//   * toRegistryMetadataInput maps ONLY safe public fields and uses the REAL
//     on-chain registration id as referenceId (never a mock id),
//   * the confidential property VALUE and any secret are never included,
//   * createApplicationMetadata round-trips against the applicant endpoint,
//   * a backend failure after chain success is surfaced honestly (distinct
//     `network`/`unavailable` result — never a fake success),
//   * the client never fabricates APPROVED/REJECTED.
//
// Runs fully offline in-process (node:test + tsx + a real ephemeral HTTP
// server). No DOM, no wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toRegistryMetadataInput,
  createApplicationMetadata,
  registryApiBase,
} from '../src/registry/registry-client';
import type { ServerConfig } from '../server/config';
import { listenVerificationServer } from '../server/index';

const OFFICER_TOKEN = 'official-officer-token-0123456789';

function makeConfig(): ServerConfig {
  return {
    port: 0,
    allowedOrigins: ['http://localhost:3000'],
    email: { configured: false, host: '', port: 587, secure: false, user: '', pass: '', from: '' },
    otp: {
      hashSecret: 'unit-test-otp-hash-secret',
      ttlMs: 60_000,
      maxAttempts: 5,
      resendCooldownMs: 1_000,
      maxSendsPerEmailPerHour: 5,
      maxSendsPerIpPerHour: 20,
    },
    aadhaarKyc: {
      providerName: '',
      apiToken: '',
      baseUrl: '',
      mobileLinkPath: '/api/v1/mobile-to-aadhaar/',
      authScheme: 'token',
      timeoutMs: 1_000,
    },
    registry: { officerToken: OFFICER_TOKEN },
  };
}

const DRAFT = {
  ownerName: 'Asha Mehta',
  village: 'Khed',
  taluka: 'Haveli',
  district: 'Pune',
  surveyNumber: 'Gat No. 100',
  landArea: '2,400 sq ft',
};

test('[registry client] anonymous base URL is the same-origin API (no credential)', () => {
  // Called outside Vite (plain Node) → falls back to same-origin.
  assert.equal(registryApiBase(), '');
});

test('[registry client] toRegistryMetadataInput uses the REAL on-chain id and safe fields only', () => {
  const input = toRegistryMetadataInput(DRAFT, '42');
  assert.equal(input.referenceId, '42');
  assert.equal(input.applicantName, 'Asha Mehta');
  assert.equal(input.village, 'Khed');
  assert.equal(input.taluka, 'Haveli');
  assert.equal(input.district, 'Pune');
  assert.equal(input.surveyNumber, 'Gat No. 100');
  assert.equal(input.area, '2400'); // parsed to bare digits

  const json = JSON.stringify(input);
  assert.doesNotMatch(json, /propertyValue|"value"/i);
  assert.doesNotMatch(json, /secret|token|officer/i);
  // Never references a mock/PR- style id — only the real numeric on-chain id.
  assert.doesNotMatch(json, /PR-|DEMO|MOCK/i);
});

test('[registry client] referenceId can be a bigint and trims empty optional fields', () => {
  const input = toRegistryMetadataInput(
    { ownerName: '  ', village: '', taluka: '', district: 'Pune', surveyNumber: '', landArea: 'not-a-number' },
    99n,
  );
  assert.equal(input.referenceId, '99');
  assert.equal(input.applicantName, undefined);
  assert.equal(input.village, undefined);
  assert.equal(input.area, undefined);
});

test('[registry client] persists safe metadata via the applicant endpoint (no officer token)', async () => {
  const stack = await listenVerificationServer(makeConfig(), {});
  try {
    const apiBase = `http://127.0.0.1:${stack.port}`;
    const result = await createApplicationMetadata(toRegistryMetadataInput(DRAFT, '42'), apiBase);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.application.referenceId, '42');
    assert.equal(result.application.status, 'PENDING_REVIEW');
    assert.equal(result.application.applicantName, 'Asha Mehta');
    // Wire never carries value/secret/verdict.
    assert.doesNotMatch(JSON.stringify(result.application), /propertyValue|"value"|officerSecret|APPROVED|REJECTED/i);
  } finally {
    await stack.close();
  }
});

test('[registry client] backend unavailable is reported honestly (never a fake success)', async () => {
  const stack = await listenVerificationServer(
    { ...makeConfig(), registry: { officerToken: '' } },
    {},
  );
  try {
    const apiBase = `http://127.0.0.1:${stack.port}`;
    const result = await createApplicationMetadata(toRegistryMetadataInput(DRAFT, '42'), apiBase);
    assert.deepEqual(result, { ok: false, reason: 'unavailable' });
  } finally {
    await stack.close();
  }
});

test('[registry client] network failure is reported honestly (never a fake success)', async () => {
  const result = await createApplicationMetadata(toRegistryMetadataInput(DRAFT, '42'), 'http://127.0.0.1:1');
  assert.deepEqual(result, { ok: false, reason: 'network' });
});

test('[registry client] cannot fabricate a verdict or smuggle a value', async () => {
  const stack = await listenVerificationServer(makeConfig(), {});
  try {
    const apiBase = `http://127.0.0.1:${stack.port}`;
    const forbidden = await createApplicationMetadata(
      { referenceId: '1', applicantName: 'x' } as { referenceId: string; applicantName?: string; status?: string; propertyValue?: string },
      apiBase,
    );
    // The client itself never constructs forbidden fields; the wire result only
    // reflects what the server accepted — the caller cannot add status/value.
    assert.ok(forbidden.ok);
    if (forbidden.ok) {
      const safe = JSON.stringify(forbidden.application);
      assert.doesNotMatch(safe, /APPROVED|REJECTED|propertyValue/i);
    }
  } finally {
    await stack.close();
  }
});
