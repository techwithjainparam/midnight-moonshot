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
  wallet_address: string;
  password_hash: string;
  password_salt: string;
  pii_ciphertext: string;
  masked_mobile: string;
  masked_aadhaar: string;
  sms_otp_verified: number;
  whatsapp_otp_verified: number;
  google_linked: number;
  identity_verified: number;
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
         identity_verified, created_at)
      VALUES
        (@account_id, @wallet_address, @password_hash, @password_salt,
         @pii_ciphertext, @masked_mobile, @masked_aadhaar,
         @sms_otp_verified, @whatsapp_otp_verified, @google_linked,
         @identity_verified, @created_at)
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
    if (this.getByWallet(record.walletAddress)) {
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

  list(): AccountRecord[] {
    return (this._selectAll.all() as Row[]).map(rowToRecord);
  }

  close(): void {
    this.db.close();
  }
}
