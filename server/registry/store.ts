// PRIESTATE — Minimal registry metadata persistence abstraction.
//
// The Midnight contract remains the authoritative store for on-chain
// registration records and their status. This store holds ONLY the off-chain
// metadata that references those records; it has no notion of a verdict and
// never persists the confidential property VALUE.
//
// `RegistryStore` is a small interface so a concrete persistence backend can
// be swapped in later without changing the service layer (e.g. an HTTP store,
// a relational DB, or object storage). `InMemoryRegistryStore` is the default
// implementation — deterministic and dependency-free so tests run with no
// external infrastructure.

import type { RegistryApplicationInput, RegistryApplicationMetadata } from './model.js';
import { REGISTRY_METADATA_STATUS, toPublicRegistryMetadata } from './model.js';

/** Persistence contract for registry application metadata. */
export interface RegistryStore {
  /** Persist a new metadata record, returning it with local id + createdAt. */
  create(meta: RegistryApplicationInput): RegistryApplicationMetadata;
  /** Look up a single metadata record by its local id. */
  get(id: string): RegistryApplicationMetadata | null;
  /** List all metadata records (oldest first). */
  list(): RegistryApplicationMetadata[];
}

/**
 * In-memory metadata store (default backend). Records are assigned sequential
 * local ids; status is fixed to the `PENDING_REVIEW` lifecycle marker and is
 * never persisted from client input. Records carry no property VALUE.
 */
export class InMemoryRegistryStore implements RegistryStore {
  private readonly records = new Map<string, RegistryApplicationMetadata>();
  private nextId = 1;

  create(meta: RegistryApplicationInput): RegistryApplicationMetadata {
    const id = `app-${this.nextId}`;
    this.nextId += 1;
    const record: RegistryApplicationMetadata = {
      referenceId: meta.referenceId,
      applicantName: meta.applicantName,
      village: meta.village,
      taluka: meta.taluka,
      district: meta.district,
      surveyNumber: meta.surveyNumber,
      area: meta.area,
      id,
      status: REGISTRY_METADATA_STATUS,
      createdAt: Date.now(),
    };
    this.records.set(id, record);
    return toPublicRegistryMetadata(record);
  }

  get(id: string): RegistryApplicationMetadata | null {
    const record = this.records.get(id);
    return record ? toPublicRegistryMetadata(record) : null;
  }

  list(): RegistryApplicationMetadata[] {
    return [...this.records.values()].map(toPublicRegistryMetadata);
  }
}
