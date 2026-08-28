// PRIESTATE Level-2 PART 5 — Registry / officer backend tests.
//
// Covers:
//   * server-side registry metadata model + validation (rejects invalid input),
//   * server-side officer authorization boundary (unwanted officer rejected),
//   * client cannot fabricate APPROVED/REJECTED status or smuggle a verdict,
//   * property VALUE is never persisted or returned,
//   * secrets/tokens are never logged or exposed,
//   * public registry metadata is represented safely,
//   * backend status handling never contradicts on-chain state.
//
// Runs fully offline in-process (node:test + tsx + a real ephemeral HTTP
// server) — no network, wallet, proof server, or external infrastructure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  parseRegistryApplicationInput,
  toPublicRegistryMetadata,
  isValidReferenceId,
  REGISTRY_METADATA_STATUS,
  type RegistryApplicationMetadata,
} from '../server/registry/model';
import { InMemoryRegistryStore } from '../server/registry/store';
import { RegistryService } from '../server/registry/service';
import { loadConfig, type ServerConfig } from '../server/config';
import { listenVerificationServer } from '../server/index';

const OFFICER_TOKEN = 'official-officer-token-0123456789';

function makeConfig(over: { officerToken?: string } = {}): ServerConfig {
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
      timeoutMs: 1_000,
    },
    registry: {
      officerToken: over.officerToken ?? OFFICER_TOKEN,
    },
  };
}

async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body: (body ?? {}) as Record<string, unknown> };
}

const INGEST = '/api/v1/officer/applications';

// ═══════════════════════════════════════════════════════════════════
// MODEL — validation & privacy
// ═══════════════════════════════════════════════════════════════════

test('[registry] valid metadata intake passes validation', () => {
  const parsed = parseRegistryApplicationInput({
    referenceId: '42',
    applicantName: 'Asha Mehta',
    village: 'Khed',
    taluka: 'Haveli',
    district: 'Pune',
    surveyNumber: 'Gat No. 100',
    area: '2400',
  });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.input.referenceId, '42');
  assert.equal(parsed.input.applicantName, 'Asha Mehta');
  assert.equal(parsed.input.area, '2400');
});

test('[registry] invalid registration input is rejected', () => {
  // Missing / malformed reference id.
  assert.equal(parseRegistryApplicationInput({}).ok, false);
  assert.equal(parseRegistryApplicationInput({ referenceId: 'abc' }).ok, false);
  assert.equal(parseRegistryApplicationInput({ referenceId: '-5' }).ok, false);
  assert.equal(parseRegistryApplicationInput({ referenceId: '1'.repeat(21) }).ok, false);
  // Over-length or control-char metadata.
  assert.equal(parseRegistryApplicationInput({ referenceId: '7', applicantName: 'x'.repeat(201) }).ok, false);
  assert.equal(parseRegistryApplicationInput({ referenceId: '7', village: 'a\u0000b' }).ok, false);
  // Non-numeric area.
  assert.equal(parseRegistryApplicationInput({ referenceId: '7', area: 'not-a-number' }).ok, false);
  // Unknown fields are rejected (defense in depth).
  assert.equal(parseRegistryApplicationInput({ referenceId: '7', extra: 'x' }).ok, false);
  assert.equal(isValidReferenceId('0'), true);
  assert.equal(isValidReferenceId('00123'), true);
});

test('[registry] client cannot fabricate APPROVED/REJECTED status (forbidden fields rejected)', () => {
  for (const field of ['status', 'verdict', 'approved', 'rejected']) {
    const res = parseRegistryApplicationInput({ referenceId: '9', [field]: 'APPROVED' });
    assert.ok(!res.ok, `must reject field: ${field}`);
    if (!res.ok) assert.equal(res.reason, 'forbidden-field');
  }
});

test('[registry] property VALUE and secrets are never accepted from a client', () => {
  for (const field of [
    'propertyValue',
    'value',
    'amount',
    'applicantSecret',
    'applicantSecretKey',
    'officerSecret',
    'officerSecretKey',
    'secret',
    'aadhaarNumber',
  ]) {
    const res = parseRegistryApplicationInput({ referenceId: '9', [field]: '1200000' });
    assert.ok(!res.ok, `must reject field: ${field}`);
    if (!res.ok) assert.equal(res.reason, 'forbidden-field');
  }
});

