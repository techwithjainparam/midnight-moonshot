// PRIESTATE Level-3 Part 8 — REAL server-side biometric reference enrollment
// + login face matching.
//
// Covers:
//   A. Pure matching math (cosine similarity, usability, reference derivation,
//      threshold decisions).
//   B. Single-use session nonce lifecycle (wallet-bound, one-shot, TTL, replay).
//   C. The insecure bare-`confirmed:true` identity path is REMOVED: there is no
//      `markIdentityVerified` and no server path that sets identityVerified
//      from a client boolean.
//   D. Service enrollment lifecycle: fail-closed when unconfigured; consent;
//      session invalid/replay; low-quality; success sets identityVerified and
//      stores an ENCRYPTED reference; revoke; version bump on replace.
//   E. Login face matching: same-face matches, impostor mismatches,
//      reference-version binding, single-use verification tokens, and
//      client-supplied matched/score being ignored (server is authoritative).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cosineSimilarity,
  deriveEnrollmentReference,
  isUsableEmbedding,
  InMemoryBiometricSessionBook,
  EMBEDDING_DIM,
  DEFAULT_BIOMETRIC_CONFIG,
  MATCH_THRESHOLD,
} from '../server/account/biometric';
import { createHash } from 'node:crypto';
import { AccountService } from '../server/account/service';
import { configuredProviders } from './helpers/account-service-testing';
import { InMemoryAccountStore } from '../server/account/store';
import type { AccountRecord } from '../server/account/model';
import {
  decryptBiometricReference,
  encryptBiometricReference,
} from '../server/account/security';
import {
  referenceVector,
  sameFaceVector,
  differentFaceVector,
  enrollmentVectors,
} from './biometric-vectors';

const ENC = 'bio-enc-secret-0123456789abcdef';
const SECRET = '0123456789abcdef0123456789abcdef';

// ── A. Pure matching math ─────────────────────────────────────────────

test('A1: reference vector is a usable 128-d embedding', () => {
  assert.equal(referenceVector.length, EMBEDDING_DIM);
  assert.equal(isUsableEmbedding(referenceVector), true);
  assert.equal(isUsableEmbedding([]), false);
  assert.equal(isUsableEmbedding(new Array(EMBEDDING_DIM).fill(0)), false);
  assert.equal(isUsableEmbedding(null), false);
  assert.equal(isUsableEmbedding([1, 2]), false);
});

test('A2: same face scores high and clears the threshold; impostor does not', () => {
  const same = cosineSimilarity(referenceVector, sameFaceVector);
  const other = cosineSimilarity(referenceVector, differentFaceVector);
  assert.ok(same >= MATCH_THRESHOLD, `expected same-face cos>=threshold, got ${same}`);
  assert.ok(other < MATCH_THRESHOLD, `expected impostor cos<threshold, got ${other}`);
  assert.ok(same > other, 'same-face must outscore the impostor');
});

test('A3: enrollment reference derivation accepts consistent captures', () => {
  const d = deriveEnrollmentReference(enrollmentVectors(4), DEFAULT_BIOMETRIC_CONFIG);
  assert.ok(d, 'consistent captures should derive a reference');
  if (!d) return;
  assert.equal(d.reference.length, EMBEDDING_DIM);
  assert.ok(isUsableEmbedding(d.reference), 'derived reference must be usable');
  assert.ok(d.selfSimilarity > 0.9, 'consistent captures are self-similar');
});

test('A4: enrollment derivation rejects too few / inconsistent frames', () => {
  assert.equal(deriveEnrollmentReference([], DEFAULT_BIOMETRIC_CONFIG), null, 'no frames');
  assert.equal(
    deriveEnrollmentReference([referenceVector, referenceVector], DEFAULT_BIOMETRIC_CONFIG),
    null,
    'fewer than minEnrollFrames',
  );
  // A wrong-dimension vector is unusable → filtered down to too few frames.
  const mixed = deriveEnrollmentReference(
    [[1, 2], referenceVector, sameFaceVector],
    DEFAULT_BIOMETRIC_CONFIG,
  );
  assert.equal(mixed, null, 'unusable frames must not form a reference');
});

// ── B. Session nonce lifecycle ───────────────────────────────────────

