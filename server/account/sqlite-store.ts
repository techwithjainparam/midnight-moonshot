// PRIESTATE — SQLite-backed persistent account store.
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Implements `AccountStore` using better-sqlite3.  All sensitive data is
// stored exactly as the service layer provides it: password hashes + PII
// ciphertext only — never plaintext secrets.

import type Database from 'better-sqlite3';
import type { AccountRecord } from './model.js';
import type { AccountStore } from './store.js';

interface Row {
  account_id: string;
  wallet_address: string | null;
  password_hash: string;
  password_salt: string;
  pii_ciphertext: string;
  masked_mobile: string;
  masked_aadhaar: string;
  sms_otp_verified: number;
  whatsapp_otp_verified: number;
  google_linked: number;
  identity_verified: number;
  email_verified: number;
  email_verified_at: number | null;
  biometric_reference_ciphertext: string | null;
  biometric_reference_version: number | null;
  biometric_enrolled_at: number | null;
  biometric_consent_at: number | null;
  biometric_revoked_at: number | null;
  identity_evidence_accepted_at: number | null;
  created_at: number;
}

function rowToRecord(r: Row): AccountRecord {
  return {
    accountId: r.account_id,
    walletAddress: r.wallet_address,
    passwordHash: r.password_hash,
    passwordSalt: r.password_salt,
    piiCipherText: r.pii_ciphertext,
    maskedMobile: r.masked_mobile,
    maskedAadhaar: r.masked_aadhaar,
    smsOtpVerified: r.sms_otp_verified === 1,
    whatsappOtpVerified: r.whatsapp_otp_verified === 1,
    googleLinked: r.google_linked === 1,
    identityVerified: r.identity_verified === 1,
    emailVerified: r.email_verified === 1,
    emailVerifiedAt: r.email_verified_at ?? null,
    biometricReferenceCipherText: r.biometric_reference_ciphertext ?? null,
    biometricReferenceVersion: r.biometric_reference_version ?? null,
    biometricEnrolledAt: r.biometric_enrolled_at ?? null,
    biometricConsentAt: r.biometric_consent_at ?? null,
    biometricRevokedAt: r.biometric_revoked_at ?? null,
    identityEvidenceAcceptedAt: r.identity_evidence_accepted_at ?? null,
    createdAt: r.created_at,
  };
}

function recordToRow(r: AccountRecord): Row {
  return {
    account_id: r.accountId,
    wallet_address: r.walletAddress,
    password_hash: r.passwordHash,
    password_salt: r.passwordSalt,
    pii_ciphertext: r.piiCipherText,
    masked_mobile: r.maskedMobile,
    masked_aadhaar: r.maskedAadhaar,
    sms_otp_verified: r.smsOtpVerified ? 1 : 0,
    whatsapp_otp_verified: r.whatsappOtpVerified ? 1 : 0,
    google_linked: r.googleLinked ? 1 : 0,
    identity_verified: r.identityVerified ? 1 : 0,
    email_verified: r.emailVerified ? 1 : 0,
    email_verified_at: r.emailVerifiedAt ?? null,
    biometric_reference_ciphertext: r.biometricReferenceCipherText ?? null,
    biometric_reference_version: r.biometricReferenceVersion ?? null,
    biometric_enrolled_at: r.biometricEnrolledAt ?? null,
    biometric_consent_at: r.biometricConsentAt ?? null,
    biometric_revoked_at: r.biometricRevokedAt ?? null,
    identity_evidence_accepted_at: r.identityEvidenceAcceptedAt ?? null,
    created_at: r.createdAt,
  };
}