test('[registry] the only allowed status is the lifecycle marker — never a chain verdict', () => {
  assert.equal(REGISTRY_METADATA_STATUS, 'PENDING_REVIEW');
  // The public type carries no APPROVED/REJECTED at all.
  assert.ok(!JSON.stringify(REGISTRY_METADATA_STATUS).match(/APPROVED|REJECTED/));
});

test('[registry] safe public projection contains no value/secrets/verdict', () => {
  const meta: RegistryApplicationMetadata = {
    id: 'app-1',
    referenceId: '42',
    applicantName: 'Asha',
    village: 'Khed',
    area: '2400',
    status: REGISTRY_METADATA_STATUS,
    createdAt: 0,
  };
  const safe = toPublicRegistryMetadata(meta);
  const json = JSON.stringify(safe);
  assert.doesNotMatch(json, /APPROVED|REJECTED/i);
  assert.doesNotMatch(json, /propertyValue|value/i);
  assert.doesNotMatch(json, /secret|token|key/i);
});

// ═══════════════════════════════════════════════════════════════════
// SERVICE — server-side officer boundary
// ═══════════════════════════════════════════════════════════════════

test('[registry service] unavailable (fail closed) when no officer token configured', () => {
  const svc = new RegistryService({ store: new InMemoryRegistryStore(), officerToken: '' });
  assert.equal(svc.available, false);
  assert.deepEqual(svc.ingest(OFFICER_TOKEN, { referenceId: '1' }), {
    ok: false,
    reason: 'unavailable',
  });
  assert.deepEqual(svc.list(OFFICER_TOKEN), { ok: false, reason: 'unavailable' });
  assert.deepEqual(svc.get(OFFICER_TOKEN, 'app-1'), { ok: false, reason: 'unavailable' });
});

test('[registry service] unauthorized officer is rejected at the server boundary', () => {
  const svc = new RegistryService({ store: new InMemoryRegistryStore(), officerToken: OFFICER_TOKEN });
  assert.equal(svc.available, true);
  // No token.
  assert.deepEqual(svc.ingest(undefined, { referenceId: '1' }), { ok: false, reason: 'unauthorized' });
  // Wrong token.
  assert.deepEqual(svc.ingest('wrong-token', { referenceId: '1' }), { ok: false, reason: 'unauthorized' });
  assert.deepEqual(svc.list('wrong-token'), { ok: false, reason: 'unauthorized' });
  assert.deepEqual(svc.get('wrong-token', 'app-1'), { ok: false, reason: 'unauthorized' });
});

test('[registry service] authorized officer can catalogue metadata (no verdict stored)', () => {
  const store = new InMemoryRegistryStore();
  const svc = new RegistryService({ store, officerToken: OFFICER_TOKEN });

  const created = svc.ingest(OFFICER_TOKEN, { referenceId: '42', applicantName: 'Asha', area: '2400' });
  assert.ok(created.ok);
  if (!created.ok || !('item' in created)) return;
  assert.equal(created.item.referenceId, '42');
  assert.equal(created.item.status, 'PENDING_REVIEW');
  assert.equal(typeof created.item.id, 'string');

  const listed = svc.list(OFFICER_TOKEN);
  assert.ok(listed.ok && 'items' in listed);
  if (!(listed.ok && 'items' in listed)) return;
  assert.equal(listed.items.length, 1);

  const got = svc.get(OFFICER_TOKEN, created.item.id);
  assert.ok(got.ok && 'item' in got);
  if (!(got.ok && 'item' in got)) return;
  assert.equal(got.item.referenceId, '42');

  // Invalid input from an authorized officer is still rejected.
  assert.deepEqual(svc.ingest(OFFICER_TOKEN, { referenceId: 'nope' }), { ok: false, reason: 'invalid-input' });
  assert.deepEqual(svc.ingest(OFFICER_TOKEN, { referenceId: '1', status: 'APPROVED' }), { ok: false, reason: 'forbidden-field' });

  // Metadata records never carry an on-chain verdict.
  const serialized = JSON.stringify(store.list());
  assert.doesNotMatch(serialized, /APPROVED|REJECTED/i);
  assert.doesNotMatch(serialized, /propertyValue/i);
});

