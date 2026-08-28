// PRIESTATE — Registry service: server-side officer boundary + metadata ops.
//
// This is a SEPARATE authorization boundary from the on-chain officer check
// and from the (DEMO, client-side, trivially bypassable) frontend role gate in
// src/auth/roles.ts:
//
//   * The frontend frame (roles.ts / RequireOfficer) is a DEMO UX control that
//     decides what the UI shows. It is NOT trusted for security.
//   * This service authenticates an officer with a server-side credential
//     (REGISTRY_OFFICER_API_TOKEN) that never reaches the browser bundle and
//     is never logged.
//   * The authoritative approve/reject decision is still enforced ON-CHAIN by
//     the Compact contract (the designated-officer assert). This service only
//     catalogues metadata referencing a registration; it never fabricates or
//     stores an on-chain verdict.
//
// The service neither reads nor stores the confidential property VALUE and
// neither reads nor stores the applicant/officer SECRET keys.

import { timingSafeEqual } from 'node:crypto';
import type { RegistryStore } from './store.js';
import {
  parseRegistryApplicationInput,
  toPublicRegistryMetadata,
  type RegistryApplicationMetadata,
} from './model.js';

export type RegistryResult =
  | { ok: true; item: RegistryApplicationMetadata }
  | { ok: true; items: RegistryApplicationMetadata[] }
  | { ok: false; reason: 'unavailable' | 'unauthorized' | 'invalid-input' | 'forbidden-field' | 'not-found' };

export interface RegistryServiceOptions {
  /** Metadata persistence backend. */
  readonly store: RegistryStore;
  /**
   * Server-side officer credential. Empty ⇒ the registry feature is
   * `unavailable` (fail closed, matching the app's honest-unavailable rules).
   */
  readonly officerToken: string;
}

/** Constant-time string comparison (guards the officer credential). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class RegistryService {
  private readonly store: RegistryStore;
  private readonly officerToken: string;

  constructor(options: RegistryServiceOptions) {
    this.store = options.store;
    this.officerToken = options.officerToken;
  }

  /** True only when the server-side officer credential is configured. */
  get available(): boolean {
    return this.officerToken !== '';
  }

  /** Server-side officer check. Never invoked for non-officer callers. */
  private isAuthorizedOfficer(token: string | undefined): boolean {
    if (!this.available || !token) return false;
    return safeEqual(token, this.officerToken);
  }

  /**
   * Catalog metadata for an on-chain registration on behalf of an authorized
   * officer. Rejects invalid input and never accepts a fabricated verdict or
   * a smuggled property VALUE / secret.
   */
  ingest(token: string | undefined, raw: unknown): RegistryResult {
    if (!this.available) return { ok: false, reason: 'unavailable' };
    if (!this.isAuthorizedOfficer(token)) return { ok: false, reason: 'unauthorized' };

    const parsed = parseRegistryApplicationInput(raw);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };

    const item = this.store.create(parsed.input);
    return { ok: true, item: toPublicRegistryMetadata(item) };
  }

  /**
   * Applicant-scoped metadata intake (NOT an officer operation).
   *
   * Called by the browser after a REAL on-chain `submitRegistration()`
   * succeeds, with the REAL on-chain registration id as `referenceId`. It does
   * NOT require the server-side officer credential (applicants are not
   * officers) and grants NO officer privileges: it cannot list, cannot read by
   * id, and can never assert or persist a verdict — on-chain status remains
   * authoritative and officer operations still require the server token.
   *
   * Validation is byte-for-byte identical to the officer path: a fabricated
   * status/verdict, a smuggled property VALUE, or any secret is rejected, and
   * only safe public metadata referencing an existing on-chain registration is
   * ever stored. Fails closed (`unavailable`) when the registry feature is not
   * configured, exactly like the officer path.
   */
  ingestApplicant(raw: unknown): RegistryResult {
    if (!this.available) return { ok: false, reason: 'unavailable' };

    const parsed = parseRegistryApplicationInput(raw);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };

    const item = this.store.create(parsed.input);
    return { ok: true, item: toPublicRegistryMetadata(item) };
  }

  /** List catalogued metadata records (authorized officer only). */
  list(token: string | undefined): RegistryResult {
    if (!this.available) return { ok: false, reason: 'unavailable' };
    if (!this.isAuthorizedOfficer(token)) return { ok: false, reason: 'unauthorized' };
    return { ok: true, items: this.store.list().map(toPublicRegistryMetadata) };
  }

  /** Fetch a single metadata record by local id (authorized officer only). */
  get(token: string | undefined, id: string): RegistryResult {
    if (!this.available) return { ok: false, reason: 'unavailable' };
    if (!this.isAuthorizedOfficer(token)) return { ok: false, reason: 'unauthorized' };
    const item = this.store.get(id);
    if (!item) return { ok: false, reason: 'not-found' };
    return { ok: true, item: toPublicRegistryMetadata(item) };
  }
}