export class SqliteAccountStore implements AccountStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this._insert = this.db.prepare(`
      INSERT INTO accounts
        (account_id, wallet_address, password_hash, password_salt,
         pii_ciphertext, masked_mobile, masked_aadhaar,
         sms_otp_verified, whatsapp_otp_verified, google_linked,
         identity_verified, email_verified, email_verified_at,
         biometric_reference_ciphertext,
         biometric_reference_version, biometric_enrolled_at,
         biometric_consent_at, biometric_revoked_at,
         identity_evidence_accepted_at, created_at)
      VALUES
        (@account_id, @wallet_address, @password_hash, @password_salt,
         @pii_ciphertext, @masked_mobile, @masked_aadhaar,
         @sms_otp_verified, @whatsapp_otp_verified, @google_linked,
         @identity_verified, @email_verified, @email_verified_at,
         @biometric_reference_ciphertext,
         @biometric_reference_version, @biometric_enrolled_at,
         @biometric_consent_at, @biometric_revoked_at,
         @identity_evidence_accepted_at, @created_at)
    `);
    this._selectByWallet = this.db.prepare(
      'SELECT * FROM accounts WHERE wallet_address = ?',
    );
    this._selectById = this.db.prepare(
      'SELECT * FROM accounts WHERE account_id = ?',
    );
    this._selectAll = this.db.prepare('SELECT * FROM accounts');
  }

  private readonly _insert: Database.Statement;
  private readonly _selectByWallet: Database.Statement;
  private readonly _selectById: Database.Statement;
  private readonly _selectAll: Database.Statement;

  create(record: AccountRecord): AccountRecord {
    // getByWallet(NULL) matches nothing in SQLite, so a null-wallet account
    // (wallet-free registration) never collides with an existing wallet.
    if (record.walletAddress !== null && this.getByWallet(record.walletAddress)) {
      throw new Error(`AccountStore: wallet already registered: ${record.walletAddress}`);
    }
    this._insert.run(recordToRow(record));
    return record;
  }

  getByWallet(walletAddress: string): AccountRecord | null {
    const row = this._selectByWallet.get(walletAddress) as Row | undefined;
    return row ? rowToRecord(row) : null;
  }

  getById(accountId: string): AccountRecord | null {
    const row = this._selectById.get(accountId) as Row | undefined;
    return row ? rowToRecord(row) : null;
  }

  update(
    walletAddress: string,
    patch: Partial<Omit<AccountRecord, 'accountId' | 'walletAddress'>>,
  ): AccountRecord | null {
    const existing = this.getByWallet(walletAddress);
    if (!existing) return null;

    const merged = { ...existing, ...patch };

    const sets: string[] = [];
    const values: Record<string, unknown> = {};

    const fieldMap: Record<string, string> = {
      passwordHash: 'password_hash',
      passwordSalt: 'password_salt',
      piiCipherText: 'pii_ciphertext',
      maskedMobile: 'masked_mobile',
      maskedAadhaar: 'masked_aadhaar',
      smsOtpVerified: 'sms_otp_verified',
      whatsappOtpVerified: 'whatsapp_otp_verified',
      googleLinked: 'google_linked',
      identityVerified: 'identity_verified',
      emailVerified: 'email_verified',
      emailVerifiedAt: 'email_verified_at',
      biometricReferenceCipherText: 'biometric_reference_ciphertext',
      biometricReferenceVersion: 'biometric_reference_version',
      biometricEnrolledAt: 'biometric_enrolled_at',
      biometricConsentAt: 'biometric_consent_at',
      biometricRevokedAt: 'biometric_revoked_at',
      identityEvidenceAcceptedAt: 'identity_evidence_accepted_at',
      createdAt: 'created_at',
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in patch) {
        const val = merged[key as keyof AccountRecord];
        sets.push(`${col} = @${col}`);
        values[col] = typeof val === 'boolean' ? (val ? 1 : 0) : val;
      }
    }

    if (sets.length === 0) return existing;

    this.db.prepare(
      `UPDATE accounts SET ${sets.join(', ')} WHERE wallet_address = @wallet_address`,
    ).run({ ...values, wallet_address: walletAddress });

    return this.getByWallet(walletAddress);
  }

  setWalletAddress(accountId: string, walletAddress: string): AccountRecord | null {
    this.db.prepare('UPDATE accounts SET wallet_address = ? WHERE account_id = ?').run(
      walletAddress,
      accountId,
    );
    return this.getById(accountId);
  }

  list(): AccountRecord[] {
    return (this._selectAll.all() as Row[]).map(rowToRecord);
  }

  close(): void {
    this.db.close();
  }
}