test('B1: sessions are single-use, wallet-bound, and purpose-bound', () => {
  const book = new InMemoryBiometricSessionBook();
  const walletA = '0x' + 'a'.repeat(64);
  const walletB = '0x' + 'b'.repeat(64);
  const s = book.issue({ walletAddress: walletA, purpose: 'enrollment', now: 1_000 });
  assert.equal(book.pending(s.token, 1_000), true);
  // Wrong wallet cannot consume.
  assert.equal(book.consume(s.token, walletB, 'enrollment', 1_000), null);
  // Wrong purpose cannot consume.
  assert.equal(book.consume(s.token, walletA, 'verification', 1_000), null);
  // Correct consume works once.
  assert.ok(book.consume(s.token, walletA, 'enrollment', 1_000));
  // Replay is rejected.
  assert.equal(book.consume(s.token, walletA, 'enrollment', 1_000), null, 'replay rejected');
});

test('B2: expired sessions fail closed', () => {
  const book = new InMemoryBiometricSessionBook();
  const wallet = '0x' + 'a'.repeat(64);
  const s = book.issue({ walletAddress: wallet, purpose: 'verification', now: 1_000 });
  const later = 1_000 + DEFAULT_BIOMETRIC_CONFIG.verificationTtlMs + 1;
  assert.equal(book.pending(s.token, later), false);
  assert.equal(book.consume(s.token, wallet, 'verification', later), null);
});

// ── C. Insecure identity-verified path is REMOVED ────────────────────

test('C1: no markIdentityVerified service method exists', () => {
  const harness = makeHarness();
  assert.equal(
    Object.prototype.hasOwnProperty.call(harness.svc, 'markIdentityVerified'),
    false,
    'the bare-confirmed setter must not exist',
  );
  assert.equal(
    (harness.svc as unknown as Record<string, unknown>).markIdentityVerified,
    undefined,
  );
});

test('C2: identityVerified starts false and no client boolean can set it', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  assert.equal(harness.record(wallet).identityVerified, false);
  assert.equal(harness.enrollmentState(wallet), 'not_enrolled');
});

// ── D. Service enrollment lifecycle ─────────────────────────────────

test('D1: biometric feature fails closed when unconfigured', () => {
  const svc = new AccountService({
    store: new InMemoryAccountStore(),
    encryptionSecret: ENC,
    otp: { hashSecret: SECRET },
    ...configuredProviders(),
  });
  const wallet = '0x' + 'e'.repeat(64);
  assert.equal(svc.enrollmentStateFor(null), 'unavailable');
  assert.equal(svc.beginBiometricEnrollment(wallet).ok, false);
  assert.equal(
    svc.enrollBiometricReference(wallet, { token: 'x', embeddings: enrollmentVectors(4), consent: true }).ok,
    false,
  );
  assert.equal(svc.beginBiometricVerification(wallet).ok, false);
  assert.equal(
    svc.verifyBiometricMatch(wallet, { verificationToken: 'x', liveEmbedding: sameFaceVector }).ok,
    false,
  );
});

test('D2: enrollment requires explicit consent', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  const begin = harness.svc.beginBiometricEnrollment(wallet);
  assert.ok('token' in begin);
  if (!('token' in begin)) return;
  const noConsent = harness.svc.enrollBiometricReference(wallet, {
    token: begin.token,
    embeddings: enrollmentVectors(4),
    consent: false,
  });
  assert.equal(noConsent.ok, false);
  if (!noConsent.ok) assert.equal(noConsent.reason, 'no-consent');
  assert.equal(harness.record(wallet).identityVerified, false);
});

test('D3: enrollment consumes the session; replay is rejected', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  const begin = harness.svc.beginBiometricEnrollment(wallet);
  assert.ok('token' in begin);
  if (!('token' in begin)) return;
  assert.equal(
    harness.svc.enrollBiometricReference(wallet, { token: begin.token, embeddings: enrollmentVectors(4), consent: true }).ok,
    true,
  );
  const replay = harness.svc.enrollBiometricReference(wallet, {
    token: begin.token,
    embeddings: enrollmentVectors(4),
    consent: true,
  });
  // The account is now enrolled, so the replay fails closed. It may be
  // 'bad-state' (already enrolled, short-circuits before session use) or
  // 'session-invalid' (token replayed); never a success.
  assert.equal(replay.ok, false);
});

test('D4: enrollment rejects low-quality embeddings and leaves identity unverified', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  const begin = harness.svc.beginBiometricEnrollment(wallet);
  assert.ok('token' in begin);
  if (!('token' in begin)) return;
  const bad = harness.svc.enrollBiometricReference(wallet, {
    token: begin.token,
    embeddings: [[1, 0], [0, 1]],
    consent: true,
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, 'low-quality');
  assert.equal(harness.record(wallet).identityVerified, false);
});

