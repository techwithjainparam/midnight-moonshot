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
  wallet_address   TEXT UNIQUE,
  password_hash    TEXT NOT NULL,
  password_salt    TEXT NOT NULL,
  pii_ciphertext   TEXT NOT NULL,
  masked_mobile    TEXT NOT NULL,
  masked_aadhaar   TEXT NOT NULL,
  sms_otp_verified     INTEGER NOT NULL DEFAULT 0,
  whatsapp_otp_verified INTEGER NOT NULL DEFAULT 0,
  google_linked         INTEGER NOT NULL DEFAULT 0,
  identity_verified     INTEGER NOT NULL DEFAULT 0,
  email_verified        INTEGER NOT NULL DEFAULT 0,
  email_verified_at     INTEGER,
  biometric_reference_ciphertext TEXT,
  biometric_reference_version    INTEGER,
  biometric_enrolled_at          INTEGER,
  biometric_consent_at           INTEGER,
  biometric_revoked_at           INTEGER,
  identity_evidence_accepted_at  INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  wallet_address TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS registration_sessions (
  session_token               TEXT PRIMARY KEY,
  wallet_address              TEXT,
  personal_pii_ciphertext     TEXT,
  masked_mobile               TEXT,
  masked_aadhaar              TEXT,
  aadhaar_ocr_ciphertext      TEXT,
  aadhaar_document_status     TEXT NOT NULL DEFAULT 'unverified',
  aadhaar_document_extracted_at INTEGER,
  email_verified              INTEGER NOT NULL DEFAULT 0,
  email_verified_at           INTEGER,
  sms_otp_verified            INTEGER NOT NULL DEFAULT 0,
  sms_otp_verified_at         INTEGER,
  whatsapp_otp_verified       INTEGER NOT NULL DEFAULT 0,
  whatsapp_otp_verified_at    INTEGER,
  aadhaar_mobile_linked       INTEGER NOT NULL DEFAULT 0,
  aadhaar_mobile_linked_at    INTEGER,
  password_hash               TEXT,
  password_salt               TEXT,
  photo_status                TEXT NOT NULL DEFAULT 'unverified',
  photo_content_hash          TEXT,
  liveness_passed             INTEGER NOT NULL DEFAULT 0,
  liveness_passed_at          INTEGER,
  location_accepted           INTEGER NOT NULL DEFAULT 0,
  location_accepted_at        INTEGER,
  finalized_at                INTEGER,
  created_at                  INTEGER NOT NULL,
  expires_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_registration_sessions_wallet ON registration_sessions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_registration_sessions_expires ON registration_sessions(expires_at);

CREATE TABLE IF NOT EXISTS forgot_password_sessions (
  wallet_address     TEXT PRIMARY KEY,
  email_verified     INTEGER NOT NULL DEFAULT 0,
  liveness_passed    INTEGER NOT NULL DEFAULT 0,
  biometric_verified INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_forgot_password_sessions_expires ON forgot_password_sessions(expires_at);

CREATE TABLE IF NOT EXISTS officer_accounts (
  officer_id    TEXT PRIMARY KEY,
  display_name  TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS officer_sessions (
  session_id  TEXT PRIMARY KEY,
  officer_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  FOREIGN KEY (officer_id) REFERENCES officer_accounts(officer_id)
);

CREATE INDEX IF NOT EXISTS idx_officer_sessions_officer ON officer_sessions(officer_id);
`;

/** Additive, idempotent column migrations for pre-existing account DBs. */
const MIGRATIONS_SQL: readonly string[] = [
  `ALTER TABLE accounts ADD COLUMN google_linked INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE accounts ADD COLUMN biometric_reference_ciphertext TEXT`,
  `ALTER TABLE accounts ADD COLUMN biometric_reference_version INTEGER`,
  `ALTER TABLE accounts ADD COLUMN biometric_enrolled_at INTEGER`,
  `ALTER TABLE accounts ADD COLUMN biometric_consent_at INTEGER`,
  `ALTER TABLE accounts ADD COLUMN biometric_revoked_at INTEGER`,
  `ALTER TABLE accounts ADD COLUMN identity_evidence_accepted_at INTEGER`,
  `ALTER TABLE accounts ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE accounts ADD COLUMN email_verified_at INTEGER`,
  // The personal step is completed by an explicit Continue, not implicitly by
  // the phone OTP landing. Tracked separately from the OTP flags so the stepper
  // cannot advance on verification alone.
  `ALTER TABLE registration_sessions ADD COLUMN personal_completed_at INTEGER`,
];

/**
 * Registration sessions are now created wallet-free (wallet_address NULL until
 * the citizen associates their wallet after finalize). Databases created before
 * that change have `wallet_address TEXT NOT NULL`; rebuild the table (SQLite
 * cannot relax a NOT NULL constraint in place) while preserving every row.
 * Idempotent: does nothing once the column is already nullable.
 */
function migrateRegistrationWalletNullable(db: Database.Database): void {
  const cols = db.pragma('table_info(registration_sessions)') as Array<{ name: string; notnull: number }>;
  const wallet = cols.find((c) => c.name === 'wallet_address');
  if (!wallet || wallet.notnull === 0) return;

  const registrationSessionsColumnList = [
    'session_token',
    'wallet_address',
    'personal_pii_ciphertext',
    'masked_mobile',
    'masked_aadhaar',
    'aadhaar_ocr_ciphertext',
    'aadhaar_document_status',
    'aadhaar_document_extracted_at',
    'email_verified',
    'email_verified_at',
    'sms_otp_verified',
    'sms_otp_verified_at',
    'whatsapp_otp_verified',
    'whatsapp_otp_verified_at',
    'aadhaar_mobile_linked',
    'aadhaar_mobile_linked_at',
    'password_hash',
    'password_salt',
    'photo_status',
    'photo_content_hash',
    'liveness_passed',
    'liveness_passed_at',
    'location_accepted',
    'location_accepted_at',
    'finalized_at',
    'created_at',
    'expires_at',
  ].join(', ');

  db.transaction(() => {
    db.exec('ALTER TABLE registration_sessions RENAME TO registration_sessions_old');
    db.exec(SCHEMA_SQL);
    db.exec(
      `INSERT INTO registration_sessions (${registrationSessionsColumnList}) ` +
        `SELECT ${registrationSessionsColumnList} FROM registration_sessions_old`,
    );
    db.exec('DROP TABLE registration_sessions_old');
  })();
}

/**
 * Apply the PRIESTATE account/session schema to an existing connection.
 * Exposed for tests and callers that open their own Database handle.
 */
export function applySchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  // Idempotent additive migrations (safe to run on every boot).
  for (const sql of MIGRATIONS_SQL) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — ignore.
    }
  }
  migrateRegistrationWalletNullable(db);
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
