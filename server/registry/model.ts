// PRIESTATE — Server-side registry / application model.
//
// ⚠️ SERVER-SIDE ONLY. Runs inside the Node process (tsx server/index.ts);
// never bundled into the browser build.
//
// The Midnight contract is the single source of truth for the ON-CHAIN
// registration STATUS (PENDING / APPROVED / REJECTED). This server cannot
// read the ledger, so it deliberately stores only METADATA that references a
// registration by its on-chain id — it never asserts or persists an
// APPROVED/REJECTED verdict, and never stores the confidential property
// VALUE (which remains a private witness in the browser).
//
// The only status value a metadata record may carry is the lifecycle marker
// `PENDING_REVIEW`, which records that the metadata has been catalogued and
// is awaiting an authorized officer's real on-chain decision. It is NOT an
// on-chain verdict and must never be confused with the chain's status.

export const REGISTRY_METADATA_STATUS = 'PENDING_REVIEW' as const;
export type RegistryMetadataStatus = typeof REGISTRY_METADATA_STATUS;

/** Max length of any free-form metadata string field. */
export const MAX_METADATA_STRING = 200;
/** Max digits for the public numeric `area` field. */
export const MAX_AREA_DIGITS = 18;

/**
 * Public registry metadata associated with an on-chain registration.
 * Safe by construction: no property VALUE, no secrets, no verdict.
 */
export interface RegistryApplicationMetadata {
  /** Locally assigned metadata record id (NOT the on-chain id). */
  readonly id: string;
  /** On-chain registration id this metadata references (numeric string). */
  readonly referenceId: string;
  readonly applicantName?: string;
  readonly village?: string;
  readonly taluka?: string;
  readonly district?: string;
  readonly surveyNumber?: string;
  /** Public numeric land area (number as a string). */
  readonly area?: string;
  /** Lifecycle marker only — see module note. Never a chain verdict. */
  readonly status: RegistryMetadataStatus;
  /** Epoch ms when this metadata record was created server-side. */
  readonly createdAt: number;
}

/** Input accepted from an authorized officer for metadata intake. */
export interface RegistryApplicationInput {
  readonly referenceId: string;
  readonly applicantName?: string;
  readonly village?: string;
  readonly taluka?: string;
  readonly district?: string;
  readonly surveyNumber?: string;
  readonly area?: string;
}

/**
 * Keys a client is FORBIDDEN from supplying. These would attempt to assert a
 * fabricated on-chain verdict or smuggle the confidential property VALUE /
 * secrets onto the server.
 */
const FORBIDDEN_KEYS = new Set([
  'status',
  'verdict',
  'approved',
  'rejected',
  'propertyValue',
  'propertyvalue',
  'value',
  'amount',
  'applicantSecret',
  'applicantSecretKey',
  'officerSecret',
  'officerSecretKey',
  'secret',
  'aadhaar',
  'aadhaarNumber',
]);

/** The ONLY fields accepted from a client. Everything else is rejected. */
const ALLOWED_KEYS = new Set([
  'referenceId',
  'applicantName',
  'village',
  'taluka',
  'district',
  'surveyNumber',
  'area',
]);

/** A non-empty on-chain registration id is a 1..20 digit number. */
export function isValidReferenceId(raw: string): boolean {
  return /^\d{1,20}$/.test(raw.trim());
}

type ParseResult =
  | { ok: true; input: RegistryApplicationInput }
  | { ok: false; reason: 'invalid-input' | 'forbidden-field' };

const TEXT_FIELDS = [
  'applicantName',
  'village',
  'taluka',
  'district',
  'surveyNumber',
] as const;

/**
 * Parse + validate registry metadata input submitted to the server.
 *
 * * server-side only — never trusts the browser,
 * * rejects a fabricated status/verdict or a smuggled property VALUE/secret,
 * * returns a normalized input that only ever carries safe public metadata.
 */
export function parseRegistryApplicationInput(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid-input' };
  }
  const record = raw as Record<string, unknown>;

  // Defense-in-depth: forbid explicit verdict/secret/value fields, and reject
  // any field that is not in the allowlist so a stray authoritative key can
  // never slip through silently.
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key)) return { ok: false, reason: 'forbidden-field' };
    if (!ALLOWED_KEYS.has(key)) return { ok: false, reason: 'invalid-input' };
  }

  if (!isValidReferenceId(String(record.referenceId ?? ''))) {
    return { ok: false, reason: 'invalid-input' };
  }

  const fields: Record<string, string> = {
    referenceId: String(record.referenceId).trim(),
  };

  for (const key of TEXT_FIELDS) {
    const v = record[key];
    // Absent, or an empty/whitespace string, or null → not provided.
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return { ok: false, reason: 'invalid-input' };
    const value = v.trim();
    if (value.length === 0) continue;
    if (value.length > MAX_METADATA_STRING) return { ok: false, reason: 'invalid-input' };
    // Reject control characters so stored metadata is safe to render anywhere.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: 'invalid-input' };
    fields[key as string] = value;
  }

  const areaRaw = record.area;
  if (areaRaw !== undefined && areaRaw !== null) {
    if (typeof areaRaw !== 'string') return { ok: false, reason: 'invalid-input' };
    const digits = areaRaw.trim().replace(/,/g, '');
    if (digits.length === 0) {
      // empty → not provided
    } else if (digits.length > MAX_AREA_DIGITS || !/^\d+$/.test(digits)) {
      return { ok: false, reason: 'invalid-input' };
    } else {
      fields.area = digits;
    }
  }

  const input: RegistryApplicationInput = {
    referenceId: fields.referenceId,
    applicantName: fields.applicantName,
    village: fields.village,
    taluka: fields.taluka,
    district: fields.district,
    surveyNumber: fields.surveyNumber,
    area: fields.area,
  };
  return { ok: true, input };
}

/**
 * Project stored metadata into the PUBLIC (wire) representation. Guarantees
 * only safe, non-secret, non-verdict fields are ever returned.
 */
export function toPublicRegistryMetadata(
  meta: RegistryApplicationMetadata,
): RegistryApplicationMetadata {
  // The stored record already excludes property value / secrets / verdicts;
  // this projection is the explicit boundary that documents that guarantee.
  return {
    id: meta.id,
    referenceId: meta.referenceId,
    status: REGISTRY_METADATA_STATUS,
    createdAt: meta.createdAt,
    applicantName: meta.applicantName,
    village: meta.village,
    taluka: meta.taluka,
    district: meta.district,
    surveyNumber: meta.surveyNumber,
    area: meta.area,
  } satisfies RegistryApplicationMetadata;
}