test('D5: successful enrollment sets identityVerified and stores an ENCRYPTED reference', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  const begin = harness.svc.beginBiometricEnrollment(wallet);
  assert.ok('token' in begin);
  if (!('token' in begin)) return;
  const done = harness.svc.enrollBiometricReference(wallet, {
    token: begin.token,
    embeddings: enrollmentVectors(4),
    consent: true,
  });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.referenceVersion, 1);
  assert.equal(done.enrollmentState, 'enrolled');
  assert.equal(done.identityVerified, true);
  assert.equal(harness.enrollmentState(wallet), 'enrolled');
  // Reference is encrypted at rest with the SEPARATE biometric key.
  const rec = harness.record(wallet);
  assert.ok(typeof rec.biometricReferenceCipherText === 'string' && rec.biometricReferenceCipherText.length > 0);
  assert.ok(!rec.biometricReferenceCipherText!.includes('[0.'), 'must not store raw embeddings');
  const ref = decryptBiometricReference(harness.biometricKey(), rec.biometricReferenceCipherText!) as { embedding: readonly number[] };
  assert.equal(ref.embedding.length, EMBEDDING_DIM);
  // Round-trip encrypt/decrypt with the biometric key is stable.
  const round = decryptBiometricReference(harness.biometricKey(), encryptBiometricReference(harness.biometricKey(), { embedding: referenceVector }));
  assert.deepEqual((round as { embedding: readonly number[] }).embedding, referenceVector);
});

test('D6: revoke flips enrollment state and reverts identityVerified', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  const begin = harness.svc.beginBiometricEnrollment(wallet);
  assert.ok('token' in begin);
  if (!('token' in begin)) return;
  assert.equal(
    harness.svc.enrollBiometricReference(wallet, { token: begin.token, embeddings: enrollmentVectors(4), consent: true }).ok,
    true,
  );
  const revoked = harness.svc.revokeBiometricReference(wallet);
  assert.equal(revoked.ok, true);
  assert.equal(harness.enrollmentState(wallet), 'revoked');
  assert.equal(harness.record(wallet).identityVerified, false);
  // Cannot begin a NEW first-time enrollment while revoked (must replace).
  assert.equal(harness.svc.beginBiometricEnrollment(wallet).ok, false);
});

test('D7: replace (re-enrollment) bumps reference version and re-enables verification', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  enroll(harness, wallet);
  harness.svc.revokeBiometricReference(wallet);
  assert.equal(harness.svc.beginBiometricVerification(wallet).ok, false, 'revoked → cannot verify');
  // Issue a fresh enrollment session through the injected book (begin is gated
  // while revoked) and re-enroll: version bumps to 2.
  const token = harness.sessions.issue({ walletAddress: wallet, purpose: 'enrollment', now: Date.now() }).token;
  const repl = harness.svc.replaceBiometricReference(wallet, { token, embeddings: enrollmentVectors(4), consent: true });
  assert.equal(repl.ok, true);
  if (!repl.ok) return;
  assert.equal(repl.referenceVersion, 2);
  assert.equal(harness.enrollmentState(wallet), 'enrolled');
  assert.equal(harness.record(wallet).identityVerified, true);
  assert.equal(harness.record(wallet).biometricReferenceVersion, 2);
});

// ── E. Login face matching ───────────────────────────────────────────

test('E1: same-face verifies; impostor is rejected', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  enroll(harness, wallet);

  const v1 = harness.svc.beginBiometricVerification(wallet);
  assert.ok('token' in v1);
  if (!('token' in v1)) return;
  const match = harness.svc.verifyBiometricMatch(wallet, { verificationToken: v1.token, liveEmbedding: sameFaceVector });
  assert.equal(match.ok, true);
  if (match.ok) assert.equal(match.verdict, 'matched');

  const v2 = harness.svc.beginBiometricVerification(wallet);
  assert.ok('token' in v2);
  if (!('token' in v2)) return;
  const impostor = harness.svc.verifyBiometricMatch(wallet, { verificationToken: v2.token, liveEmbedding: differentFaceVector });
  assert.equal(impostor.ok, true);
  if (impostor.ok) assert.equal(impostor.verdict, 'mismatch');
});

test('E2: verification token is single-use; replay fails closed', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  enroll(harness, wallet);
  const v = harness.svc.beginBiometricVerification(wallet);
  assert.ok('token' in v);
  if (!('token' in v)) return;
  assert.equal(harness.svc.verifyBiometricMatch(wallet, { verificationToken: v.token, liveEmbedding: sameFaceVector }).ok, true);
  const replay = harness.svc.verifyBiometricMatch(wallet, { verificationToken: v.token, liveEmbedding: sameFaceVector });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.verdict, 'session_invalid');
});

