// PRIESTATE Level-3 — Privacy invariants for the account layer.
//
// Guards the "never store / never expose sensitive PII" contract:
//   * the server account record holds ONLY a salted scrypt hash, an
//     AES-256-GCM ciphertext blob, and masked display fragments — never raw
//     Aadhaar / address / DOB / mobile / passport / selfie,
//   * the client account-store serializes NO raw PII and NO password,
//   * the demo selfie/reference images are never persisted or uploaded,
//   * the mobile carry-over URL carries no PII,
//   * the account layer produces NO on-chain payload text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { InMemoryAccountStore } from '../server/account/store';
import { AccountService } from '../server/account/service';
import {
  rejectIdentityEvidence,
  EVIDENCE_MAX_LOCATION_AGE_MS,
  EVIDENCE_MAX_ACCURACY_M,
  type IdentityEvidence,
} from '../server/account/model';
import { saveAccount, listAccounts } from '../src/auth/account-store';
import { createMobileSession, mobileSessionUrl } from '../src/verify/mobile-session';

const ENC = 'privacy-test-enc-secret';

function validPayload() {
  return {
    walletAddress: '0x' + 'e'.repeat(64),
    fullName: 'Rohan Verma',
    aadhaarNumber: '456789012345',
    addressOnAadhaar: '44, Inner Circle, Delhi',
    pincode: '110001',
    dateOfBirth: '1992-07-30',
    mobile: '9012345678',
    password: 'Pr1v#acy!23',
    passwordConfirm: 'Pr1v#acy!23',
  };
}

const RAW_PII = ['456789012345', '110001', '1992-07-30', '9012345678', 'Pr1v#acy!23'];

test('stored server record contains no raw PII or plaintext password', () => {
  const service = new AccountService({
    store: new InMemoryAccountStore(),
    encryptionSecret: ENC,
    otp: { hashSecret: 'privacy-otp-secret' },
    smsDelivery: { configured: true, send: () => undefined },
    whatsappDelivery: { configured: true, send: () => undefined },
    googleAuthenticator: { configured: true, complete: () => true },
  });
  const r = service.register(validPayload());
  assert.equal(r.ok, true);
  const store = (service as unknown as { store: InstanceType<typeof InMemoryAccountStore> }).store;
  const record = store.getByWallet('0x' + 'e'.repeat(64));
  assert.ok(record);
  const json = JSON.stringify(record);
  for (const pii of RAW_PII) {
    assert.ok(!json.includes(pii), `record must not contain raw PII: ${pii}`);
  }
  assert.ok(record.passwordHash.length > 0);
  assert.ok(record.piiCipherText.includes('$'));
});

test('client account-store serialization holds no raw PII or password', () => {
  const fakeStorage = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => fakeStorage.get(k) ?? null,
    setItem: (k: string, v: string) => { fakeStorage.set(k, v); },
    removeItem: (k: string) => { fakeStorage.delete(k); },
    clear: () => { fakeStorage.clear(); },
    key: () => null,
    length: fakeStorage.size,
  } as unknown as Storage;

  saveAccount({
    accountId: 'acct-1',
    status: 'registered',
    walletAddress: '0x' + 'e'.repeat(64),
    maskedMobile: '+91 90••••••78',
    maskedAadhaar: '•••• 2345',
    smsOtpVerified: false,
    whatsappOtpVerified: false,
    googleLinked: false,
    identityVerified: false,
    createdAt: 1,
    enrollmentState: 'not_enrolled',
  });
  const persisted = [...fakeStorage.values()].join('');
  for (const pii of RAW_PII) {
    assert.ok(!persisted.includes(pii), `client store must not contain raw PII: ${pii}`);
  }
  assert.ok(!persisted.includes('Pr1v#acy!23'));
  const accounts = listAccounts();
  assert.equal(accounts.length, 1);
});

test('mobile carry-over URL carries no PII', () => {
  const session = createMobileSession('0x' + 'e'.repeat(64));
  const url = mobileSessionUrl(session, 'http://localhost:3000');
  for (const pii of RAW_PII) {
    assert.ok(!url.includes(pii), `mobile URL must not contain raw PII: ${pii}`);
  }
  assert.ok(!url.includes('456789012345'));
});

test('identity layer never emits an on-chain payload (no ledger write surface)', () => {
  // The Level 3 client modules must reference no contract-submit surface.
  // It a raw PII ever leaked into a ledger payload this guard would trip.
  const dir = new URL('../src/', import.meta.url);
  const onChainKeywords = [
    'submitRegistration',
    'contractAddress',
    'deposit(_',
    'zkProof',
    'proof-server',
    'indexer',
  ];
  const modules = [
    'auth/account-types.ts',
    'auth/account-api.ts',
    'auth/account-store.ts',
    'verify/face-match.ts',
    'verify/mobile-session.ts',
    'verify/randomBytes.ts',
    'pages/UserRegistrationPage.tsx',
    'pages/LoginPage.tsx',
    'pages/IdentityVerificationPage.tsx',
  ];
  for (const rel of modules) {
    const url = new URL(rel, dir);
    const text = readFileSync(url, 'utf8');
    for (const kw of onChainKeywords) {
      assert.ok(
        !text.includes(kw),
        `${rel} must not reference an on-chain surface keyword: "${kw}"`,
      );
    }
  }
});

