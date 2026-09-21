// PRIESTATE — Server-side officer credential accounts (real, server-backed).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Officer identity is a SERVER-BACKED credential the RequireOfficer frontend
// guard checks FIRST (the wallet-based demo officer role is demoted to a
// clearly-labelled fallback). Design:
//
//   * SINGLE OFFICER model: an officer account is minted exactly once, gated
//     behind a one-time commissioning code (OFFICER_REGISTRATION_CODE). After
//     minting, registration refuses any further officer (`officer-exists`) —
//     there is exactly one commissioned officer per deployment.
//   * OFFICER SESSION COOKIE is SEPARATE (`priestate_officer_sid`) from the
//     citizen session cookie (`priestate_sid`), so an officer who is also a
//     registered citizen keeps the two identities from colliding.
//   * Passwords are stored ONLY as salted scrypt hashes (identical contract to
//     the citizen account boundary). Session tokens are opaque random values.
//     Nothing here is ever logged or echoed back to the browser.
//   * Fails closed: with no commissioning code configured, registration is
//     `registration-disabled` and the UI reports the feature as unavailable —
//     the server never fakes an officer.

import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { hashPassword, verifyPassword } from './security.js';
import { passwordIssues } from './model.js';

export const OFFICER_SESSION_COOKIE_NAME = 'priestate_officer_sid';
export const OFFICER_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
export const OFFICER_TOKEN_BYTES = 32;

export interface OfficerRecord {
  readonly officerId: string;
  readonly displayName: string;
  /** salted scrypt hash — the ONLY representation of the password. */
  readonly passwordHash: string;
  readonly passwordSalt: string;
  readonly createdAt: number;
}

/** Public-safe projection of an officer (never exposes hash/salt/token). */
export interface PublicOfficerView {
  readonly officerId: string;
  readonly displayName: string;
  readonly createdAt: number;
}

export interface OfficerCapabilities {
  /** True only when a commissioning code is configured (else registration unavailable). */
  readonly registrationAvailable: boolean;
  /** Login is available whenever an officer store is configured. */
  readonly loginAvailable: boolean;
}

export interface OfficerStore {
  create(record: OfficerRecord): OfficerRecord;
  getById(officerId: string): OfficerRecord | null;
  getByDisplayName(displayName: string): OfficerRecord | null;
  list(): OfficerRecord[];
}

const KEY = 'officerId';

/** Deterministic, dependency-free default backend. */
export class InMemoryOfficerStore implements OfficerStore {
  private readonly byId = new Map<string, OfficerRecord>();
  private readonly byName = new Map<string, OfficerRecord>();

  create(record: OfficerRecord): OfficerRecord {
    if (this.byName.has(record.displayName)) {
      throw new Error(`OfficerStore: display name already taken: ${record.displayName}`);
    }
    this.byId.set(record[KEY], record);
    this.byName.set(record.displayName, record);
    return record;
  }

  getById(officerId: string): OfficerRecord | null {
    return this.byId.get(officerId) ?? null;
  }

  getByDisplayName(displayName: string): OfficerRecord | null {
    return this.byName.get(displayName) ?? null;
  }

  list(): OfficerRecord[] {
    return [...this.byId.values()];
  }
}

interface OfficerRow {
  officer_id: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  created_at: number;
}

interface OfficerSessionRow {
  session_id: string;
  officer_id: string;
  created_at: number;
  expires_at: number;
}

function rowToOfficer(r: OfficerRow): OfficerRecord {
  return {
    officerId: r.officer_id,
    displayName: r.display_name,
    passwordHash: r.password_hash,
    passwordSalt: r.password_salt,
    createdAt: r.created_at,
  };
}

function officerToRow(r: OfficerRecord): OfficerRow {
  return {
    officer_id: r.officerId,
    display_name: r.displayName,
    password_hash: r.passwordHash,
    password_salt: r.passwordSalt,
    created_at: r.createdAt,
  };
}

