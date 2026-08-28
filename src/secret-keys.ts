/**
 * Source of the 32-byte identity SECRET keys fed to the PRIESTATE circuits
 * as witnesses.
 *
 * The PRIESTATE registration circuits each need a private 32-byte key:
 *
 *   - `applicantSecretKey`  — derives the OWNER binding disclosed when a
 *                             registration is submitted.
 *   - `officerSecretKey`    — derives the DApp public key that approve/reject
 *                             circuits assert equals the designated officer
 *                             public key sealed at deploy.
 *
 * The connected wallet connector exposes NO raw signing secret, so (for this
 * DEMO) the secrets are sourced from environment configuration, mirroring how
 * the deploy script already takes the designated officer public key.
 *
 * ⚠️ DEMO ONLY — NOT real credential management.
 *   * These are DEMO secrets compiled into the browser bundle. Real
 *     deployments must source them from proper key management.
 *   * Officer authorization is NOT bypassed: approve/reject are still gated
 *     on-chain by the circuit (the derived public key must equal the sealed
 *     `officer`). If `VITE_PRIESTATE_OFFICER_SECRET` does not match the
 *     officer public key configured at deploy (`--officer`), the transaction
 *     is rejected on-chain.
 */

/** 32-byte all-zero demo fallback (no real secret derives to it). */
const ZERO = new Uint8Array(32);

/**
 * Parse a 64-hex-char string into a 32-byte value, or fall back to the given
 * default when unset. Throws on malformed input so misconfiguration is loud.
 */
export function parseSecret(raw: string | undefined, fallback: Uint8Array, name: string): Uint8Array {
  if (raw === undefined || raw.trim() === '') return fallback;
  const hex = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `${name} must be exactly 64 hex chars (32 bytes) — got ${JSON.stringify(raw)}`,
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function env(name: string): string | undefined {
  const e = (import.meta as { env?: Record<string, string | undefined> }).env;
  return e?.[name];
}

/**
 * The applicant/owner secret key used to derive the owner binding on the
 * registrations this app submits.
 */
export function getApplicantSecretKey(): Uint8Array {
  return parseSecret(env('VITE_PRIESTATE_APPLICANT_SECRET'), ZERO, 'VITE_PRIESTATE_APPLICANT_SECRET');
}

/**
 * The designated-officer secret key used to authorize approve/reject.
 * Its derived DApp public key must match the officer public key configured
 * at deploy, or the on-chain officer assert fails.
 */
export function getOfficerSecretKey(): Uint8Array {
  return parseSecret(env('VITE_PRIESTATE_OFFICER_SECRET'), ZERO, 'VITE_PRIESTATE_OFFICER_SECRET');
}
