// PRIESTATE — Server-side account persistence abstraction.
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// `AccountStore` is a small interface so a concrete backend (e.g. a relational
// DB) can be swapped in later without changing the service layer.
// `InMemoryAccountStore` is the default backend — deterministic and dependency
// free so tests run with no external infrastructure.
//
// The store NEVER holds plaintext passwords or plaintext PII: passwords are
// pre-hashed (salted scrypt) by the caller, and PII arrives as an encrypted
// AES-256-GCM blob. Only masked, public-safe display fragments are stored in
// the clear so the server can show them back to the owner without shipping
// raw PII over the wire.

import type { AccountRecord, PublicAccountView } from './model.js';
import { toPublicAccountView } from './model.js';

export interface AccountStore {
  /** Persist a new account. Throws/last-write-wins on duplicate wallet. */
  create(record: AccountRecord): AccountRecord;
  /** Look up by wallet address (the account's primary key). */
  getByWallet(walletAddress: string): AccountRecord | null;
  /** Look up by accountId. */
  getById(accountId: string): AccountRecord | null;
  /** Update a record (by wallet address) with a partial patch. */
  update(walletAddress: string, patch: Partial<Omit<AccountRecord, 'accountId' | 'walletAddress'>>): AccountRecord | null;
  /** List all accounts (for administrative/testing introspection). */
  list(): AccountRecord[];
}

const KEY = 'walletAddress';

/** Deterministic, dependency-free default backend. */
export class InMemoryAccountStore implements AccountStore {
  private readonly byWallet = new Map<string, AccountRecord>();
  private readonly byId = new Map<string, AccountRecord>();

  create(record: AccountRecord): AccountRecord {
    if (this.byWallet.has(record[KEY])) {
      // Duplicate wallet: refuse to silently overwrite.
      throw new Error(`AccountStore: wallet already registered: ${record[KEY]}`);
    }
    this.byWallet.set(record[KEY], record);
    this.byId.set(record.accountId, record);
    return record;
  }

  getByWallet(walletAddress: string): AccountRecord | null {
    return this.byWallet.get(walletAddress) ?? null;
  }

  getById(accountId: string): AccountRecord | null {
    return this.byId.get(accountId) ?? null;
  }

  update(
    walletAddress: string,
    patch: Partial<Omit<AccountRecord, 'accountId' | 'walletAddress'>>,
  ): AccountRecord | null {
    const existing = this.byWallet.get(walletAddress);
    if (!existing) return null;
    const next: AccountRecord = { ...existing, ...patch };
    this.byWallet.set(walletAddress, next);
    this.byId.set(next.accountId, next);
    return next;
  }

  list(): AccountRecord[] {
    return [...this.byWallet.values()];
  }
}

export function toPublicView(record: AccountRecord): PublicAccountView {
  return toPublicAccountView(record);
}
