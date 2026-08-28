// PRIESTATE — Frontend client for the registry metadata intake.
//
// Connected to the server's applicant-scoped route
// (POST /api/v1/applications — see server/registry). This is NOT an officer
// call and uses NO officer credential: the server-side officer token
// (REGISTRY_OFFICER_API_TOKEN) is never bundled into the browser.
//
// The Midnight contract remains the single source of truth for registration
// status. This client persists ONLY safe public metadata that references a
// REAL on-chain registration id (returned by a successful submitRegistration).
// It deliberately never sends the confidential property VALUE or any secret,
// and it never fabricates a status/verdict.

import { verificationApiBase } from '../profile/providers/backend-providers';

/** Base URL of the verification/registry API ('' → same-origin /api proxy). */
export function registryApiBase(): string {
  return verificationApiBase();
}

/** Safe public fields accepted by the applicant registry intake. */
export interface ApplicationMetadataInput {
  readonly referenceId: string;
  readonly applicantName?: string;
  readonly village?: string;
  readonly taluka?: string;
  readonly district?: string;
  readonly surveyNumber?: string;
  readonly area?: string;
}

/** The safe metadata record persisted by the backend (never a verdict). */
export interface ApplicationMetadataRecord {
  readonly id: string;
  readonly referenceId: string;
  readonly applicantName?: string;
  readonly village?: string;
  readonly taluka?: string;
  readonly district?: string;
  readonly surveyNumber?: string;
  readonly area?: string;
  readonly status: 'PENDING_REVIEW';
  readonly createdAt: number;
}

export type CreateMetadataResult =
  | { ok: true; application: ApplicationMetadataRecord }
  | { ok: false; reason: 'unavailable' | 'invalid-input' | 'forbidden-field' | 'network' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

function toRecord(v: unknown): ApplicationMetadataRecord | null {
  if (!isRecord(v)) return null;
  if (typeof v.referenceId !== 'string') return null;
  return {
    id: String(v.id ?? ''),
    referenceId: v.referenceId,
    applicantName: typeof v.applicantName === 'string' ? v.applicantName : undefined,
    village: typeof v.village === 'string' ? v.village : undefined,
    taluka: typeof v.taluka === 'string' ? v.taluka : undefined,
    district: typeof v.district === 'string' ? v.district : undefined,
    surveyNumber: typeof v.surveyNumber === 'string' ? v.surveyNumber : undefined,
    area: typeof v.area === 'string' ? v.area : undefined,
    status: 'PENDING_REVIEW',
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
  };
}

/**
 * Persist safe application metadata referencing a real on-chain registration.
 *
 * Honest failure model: returns a distinct failure (network / unavailable /
 * invalid) so the caller can surface a "recorded on-chain, metadata sync
 * pending" state WITHOUT ever claiming the on-chain submission failed.
 */
export async function createApplicationMetadata(
  input: ApplicationMetadataInput,
  apiBase: string = registryApiBase(),
): Promise<CreateMetadataResult> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/v1/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (res.status === 201 && isRecord(payload) && payload.ok === true) {
    const application = toRecord(payload.application);
    if (application) return { ok: true, application };
    return { ok: false, reason: 'invalid-input' };
  }

  if (res.status === 503) return { ok: false, reason: 'unavailable' };
  if (res.status === 400 && isRecord(payload)) {
    const reason = String(payload.reason ?? '');
    if (reason === 'forbidden-field') return { ok: false, reason: 'forbidden-field' };
    return { ok: false, reason: 'invalid-input' };
  }
  return { ok: false, reason: 'network' };
}

/** Source fields available on the local registration draft. */
interface RegistrationDraftSource {
  readonly ownerName: string;
  readonly village: string;
  readonly taluka: string;
  readonly district: string;
  readonly surveyNumber: string;
  readonly landArea: string;
}

/**
 * Build the SAFE metadata input for a registration. Uses the real on-chain
 * registration id as `referenceId` and ONLY public, non-secret fields — the
 * confidential property VALUE and any secrets are never included by
 * construction. Land area is parsed to its numeric representation so it can be
 * stored as public metadata.
 */
export function toRegistryMetadataInput(
  source: RegistrationDraftSource,
  referenceId: string | bigint,
): ApplicationMetadataInput {
  const area = parseArea(source.landArea);
  const text = (v: string): string | undefined => {
    const t = v ? v.trim() : '';
    return t === '' ? undefined : t;
  };
  return {
    referenceId: referenceId.toString(),
    applicantName: text(source.ownerName),
    village: text(source.village),
    taluka: text(source.taluka),
    district: text(source.district),
    surveyNumber: text(source.surveyNumber),
    area: area !== null ? area : undefined,
  };
}

/**
 * Parse a land-area string ("2,000 sq ft", "2400", …) into its bare numeric
 * digits for public metadata. Returns null when no digits can be parsed.
 */
export function parseArea(raw: string): string | null {
  const digits = (raw ?? '').replace(/,/g, '').match(/\d+/);
  if (!digits) return null;
  return digits[0];
}
