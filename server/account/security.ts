// PRIESTATE — Server-side account security helpers (password hashing + PII encryption).
//
// ⚠️ SERVER-SIDE ONLY. Runs inside the Node process; never bundled into the
// browser. Passwords are hashed with scrypt (a strong, memory-hard, salted KDF)
// and are NEVER recoverable. Retrievable PII is encrypted at rest with
// AES-256-GCM using a key derived from a server-only secret
// (ACCOUNT_ENC_SECRET). Nothing here ever writes to the Midnight ledger.

import {
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_LEN = 16;
const SCRYPT_N = 16384; // 2^14 — memory-hard cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/**
 * Hash a plaintext password using salted scrypt. The returned string is the
 * only thing we store — it encodes the salt, cost params and digest, but
 * cannot be reversed to the original password.
 */
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(SCRYPT_SALT_LEN).toString('hex');
  const digest = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString('hex');
  return { hash: digest, salt };
}

/**
 * Constant-time password verification against a stored scrypt digest+salt.
 * Returns false for any mismatch; never reveals why.
 */
export function verifyPassword(password: string, digestHex: string, saltHex: string): boolean {
  try {
    const expected = Buffer.from(digestHex, 'hex');
    const computed = scryptSync(password, saltHex, expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return expected.length === computed.length && timingSafeEqual(expected, computed);
  } catch {
    return false;
  }
}

// ─── PII encryption at rest (AES-256-GCM) ────────────────────────────

export interface EncipherSecret {
  readonly ok: boolean;
  readonly reason?: string;
  readonly key?: Buffer;
}

/**
 * Derive a 32-byte AES-256 key from the ACCOUNT_ENC_SECRET env value.
 * When unset/too short, `ok` is false so the account service can fail closed
 * (never silently persist plaintext PII).
 */
export function deriveEncryptionKey(rawSecret: string | undefined): EncipherSecret {
  if (!rawSecret || rawSecret.length < 16) {
    return { ok: false, reason: 'ACCOUNT_ENC_SECRET missing or shorter than 16 chars' };
  }
  // SHA-256 stretch so any-length secret maps to a fixed 32-byte key.
  const key = createHashSha256(rawSecret);
  return { ok: true, key };
}

/**
 * Derive the SEPARATE biometric reference key from ACCOUNT_BIOMETRIC_ENC_SECRET.
 *
 * Deliberately a DIFFERENT secret from `ACCOUNT_ENC_SECRET` (which protects
 * PII), so that a compromise of the PII key does not expose biometric
 * references and vice-versa (see Real-Identity-Verification plan §E2/G3). It
 * uses a distinct domain-separation prefix so even an identical raw secret
 * produces a different key from the PII key — never a shared key.
 */
export function deriveBiometricEncryptionKey(
  rawSecret: string | undefined,
): EncipherSecret {
  if (!rawSecret || rawSecret.length < 16) {
    return {
      ok: false,
      reason: 'ACCOUNT_BIOMETRIC_ENC_SECRET missing or shorter than 16 chars',
    };
  }
  const key = createHashSha256(`biometric-ref:v1:${rawSecret}`);
  return { ok: true, key };
}

function createHashSha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

const ENC_SEPARATOR = '$';

/** Encrypt a JSON-serializable value at rest. Returns "iv$tag$ciphertext" hex. */
export function encryptPII(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(ENC_SEPARATOR);
}

/** Decrypt a value produced by encryptPII. Returns null on any failure. */
export function decryptPII(key: Buffer, blob: string): unknown {
  try {
    const [ivHex, tagHex, encHex] = blob.split(ENC_SEPARATOR);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

// ─── Biometric reference at rest (AES-256-GCM, SEPARATE key) ────────
//
// The biometric reference is encrypted at rest with a DIFFERENT key from the
// PII key. We reuse the same GCM primitive but keep the calls separate and
// explicit so the key passed here is ALWAYS the biometric key (derived from
// ACCOUNT_BIOMETRIC_ENC_SECRET), never the PII key. This lets biometric
// material be rotated/re-encrypted independently on key change.

/**
 * Encrypt a biometric reference (JSON-serializable) at rest. Same wire format
 * as PII ("iv$tag$ciphertext" hex) but MUST be called with the biometric key.
 */
export function encryptBiometricReference(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(ENC_SEPARATOR);
}

/** Decrypt a biometric reference produced by encryptBiometricReference. */
export function decryptBiometricReference(key: Buffer, blob: string): unknown {
  return decryptPII(key, blob); // same GCM format; fail closed on any error
}