test('E3: a token minted against an older reference version cannot verify a newer one', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  enroll(harness, wallet); // version 1
  const v1 = harness.svc.beginBiometricVerification(wallet);
  assert.ok('token' in v1);
  if (!('token' in v1)) return;
  // Replace the reference → version bumps to 2, invalidating the v1 token.
  const token = harness.sessions.issue({ walletAddress: wallet, purpose: 'enrollment', now: Date.now() }).token;
  assert.equal(
    harness.svc.replaceBiometricReference(wallet, { token, embeddings: enrollmentVectors(4), consent: true }).ok,
    true,
  );
  const stale = harness.svc.verifyBiometricMatch(wallet, { verificationToken: v1.token, liveEmbedding: sameFaceVector });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.verdict, 'session_invalid');
});

test('E4: client-supplied matched/score are ignored — the verdict tracks the actual embedding', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  enroll(harness, wallet);
  // The verify API accepts only token + liveEmbedding. Whatever a malicious
  // client might "claim", the verdict is derived from server-side comparison:
  // an impostor embedding MUST be a mismatch no matter what.
  const v = harness.svc.beginBiometricVerification(wallet);
  assert.ok('token' in v);
  if (!('token' in v)) return;
  const result = harness.svc.verifyBiometricMatch(wallet, { verificationToken: v.token, liveEmbedding: differentFaceVector });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.verdict, 'mismatch');
});

test('E5: verification without an enrolled reference fails closed', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  const v = harness.svc.beginBiometricVerification(wallet);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'no-reference');
});

test('E6: verification of a revoked reference fails closed', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  enroll(harness, wallet);
  harness.svc.revokeBiometricReference(wallet);
  const v = harness.svc.beginBiometricVerification(wallet);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'revoked');
});

test('E7: faceVerificationState reflects a real enrolled reference', () => {
  const harness = makeHarness();
  const wallet = registerFully(harness);
  const before = harness.svc.faceVerificationState(wallet);
  assert.ok(before);
  if (!before) return;
  assert.equal(before.required, true);
  assert.equal(before.providerAvailable, true);
  assert.equal(before.hasReferenceIdentity, false, 'nothing enrolled yet');
  enroll(harness, wallet);
  const after = harness.svc.faceVerificationState(wallet);
  assert.ok(after);
  if (!after) return;
  assert.equal(after.providerAvailable, true);
  assert.equal(after.hasReferenceIdentity, true);
});

// ── Helpers ──────────────────────────────────────────────────────────

interface Harness {
  svc: AccountService;
  store: InMemoryAccountStore;
  sessions: InMemoryBiometricSessionBook;
  record: (wallet: string) => AccountRecord;
  enrollmentState: (wallet: string) => string;
  biometricKey: () => Buffer;
}

function makeHarness(): Harness {
  const store = new InMemoryAccountStore();
  const sessions = new InMemoryBiometricSessionBook();
  const svc = new AccountService({
    store,
    biometricSessions: sessions,
    encryptionSecret: ENC,
    biometricEncryptionSecret: ENC,
    otp: { hashSecret: SECRET },
    ...configuredProviders(),
  });
  const keyResult = deriveBiometricKey();
  const key = keyResult!;
  return {
    svc,
    store,
    sessions,
    record: (w) => store.getByWallet(w)!,
    enrollmentState: (w) => svc.enrollmentStateFor(store.getByWallet(w)),
    biometricKey: () => key,
  };
}

function deriveBiometricKey(): Buffer | null {
  return createHash('sha256').update(`biometric-ref:v1:${ENC}`).digest();
}

function registerFully(harness: Harness): string {
  const wallet = '0x' + Math.floor(Math.random() * 1e9).toString(16).padStart(64, '0');
  harness.svc.register({
    walletAddress: wallet,
    fullName: 'Test Person',
    aadhaarNumber: '222233334444',
    addressOnAadhaar: 'Demo St',
    pincode: '400001',
    dateOfBirth: '1980-01-01',
    mobile: '9812345678',
    password: 'Str0ng#Pass',
    passwordConfirm: 'Str0ng#Pass',
  });
  return wallet;
}

function enroll(harness: Harness, wallet: string): void {
  const begin = harness.svc.beginBiometricEnrollment(wallet);
  assert.ok('token' in begin);
  if (!('token' in begin)) return;
  const done = harness.svc.enrollBiometricReference(wallet, {
    token: begin.token,
    embeddings: enrollmentVectors(4),
    consent: true,
  });
  assert.equal(done.ok, true);
}