/** SQLite-backed persistent officer store (shared `db` handle). */
export class SqliteOfficerStore implements OfficerStore {
  constructor(db: Database.Database) {
    this._insert = db.prepare(`
      INSERT INTO officer_accounts
        (officer_id, display_name, password_hash, password_salt, created_at)
      VALUES
        (@officer_id, @display_name, @password_hash, @password_salt, @created_at)
    `);
    this._selectById = db.prepare('SELECT * FROM officer_accounts WHERE officer_id = ?');
    this._selectByName = db.prepare('SELECT * FROM officer_accounts WHERE display_name = ?');
    this._selectAll = db.prepare('SELECT * FROM officer_accounts');
  }

  private readonly _insert: Database.Statement;
  private readonly _selectById: Database.Statement;
  private readonly _selectByName: Database.Statement;
  private readonly _selectAll: Database.Statement;

  create(record: OfficerRecord): OfficerRecord {
    if (this.getByDisplayName(record.displayName)) {
      throw new Error(`OfficerStore: display name already taken: ${record.displayName}`);
    }
    this._insert.run(officerToRow(record));
    return record;
  }

  getById(officerId: string): OfficerRecord | null {
    const row = this._selectById.get(officerId) as OfficerRow | undefined;
    return row ? rowToOfficer(row) : null;
  }

  getByDisplayName(displayName: string): OfficerRecord | null {
    const row = this._selectByName.get(displayName) as OfficerRow | undefined;
    return row ? rowToOfficer(row) : null;
  }

  list(): OfficerRecord[] {
    return (this._selectAll.all() as OfficerRow[]).map(rowToOfficer);
  }
}

const OFFICER_NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,79}$/u;
const MIN_OFFICER_PASSWORD_LENGTH = 10;

export interface OfficerServiceConfig {
  /** One-time commissioning code; empty ⇒ registration unavailable (fail closed). */
  readonly registrationCode: string;
  readonly store: OfficerStore;
  readonly db: Database.Database;
  readonly sessionSecure?: boolean;
  readonly sessionSameSite?: 'Lax' | 'Strict' | 'None';
  readonly sessionTtlMs?: number;
}

export type OfficerRegisterResult =
  | { ok: true; view: PublicOfficerView; cookieHeader: string }
  | { ok: false; reason: 'unavailable' | 'registration-disabled' | 'code-invalid' | 'officer-exists' | 'invalid-input' };

export type OfficerLoginResult =
  | { ok: true; view: PublicOfficerView; cookieHeader: string }
  | { ok: false; reason: 'unavailable' | 'unauthorized' };

export class OfficerService {
  private readonly registrationCode: string;
  private readonly store: OfficerStore;
  private readonly secure: boolean;
  private readonly sameSite: 'Lax' | 'Strict' | 'None';
  private readonly ttlMs: number;
  private readonly insertSessionStmt: Database.Statement;
  private readonly selectSessionStmt: Database.Statement;
  private readonly deleteSessionStmt: Database.Statement;
  private readonly deleteExpiredStmt: Database.Statement;

  constructor(config: OfficerServiceConfig) {
    this.registrationCode = config.registrationCode.trim();
    this.store = config.store;
    this.sameSite = config.sessionSameSite ?? 'Lax';
    this.secure = this.sameSite === 'None' ? true : (config.sessionSecure ?? true);
    this.ttlMs = config.sessionTtlMs ?? OFFICER_SESSION_TTL_MS;

    this.insertSessionStmt = config.db.prepare(`
      INSERT INTO officer_sessions (session_id, officer_id, created_at, expires_at)
      VALUES (@session_id, @officer_id, @created_at, @expires_at)
    `);
    this.selectSessionStmt = config.db.prepare(
      'SELECT * FROM officer_sessions WHERE session_id = ?',
    );
    this.deleteSessionStmt = config.db.prepare(
      'DELETE FROM officer_sessions WHERE session_id = ?',
    );
    this.deleteExpiredStmt = config.db.prepare(
      'DELETE FROM officer_sessions WHERE expires_at < ?',
    );
  }

  capabilities(): OfficerCapabilities {
    return {
      registrationAvailable: this.registrationCode !== '',
      loginAvailable: true,
    };
  }

