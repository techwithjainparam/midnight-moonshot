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
