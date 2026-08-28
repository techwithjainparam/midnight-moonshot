/**
 * Display models for the PUBLIC registry / property detail views, derived
 * ONLY from the contract's on-chain registration state.
 *
 * The ledger's `Registration` public record is deliberately thin — it never
 * contains the confidential property value, and it carries no free-form
 * fields (owner name, village, survey number, etc.) that a backend registry
 * would add off-chain. Fields that cannot be sourced from the on-chain state
 * are surfaced as an explicit "unavailable" marker rather than invented data.
 */

import { RegistrationStatus, type PriestateRegistration } from './common-types';
import { decodeDistrict, registrationStatusLabel, registrationStatusClass, formatTimestamp } from './registration-utils';

/** Short lowercase hex of a 32-byte key for display (e.g. owner / reviewer). */
export function shortHexKey(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 18);
}

/** True when any byte is non-zero (i.e. the optional 32-byte field is set). */
export function hasAnyBytes(bytes: Uint8Array): boolean {
  return bytes.some((b) => b !== 0);
}

/** A single public registry entry, rendered from on-chain state only. */
export interface RegistryItem {
  /** Numeric on-chain registration ID. */
  readonly id: string;
  readonly idBigint: bigint;
  /** Owner/applicant binding — the disclosed derived public key (short hex). */
  readonly ownerKey: string;
  readonly area: string;
  readonly district: string;
  readonly statusLabel: string;
  readonly statusClass: string;
  readonly submittedLabel: string;
}

/** Map one on-chain registration into a public registry entry. */
export function toRegistryItem(id: bigint, r: PriestateRegistration): RegistryItem {
  return {
    id: id.toString(),
    idBigint: id,
    ownerKey: `${shortHexKey(r.owner)}…`,
    area: r.area.toString(),
    district: decodeDistrict(r.district) || '—',
    statusLabel: registrationStatusLabel(r.status).replace('_', ' '),
    statusClass: registrationStatusClass(r.status),
    submittedLabel: formatTimestamp(r.submittedAt),
  };
}

/**
 * The PUBLIC registry: only finalized (APPROVED) on-chain registrations,
 * sorted oldest→newest by registration ID. Pending/rejected and drafts are
 * excluded — matching the registry's "finalized public records only" rule.
 */
export function publicRegistryItems(
  registrations: ReadonlyMap<bigint, PriestateRegistration>,
): RegistryItem[] {
  return Array.from(registrations.entries())
    .filter(([, r]) => r.status === RegistrationStatus.APPROVED)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, r]) => toRegistryItem(id, r));
}

/** Status tallies across ALL on-chain registrations (officer + registry views). */
export interface RegistrationCounts {
  readonly total: number;
  readonly approved: number;
  readonly pending: number;
  readonly rejected: number;
}

/** Count on-chain registrations by status. */
export function registrationCounts(
  registrations: ReadonlyMap<bigint, PriestateRegistration>,
): RegistrationCounts {
  let approved = 0;
  let pending = 0;
  let rejected = 0;
  for (const r of registrations.values()) {
    if (r.status === RegistrationStatus.APPROVED) approved += 1;
    else if (r.status === RegistrationStatus.PENDING) pending += 1;
    else if (r.status === RegistrationStatus.REJECTED) rejected += 1;
  }
  return { total: registrations.size, approved, pending, rejected };
}

/** What the property detail page can honestly show from on-chain state. */
export interface RegistrationDetail {
  readonly id: string;
  readonly ownerKey: string;
  readonly area: string;
  readonly district: string;
  readonly statusLabel: string;
  readonly statusClass: string;
  readonly submittedLabel: string;
  readonly reviewedLabel: string;
  readonly reviewedByLabel: string;
  readonly finalized: boolean;
}

/** Build the honest detail view for a single on-chain registration. */
export function toRegistrationDetail(id: bigint, r: PriestateRegistration): RegistrationDetail {
  return {
    id: id.toString(),
    ownerKey: shortHexKey(r.owner),
    area: r.area.toString(),
    district: decodeDistrict(r.district) || '—',
    statusLabel: registrationStatusLabel(r.status).replace('_', ' '),
    statusClass: registrationStatusClass(r.status),
    submittedLabel: formatTimestamp(r.submittedAt),
    reviewedLabel: hasAnyBytes(r.reviewedBy) ? formatTimestamp(r.reviewedAt) : '—',
    reviewedByLabel: hasAnyBytes(r.reviewedBy) ? shortHexKey(r.reviewedBy) : '—',
    finalized: r.status === RegistrationStatus.APPROVED || r.status === RegistrationStatus.REJECTED,
  };
}