  /**
   * Mint the SINGLE officer account. Gated by the one-time commissioning code
   * and the already-minted check; after the first officer exists every further
   * registration is refused. Always issues a session cookie on success.
   */
  register(input: {
    displayName: string;
    password: string;
    passwordConfirm: string;
    registrationCode: string;
  }): OfficerRegisterResult {
    if (this.registrationCode === '') return { ok: false, reason: 'registration-disabled' };
    if (input.registrationCode.trim() !== this.registrationCode) {
      return { ok: false, reason: 'code-invalid' };
    }
    if (this.store.list().length > 0) return { ok: false, reason: 'officer-exists' };

    const displayName = input.displayName.trim();
    if (!OFFICER_NAME_RE.test(displayName)) return { ok: false, reason: 'invalid-input' };
    if (input.password.length < MIN_OFFICER_PASSWORD_LENGTH) {
      return { ok: false, reason: 'invalid-input' };
    }
    if (input.password !== input.passwordConfirm) return { ok: false, reason: 'invalid-input' };
    if (passwordIssues(input.password).length > 0) return { ok: false, reason: 'invalid-input' };

    const officerId = randomBytes(12).toString('hex');
    const { hash, salt } = hashPassword(input.password);
    const record: OfficerRecord = {
      officerId,
      displayName,
      passwordHash: hash,
      passwordSalt: salt,
      createdAt: Date.now(),
    };
    this.store.create(record);
    return {
      ok: true,
      view: toPublicOfficerView(record),
      cookieHeader: this.createSession(officerId).cookieHeader,
    };
  }

  /**
   * Officer login. Fails closed with a uniform `unauthorized` for unknown
   * display names AND bad passwords (no username-oracle). Issues a SEPARATE
   * `priestate_officer_sid` cookie on success.
   */
  login(input: { displayName: string; password: string }): OfficerLoginResult {
    const officer = this.store.getByDisplayName(input.displayName.trim());
    if (!officer || !verifyPassword(input.password, officer.passwordHash, officer.passwordSalt)) {
      return { ok: false, reason: 'unauthorized' };
    }
    return {
      ok: true,
      view: toPublicOfficerView(officer),
      cookieHeader: this.createSession(officer.officerId).cookieHeader,
    };
  }

  /** Validate an officer session token. Returns the public view or null. */
  getBySessionToken(token: string): PublicOfficerView | null {
    if (!token) return null;
    const row = this.selectSessionStmt.get(token) as OfficerSessionRow | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.deleteSessionStmt.run(token);
      return null;
    }
    const officer = this.store.getById(row.officer_id);
    return officer ? toPublicOfficerView(officer) : null;
  }

  /** Destroy an officer session (logout). */
  logout(token: string): void {
    if (!token) return;
    this.deleteSessionStmt.run(token);
  }

  /** Purge expired officer sessions. Returns the number removed. */
  purgeExpired(): number {
    return this.deleteExpiredStmt.run(Date.now()).changes;
  }

  /** Build a Set-Cookie header that clears the officer session cookie. */
  clearCookieHeader(): string {
    return [
      `${OFFICER_SESSION_COOKIE_NAME}=`,
      'HttpOnly',
      'Path=/',
      `SameSite=${this.sameSite}`,
      this.secure ? 'Secure' : '',
      'Max-Age=0',
    ]
      .filter(Boolean)
      .join('; ');
  }

  private createSession(officerId: string): { token: string; cookieHeader: string } {
    const now = Date.now();
    const token = randomBytes(OFFICER_TOKEN_BYTES).toString('hex');
    const expiresAt = now + this.ttlMs;
    this.insertSessionStmt.run({
      session_id: token,
      officer_id: officerId,
      created_at: now,
      expires_at: expiresAt,
    });
    const cookieHeader = [
      `${OFFICER_SESSION_COOKIE_NAME}=${token}`,
      'HttpOnly',
      'Path=/',
      `SameSite=${this.sameSite}`,
      this.secure ? 'Secure' : '',
      `Max-Age=${Math.floor(this.ttlMs / 1000)}`,
    ]
      .filter(Boolean)
      .join('; ');
    return { token, cookieHeader };
  }
}

function toPublicOfficerView(record: OfficerRecord): PublicOfficerView {
  return {
    officerId: record.officerId,
    displayName: record.displayName,
    createdAt: record.createdAt,
  };
}