// ═══════════════════════════════════════════════════════════════════
// SERVICE — applicant metadata intake (Part 6)
// ═══════════════════════════════════════════════════════════════════

const APPLICANT_INGEST = '/api/v1/applications';

test('[registry applicant] intake works through the applicant path (no officer token, real referenceId)', () => {
  const store = new InMemoryRegistryStore();
  const svc = new RegistryService({ store, officerToken: OFFICER_TOKEN });
  const created = svc.ingestApplicant({ referenceId: '42', applicantName: 'Asha Mehta', area: '2400' });
  // Succeeds WITHOUT an officer credential.
  assert.ok(created.ok);
  if (!(created.ok && 'item' in created)) return;
  // Stored metadata references the real on-chain registration id.
  assert.equal(created.item.referenceId, '42');
  assert.equal(created.item.status, REGISTRY_METADATA_STATUS);
  assert.equal(typeof created.item.id, 'string');
  // The record is present in the shared store (single registry backend).
  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].referenceId, '42');
});

test('[registry applicant] intake does NOT require the officer credential', () => {
  const svc = new RegistryService({ store: new InMemoryRegistryStore(), officerToken: OFFICER_TOKEN });
  assert.equal(svc.available, true);
  const created = svc.ingestApplicant({ referenceId: '7' });
  assert.ok(created.ok);
  // But the applicant still cannot read the catalog (still officer-guarded).
  assert.deepEqual(svc.list(undefined as unknown as string), { ok: false, reason: 'unauthorized' });
  assert.deepEqual(svc.get(undefined as unknown as string, 'app-1'), { ok: false, reason: 'unauthorized' });
});

test('[registry applicant] forbidden fields (property VALUE / secrets / verdict) are rejected', () => {
  const svc = new RegistryService({ store: new InMemoryRegistryStore(), officerToken: OFFICER_TOKEN });
  for (const field of [
    'status', 'verdict', 'approved', 'rejected',
    'propertyValue', 'value', 'amount',
    'applicantSecret', 'applicantSecretKey', 'officerSecret', 'officerSecretKey', 'secret',
    'aadhaarNumber',
  ]) {
    assert.deepEqual(
      svc.ingestApplicant({ referenceId: '9', [field]: '1200000' }),
      { ok: false, reason: 'forbidden-field' },
      `must reject field: ${field}`,
    );
  }
});

test('[registry applicant] invalid / malformed metadata is rejected', () => {
  const svc = new RegistryService({ store: new InMemoryRegistryStore(), officerToken: OFFICER_TOKEN });
  assert.deepEqual(svc.ingestApplicant({}), { ok: false, reason: 'invalid-input' });
  assert.deepEqual(svc.ingestApplicant({ referenceId: 'abc' }), { ok: false, reason: 'invalid-input' });
  assert.deepEqual(svc.ingestApplicant({ referenceId: 'PR-MOCK' }), { ok: false, reason: 'invalid-input' });
  assert.deepEqual(svc.ingestApplicant({ referenceId: '1', extra: 'x' }), { ok: false, reason: 'invalid-input' });
  assert.deepEqual(svc.ingestApplicant({ referenceId: '1', area: 'not-a-number' }), { ok: false, reason: 'invalid-input' });
});

test('[registry applicant] intake fails closed (unavailable) when the registry is not configured', () => {
  const svc = new RegistryService({ store: new InMemoryRegistryStore(), officerToken: '' });
  assert.equal(svc.available, false);
  assert.deepEqual(svc.ingestApplicant({ referenceId: '1' }), { ok: false, reason: 'unavailable' });
});

// ═══════════════════════════════════════════════════════════════════
// HTTP end-to-end
// ═══════════════════════════════════════════════════════════════════

