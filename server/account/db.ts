// PRIESTATE — SQLite database initialisation for account persistence.
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Creates the accounts + sessions tables if they don't exist.  The DB path is
// configurable via the ACCOUNT_DB_PATH environment variable (defaults to
// `./priestate-accounts.db`).  The file is gitignored.

import Database from 'better-sqlite3';
import path from 'node:path';

export const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'priestate-accounts.db');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  account_id       TEXT PRIMARY KEY,
  wallet_address   TEXT UNIQUE NOT NULL,
  password_hash    TEXT NOT NULL,
  password_salt    TEXT NOT NULL,
  pii_ciphertext   TEXT NOT NULL,
  masked_mobile    TEXT NOT NULL,
  masked_aadhaar   TEXT NOT NULL,
  sms_otp_verified     INTEGER NOT NULL DEFAULT 0,
  whatsapp_otp_verified INTEGER NOT NULL DEFAULT 0,
  google_linked         INTEGER NOT NULL DEFAULT 0,
  identity_verified     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`;

/**
 * Apply the PRIESTATE account/session schema to an existing connection.
 * Exposed for tests and callers that open their own Database handle.
 */
export function applySchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
}

/**
 * Open (or create) the SQLite database at the configured path, apply the
 * schema, and return the handle.  Caller is responsible for closing it.
 */
export function openDatabase(dbPath?: string): Database.Database {
  const resolved = dbPath || process.env.ACCOUNT_DB_PATH || DEFAULT_DB_PATH;
  const db = new Database(resolved);
  applySchema(db);
  return db;
}
