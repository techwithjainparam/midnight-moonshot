/**
 * Helpers shared by the registration UI pages (public metadata only).
 *
 * These are pure formatting/encoding helpers — they never touch the ledger,
 * the wallet, or any secret input. The confidential valuation figure is not
 * represented here in any form.
 */

import { RegistrationStatus } from './common-types.js';

// TextEncoder/TextDecoder are web-standard globals available in every
// supported browser and in Node 11+. No `node:util` import is needed, which
// keeps this module fully browser-bundlable.

/** Pad or truncate a UTF-8 district string to exactly 32 bytes (Bytes<32>). */
export function encodeDistrict(district: string): Uint8Array {
  const bytes = new TextEncoder().encode(district);
  const out = new Uint8Array(32);
  out.set(bytes.slice(0, 32));
  return out;
}

/** Decode a Bytes<32> district value for display, trimming trailing NULs. */
export function decodeDistrict(bytes: Uint8Array): string {
  const out = new Uint8Array(bytes);
  // Trim trailing zero padding added by encodeDistrict.
  let end = out.length;
  while (end > 0 && out[end - 1] === 0) end -= 1;
  return new TextDecoder().decode(out.subarray(0, end));
}

/** Human-readable label for an on-chain registration status. */
export function registrationStatusLabel(status: RegistrationStatus): string {
  switch (status) {
    case RegistrationStatus.APPROVED:
      return 'APPROVED';
    case RegistrationStatus.REJECTED:
      return 'REJECTED';
    case RegistrationStatus.PENDING:
    default:
      return 'PENDING_REVIEW';
  }
}

/** CSS status class matching the app's status-pill palette. */
export function registrationStatusClass(status: RegistrationStatus): string {
  switch (status) {
    case RegistrationStatus.APPROVED:
      return 'status-registered';
    case RegistrationStatus.REJECTED:
      return 'status-rejected';
    case RegistrationStatus.PENDING:
    default:
      return 'status-pending';
  }
}

/** Convert an epoch-milliseconds timestamp to a short display date. */
export function formatTimestamp(millis: bigint): string {
  if (millis === 0n) return '—';
  return new Date(Number(millis)).toLocaleString();
}

/**
 * Extract a numeric AREA (Uint<64>) from a human land-area string such as
 * "2,400 sq ft" → 2400. Used for the public `area` registry field.
 */
export function parseAreaFromLandString(landArea: string): bigint {
  const digits = landArea.replace(/[,_\s]/g, '').replace(/[a-zA-Z.]/g, '');
  const value = BigInt(digits === '' ? 0 : digits);
  return value > 18446744073709551615n ? 18446744073709551615n : value;
}