test('[registry http] health reports the registry capability', async () => {
  const stack = await listenVerificationServer(makeConfig(), {});
  try {
    const health = await getJson(`http://127.0.0.1:${stack.port}/api/health`);
    const capabilities = health.body.capabilities as Record<string, unknown>;
    assert.equal(capabilities.registry, true);
  } finally {
    await stack.close();
  }
});

test('[registry http] unavailable (503) when the officer token is not configured', async () => {
  const stack = await listenVerificationServer(makeConfig({ officerToken: '' }), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const res = await getJson(`${base}${INGEST}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId: '1' }),
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.reason, 'unavailable');
  } finally {
    await stack.close();
  }
});

test('[registry http] unauthorized officer requests are rejected (401)', async () => {
  const stack = await listenVerificationServer(makeConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const body = JSON.stringify({ referenceId: '1', applicantName: 'Asha' });

    // Missing token.
    const noAuth = await getJson(`${base}${INGEST}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.body.reason, 'unauthorized');

    // Wrong token.
    const badAuth = await getJson(`${base}${INGEST}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body,
    });
    assert.equal(badAuth.status, 401);
    assert.equal(badAuth.body.reason, 'unauthorized');

    // List guarded too.
    const list = await getJson(`${base}${INGEST}`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(list.status, 401);
  } finally {
    await stack.close();
  }
});

test('[registry http] authorized officer flow: ingest → list → get (no verdict/value)', async () => {
  const stack = await listenVerificationServer(makeConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const auth = { Authorization: `Bearer ${OFFICER_TOKEN}` };

    const create = await getJson(`${base}${INGEST}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ referenceId: '42', applicantName: 'Asha Mehta', district: 'Pune', area: '2400' }),
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.ok, true);
    const application = create.body.application as Record<string, unknown>;
    assert.equal(application.referenceId, '42');
    assert.equal(application.status, 'PENDING_REVIEW');
    assert.equal(typeof application.id, 'string');

    const list = await getJson(`${base}${INGEST}`, { headers: auth });
    assert.equal(list.status, 200);
    const applications = (list.body.applications ?? []) as Array<Record<string, unknown>>;
    assert.equal(applications.length, 1);

    const get = await getJson(`${base}${INGEST}/${encodeURIComponent(String(application.id))}`, { headers: auth });
    assert.equal(get.status, 200);
    assert.equal((get.body.application as Record<string, unknown>).referenceId, '42');

    // Serialized wire responses carry no property value / secret / verdict.
    const wire = JSON.stringify(create.body) + JSON.stringify(list.body) + JSON.stringify(get.body);
    assert.doesNotMatch(wire, /propertyValue|"value"|officerSecret|applicantSecret|APPROVED|REJECTED/i);
  } finally {
    await stack.close();
  }
});