// ── Server-authoritative identity-evidence boundary (real liveness + location)

const NOW_EV = Date.now();

function validEvidence(overrides: Partial<IdentityEvidence> = {}): IdentityEvidence {
  return {
    context: 'registration',
    livenessPassed: true,
    location: {
      latitude: 12.9716,
      longitude: 77.5946,
      accuracyMeters: 20,
      timestampMs: NOW_EV,
      nonce: 'pvs-abcd',
    },
    ...overrides,
  };
}

function evidenceService() {
  return new AccountService({
    store: new InMemoryAccountStore(),
    encryptionSecret: ENC,
    otp: { hashSecret: 'privacy-otp-secret' },
    smsDelivery: { configured: true, send: () => undefined },
    whatsappDelivery: { configured: true, send: () => undefined },
    googleAuthenticator: { configured: true, complete: () => true },
  });
}

test('rejectIdentityEvidence accepts a fresh accurate valid combined report', () => {
  assert.equal(rejectIdentityEvidence(validEvidence(), NOW_EV), null);
});

test('rejectIdentityEvidence refuses a bare client boolean (no location)', () => {
  assert.equal(rejectIdentityEvidence(null, NOW_EV), 'missing');
  // A bare { confirmed: true }-style payload with no location field.
  assert.equal(
    rejectIdentityEvidence({ livenessPassed: true } as never, NOW_EV),
    'location_missing',
  );
});

test('rejectIdentityEvidence refuses a client self-asserted pass without real liveness', () => {
  assert.equal(
    rejectIdentityEvidence(validEvidence({ livenessPassed: false }), NOW_EV),
    'liveness_not_passed',
  );
});

test('rejectIdentityEvidence refuses stale / coarse / invalid / missing-location evidence', () => {
  assert.equal(
    rejectIdentityEvidence(
      validEvidence({ location: { ...validEvidence().location, timestampMs: NOW_EV - EVIDENCE_MAX_LOCATION_AGE_MS - 1 } }),
      NOW_EV,
    ),
    'location_stale',
  );
  assert.equal(
    rejectIdentityEvidence(
      validEvidence({ location: { ...validEvidence().location, accuracyMeters: EVIDENCE_MAX_ACCURACY_M + 1 } }),
      NOW_EV,
    ),
    'location_accuracy_insufficient',
  );
  assert.equal(
    rejectIdentityEvidence(
      validEvidence({ location: { ...validEvidence().location, latitude: 100 } }),
      NOW_EV,
    ),
    'location_invalid',
  );
  assert.equal(
    rejectIdentityEvidence(
      validEvidence({ location: { ...validEvidence().location, latitude: null } }),
      NOW_EV,
    ),
    'location_denied_unavailable',
  );
});

test('recordIdentityEvidence accepts only validated evidence and stores no raw coords', () => {
  const service = evidenceService();
  const addr = '0x' + 'b'.repeat(64);
  const rr = service.register({ ...validPayload(), walletAddress: addr });
  assert.equal(rr.ok, true);
  const ok = service.recordIdentityEvidence(addr, validEvidence());
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.accepted, true);
  const store = (service as unknown as { store: InstanceType<typeof InMemoryAccountStore> }).store;
  const json = JSON.stringify(store.getByWallet(addr));
  // Raw coordinates, nonce, and accuracy must NEVER be persisted to the record.
  assert.ok(!json.includes('77.5946'), 'record must not contain longitude');
  assert.ok(!json.includes('12.9716'), 'record must not contain latitude');
  assert.ok(!json.includes('pvs-abcd'), 'record must not contain the location nonce');
});

test('recordIdentityEvidence fails closed on a bare boolean', () => {
  const service = evidenceService();
  const addr = '0x' + 'b'.repeat(64);
  const rr = service.register({ ...validPayload(), walletAddress: addr });
  assert.equal(rr.ok, true);
  const r = service.recordIdentityEvidence(addr, null);
  assert.deepEqual(r, { ok: false, reason: 'identity-evidence-rejected' });
});

test('Part 7 liveness/location modules never persist raw frames, landmarks, or coords', () => {
  // The new real-liveness + live-location modules must not reference any
  // on-ledger, localStorage, URL, or logging surface for their sensitive data.
  const dir = new URL('../src/liveness/', import.meta.url);
  const forbidden = [
    'localStorage',
    'navigator.clipboard',
    'window.location.href',
    'contractAddress',
    'zkProof',
    'proof-server',
    'indexer',
    'toJSON',
  ];
  for (const rel of ['landmark.ts', 'landmark-verifier.ts', 'location.ts', 'location-watcher.ts', 'landmark-provider.ts']) {
    const text = readFileSync(new URL(rel, dir), 'utf8');
    for (const kw of forbidden) {
      assert.ok(
        !text.includes(kw),
        `${rel} must not reference sensitive persistence/logging surface: "${kw}"`,
      );
    }
  }
});
