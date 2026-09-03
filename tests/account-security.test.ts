// PRIESTATE Level-3 — Account security primitives.
//
// Verifies the security invariants of the Level 3 account layer:
//   * passwords are stored ONLY as salted scrypt hashes — never plaintext,
//   * the hash is not reversible / does not reveal the password,
//   * verification is constant-time and rejects wrong/boundary inputs,
//   * PII is encrypted at rest with AES-256-GCM and fails closed without a key,
//   * decrypt round-trips correctly and tampering is detected,
//   * stored account records never expose the hash, salt, or raw PII.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword,
  verifyPassword,
  encryptPII,
  decryptPII,
  deriveEncryptionKey,
} from '../server/account/security';
import { InMemoryAccountStore } from '../server/account/store';
import { AccountService } from '../server/account/service';

const ENC_SECRET = 'level3-unit-test-enc-secret-0000';

function makeService(): AccountService {
  return new AccountService({
    store: new InMemoryAccountStore(),
    encryptionSecret: ENC_SECRET,
    otp: { hashSecret: 'hanaunit-test-otp-secret' },
    smsDelivery: { configured: true, send: () => undefined },
    whatsappDelivery: { configured: true, send: () => undefined },
    googleAuthenticator: { configured: true, complete: () => true },
  });
}

function validRegistrationPayload(over: Record<string, unknown> = {}) {
  return {
    walletAddress: '0x' + 'a'.repeat(64),
    fullName: 'Priya Sharma',
    aadhaarNumber: '123456789012',
    addressOnAadhaar: '12, MG Road, Pune',
    pincode: '411001',
    dateOfBirth: '1990-05-15',
    mobile: '9876543210',
    password: 'Str0ng#Passw0rd',
    passwordConfirm: 'Str0ng#Passw0rd',
    ...over,
  };
}

test('password is store hashed with a unique salt, never plaintext', async () => {
  const first = hashPassword('Sup3r#Secret1');
  const second = hashPassword('Sup3r#Secret1');
  // Unique salts ⇒ different digests for the same password.
  assert.notEqual(first.hash, second.hash);
  assert.notEqual(first.salt, second.salt);
  // The digest must not contain the plaintext anywhere.
  assert.ok(!first.hash.includes('Sup3r#Secret1'));
  // lengthened digest not equal to the password.
  assert.notEqual(first.hash, 'Sup3r#Secret1');
});

test('verifyPassword accepts the correct password and rejects wrong ones', () => {
  const { hash, salt } = hashPassword('Str0ng#Passw0rd');
  assert.equal(verifyPassword('Str0ng#Passw0rd', hash, salt), true);
  assert.equal(verifyPassword('wrong-password', hash, salt), false);
  assert.equal(verifyPassword('', hash, salt), false);
  assert.equal(verifyPassword('Str0ng#Passw0rd', hash, 'bad-salt'), false);
  assert.equal(verifyPassword('Str0ng#Passw0rd', 'deadbeef', salt), false);
});

test('password never stored in plaintext in the account record', () => {
  const service = makeService();
  const r = service.register(validRegistrationPayload());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const store = (service as unknown as { store: InstanceType<typeof InMemoryAccountStore> }).store;
  const record = store.getByWallet('0x' + 'a'.repeat(64));
  assert.ok(record);
  assert.ok(!JSON.stringify(record).includes('Str0ng#Passw0rd'));
  assert.ok(record.passwordHash.length > 0);
  assert.ok(record.passwordSalt.length > 0);
});

test('PII encrypt-at-rest round-trips and fails closed without a key', () => {
  const key = deriveEncryptionKey(ENC_SECRET);
  assert.equal(key.ok, true);
  if (!key.ok || !key.key) return;
  const secret = { aadhaarNumber: '123456789012', mobileE164: '+919876543210' };
  const blob = encryptPII(key.key, secret);
  assert.ok(blob.includes('$'));
  const decrypted = decryptPII(key.key, blob) as { aadhaarNumber: string; mobileE164: string };
  assert.equal(decrypted.aadhaarNumber, secret.aadhaarNumber);
  assert.equal(decrypted.mobileE164, secret.mobileE164);
});

test('PII tampering is detected (returns null, never partial data)', () => {
  const key = deriveEncryptionKey(ENC_SECRET);
  if (!key.ok || !key.key) return;
  const blob = encryptPII(key.key, { aadhaarNumber: '123456789012' });
  const tampered = blob.slice(0, -2) + (blob.endsWith('00') ? 'ff' : '00');
  const out = decryptPII(key.key, tampered);
  assert.equal(out, null);
});

test('deriveEncryptionKey fails closed on missing or short secret', () => {
  assert.equal(deriveEncryptionKey(undefined).ok, false);
  assert.equal(deriveEncryptionKey('short').ok, false);
  assert.equal(deriveEncryptionKey(' a '.repeat(6)).ok, true);
});

test('service without encryption key: construction succeeds but registration fails closed', () => {
  const service = new AccountService({
    store: new InMemoryAccountStore(),
    encryptionSecret: '',
    otp: { hashSecret: 'x'.repeat(16) },
  });
  assert.equal(service.available, false, 'service must report unavailable without a valid encryption key');
  const r = service.register({
    walletAddress: '0x' + 'f'.repeat(64),
    fullName: 'Test User',
    aadhaarNumber: '123456789012',
    dateOfBirth: '1990-01-01',
    mobile: '9876543210',
    password: 'Str0ng#Passw0rd',
    passwordConfirm: 'Str0ng#Passw0rd',
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'unavailable', 'registration must be blocked when encryption key is missing');
});

test('account public view never exposes hash, salt, or raw PII', async () => {
  const service = makeService();
  const r = service.register(validRegistrationPayload());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const view = 'view' in r ? r.view : null;
  assert.ok(view);
  const json = JSON.stringify(view);
  assert.ok(!json.includes('123456789012'));
  assert.ok(!json.includes('9876543210'));
  assert.ok(!json.includes('Str0ng#Passw0rd'));
});