test('[registry http] client cannot fabricate a verdict via HTTP', async () => {
  const stack = await listenVerificationServer(makeConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const auth = { Authorization: `Bearer ${OFFICER_TOKEN}` };

    for (const payload of [
      { referenceId: '1', status: 'APPROVED' },
      { referenceId: '1', verdict: 'REJECTED' },
      { referenceId: '1', approved: true },
    ]) {
      const res = await getJson(`${base}${INGEST}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400, `must reject ${JSON.stringify(payload)}`);
      assert.equal(res.body.reason, 'forbidden-field');
    }
  } finally {
    await stack.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// HTTP — applicant metadata endpoint (Part 6)
// ═══════════════════════════════════════════════════════════════════

test('[registry http] applicant can persist metadata WITHOUT the officer token', async () => {
  const stack = await listenVerificationServer(makeConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    // NO Authorization header at all — the applicant boundary requires none.
    const res = await getJson(`${base}${APPLICANT_INGEST}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId: '42', applicantName: 'Asha Mehta', district: 'Pune', area: '2400' }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    const application = res.body.application as Record<string, unknown>;
    assert.equal(application.referenceId, '42');
    assert.equal(application.status, 'PENDING_REVIEW');
    assert.equal(application.applicantName, 'Asha Mehta');
    assert.equal(typeof application.id, 'string');
    assert.equal(typeof application.createdAt, 'number');
    // Wire response never carries property value / secret / verdict.
    assert.doesNotMatch(JSON.stringify(res.body), /propertyValue|"value"|officerSecret|applicantSecret|APPROVED|REJECTED/i);
  } finally {
    await stack.close();
  }
});

test('[registry http] applicant endpoint rejects invalid input', async () => {
  const stack = await listenVerificationServer(makeConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    for (const payload of [
      {},
      { referenceId: 'abc' },
      { referenceId: 'PR-MOCK' },
      { referenceId: '1', extra: 'x' },
      { referenceId: '1', area: 'not-a-number' },
    ]) {
      const res = await getJson(`${base}${APPLICANT_INGEST}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400, `must reject ${JSON.stringify(payload)}`);
      assert.equal(res.body.reason, 'invalid-input');
    }
  } finally {
    await stack.close();
  }
});

test('[registry http] applicant endpoint rejects forbidden fields (value / secrets / verdict)', async () => {
  const stack = await listenVerificationServer(makeConfig(), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    for (const payload of [
      { referenceId: '1', status: 'APPROVED' },
      { referenceId: '1', verdict: 'REJECTED' },
      { referenceId: '1', propertyValue: '1200000' },
      { referenceId: '1', applicantSecret: '0xaa' },
    ]) {
      const res = await getJson(`${base}${APPLICANT_INGEST}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400, `must reject ${JSON.stringify(payload)}`);
      assert.equal(res.body.reason, 'forbidden-field');
    }
  } finally {
    await stack.close();
  }
});

test('[registry http] applicant endpoint fails closed (503) when registry unconfigured', async () => {
  const stack = await listenVerificationServer(makeConfig({ officerToken: '' }), {});
  try {
    const base = `http://127.0.0.1:${stack.port}`;
    const res = await getJson(`${base}${APPLICANT_INGEST}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId: '1' }),
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.reason, 'unavailable');
  } finally {
    await stack.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// SECURITY invariants (source-level)
// ═══════════════════════════════════════════════════════════════════
const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

test('[registry security] the officer token is server-only — never a VITE_* var', () => {
  // loadConfig reads Registry token from a plain (non-VITE_) env var.
  const cfg = loadConfig({
    VITE_REGISTRY_OFFICER_API_TOKEN: 'browser-leaked-token',
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg.registry.officerToken, '', 'VITE_ prefixed token must be ignored');
  assert.ok(!JSON.stringify(cfg).includes('browser-leaked-token'));
});

test('[registry security] secrets/tokens are never logged or returned', () => {
  // Service never logs anything.
  const serviceSrc = src('server/registry/service.ts');
  assert.doesNotMatch(serviceSrc, /console\.|logger/);
  // The HTTP layer must not echo the bearer token in any response.
  const indexSrc = src('server/index.ts');
  assert.doesNotMatch(indexSrc, /sendJson\([^)]*token/);
  // The persist/return paths (store + service) must never reference the
  // confidential property-value or the on-chain officer secret witnesses.
  for (const rel of ['server/registry/store.ts', 'server/registry/service.ts']) {
    const content = src(rel);
    assert.doesNotMatch(content, /getOfficerSecretKey|setOfficerSecretKey|propertyValue|applicantSecret/i);
  }
  // model.ts legitimately lists those names INSIDE the FORBIDDEN_KEYS set so
  // they can be rejected — but only there, nowhere else.
  const modelSrc = src('server/registry/model.ts');
  const stripped = modelSrc.replace(/FORBIDDEN_KEYS = new Set\([\s\S]*?\n\]\);/, '');
  assert.doesNotMatch(stripped, /getOfficerSecretKey|setOfficerSecretKey|propertyValue|applicantSecret/i);
});

test('[registry security] no concrete officer token is committed anywhere in server/', () => {
  const serverRoot = fileURLToPath(new URL('../server', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(entry.name)) files.push(p);
    }
  };
  walk(serverRoot);
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    assert.ok(
      !/(REGISTRY_OFFICER_API_TOKEN=)[0-9a-f]{32,}/i.test(content),
      `${file} must not contain a concrete registry officer token`,
    );
  }
});
