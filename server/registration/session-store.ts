// PRIESTATE — Registration session persistence (server-side only).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// A registration session is the server-authoritative record of ONE in-flight
// registration attempt, bound to a wallet address and referenced by an opaque
// `priestate_reg_sid` HttpOnly cookie token. Every step of the stepper writes
// ONLY verified/derived state to this record:
//
//   * personal/profile PII — kept as an AES-256-GCM ciphertext blob, masked
//     display fragments in the clear,
//   * Aadhaar document OCR extraction — separate ciphertext blob,
//   * email / SMS / WhatsApp / Aadhaar-mobile verification — discrete booleans
//     and timestamps set by the SERVER only,
//   * password — ONLY a salted scrypt hash (never the plaintext),
//   * photo/liveness/location — verification status + timestamps; the server
//     records that each REAL check passed. Portrait bytes are not retained.
//
// Nothing here ever reaches the Midnight ledger.

import type Database from 'better-sqlite3';

export interface RegistrationSession {
  readonly sessionToken: string;
  /** Wallet is optional — registration is wallet-free; null until the user connects. */
  readonly walletAddress: string | null;
  /** Encrypted personal profile { fullName, aadhaarNumber, … , email }. */
  readonly personalPiiCipherText: string | null;
  readonly maskedMobile: string | null;
  readonly maskedAadhaar: string | null;
  /** Encrypted Aadhaar-document OCR extraction { fullName, dob, gender, address }. */
  readonly aadhaarOcrCipherText: string | null;
  readonly aadhaarDocumentStatus: 'unverified' | 'verified';
  readonly aadhaarDocumentExtractedAt: number | null;
  readonly emailVerified: boolean;
  readonly emailVerifiedAt: number | null;
  readonly smsOtpVerified: boolean;
  readonly smsOtpVerifiedAt: number | null;
  readonly whatsappOtpVerified: boolean;
  readonly whatsappOtpVerifiedAt: number | null;
  readonly aadhaarMobileLinked: boolean;
  readonly aadhaarMobileLinkedAt: number | null;
  readonly passwordHash: string | null;
  readonly passwordSalt: string | null;
  readonly photoStatus: 'unverified' | 'verified';
  readonly photoContentHash: string | null;
  readonly livenessPassed: boolean;
  readonly livenessPassedAt: number | null;
  readonly locationAccepted: boolean;
  readonly locationAcceptedAt: number | null;
  readonly finalizedAt: number | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type RegistrationSessionPatch = Partial<
  Omit<RegistrationSession, 'sessionToken' | 'walletAddress' | 'createdAt' | 'expiresAt'>
>;

/** Public-safe projection of a registration session for the browser. */
export interface RegistrationStatus {
  readonly walletAddress: string | null;
  readonly active: boolean;
  readonly personalVerified: boolean;
  readonly aadhaarDocumentStatus: 'unverified' | 'verified';
  readonly emailVerified: boolean;
  readonly smsOtpVerified: boolean;
  readonly whatsappOtpVerified: boolean;
  readonly aadhaarMobileLinked: boolean;
  readonly passwordSet: boolean;
  readonly photoStatus: 'unverified' | 'verified';
  readonly livenessPassed: boolean;
  readonly locationAccepted: boolean;
  readonly maskedMobile: string | null;
  readonly maskedAadhaar: string | null;
  /** Masked email (only after the address has been set and verified). */
  readonly maskedEmail: string | null;
  readonly finalized: boolean;
  readonly expiresAt: number;
}

export function toRegistrationStatus(
  session: RegistrationSession | null,
  maskedEmail: string | null,
): RegistrationStatus | null {
  if (!session) return null;
  return {
    walletAddress: session.walletAddress,
    active: session.finalizedAt === null,
    personalVerified: session.personalPiiCipherText !== null,
    aadhaarDocumentStatus: session.aadhaarDocumentStatus,
    emailVerified: session.emailVerified,
    smsOtpVerified: session.smsOtpVerified,
    whatsappOtpVerified: session.whatsappOtpVerified,
    aadhaarMobileLinked: session.aadhaarMobileLinked,
    passwordSet: session.passwordHash !== null,
    photoStatus: session.photoStatus,
    livenessPassed: session.livenessPassed,
    locationAccepted: session.locationAccepted,
    maskedMobile: session.maskedMobile,
    maskedAadhaar: session.maskedAadhaar,
    maskedEmail,
    finalized: session.finalizedAt !== null,
    expiresAt: session.expiresAt,
  };
}

export interface RegistrationSessionStore {
  create(session: RegistrationSession): void;
  /** Look up by opaque session token (the cookie value). */
  get(token: string): RegistrationSession | null;
  /** Look up the active session for a wallet (resources already registering). */
  getByWallet(walletAddress: string): RegistrationSession | null;
  update(token: string, patch: RegistrationSessionPatch): RegistrationSession | null;
  destroy(token: string): void;
  destroyByWallet(walletAddress: string): void;
  purgeExpired(now: number): number;
}

interface Row {
  session_token: string;
  wallet_address: string | null;
  personal_pii_ciphertext: string | null;
  masked_mobile: string | null;
  masked_aadhaar: string | null;
  aadhaar_ocr_ciphertext: string | null;
  aadhaar_document_status: 'unverified' | 'verified';
  aadhaar_document_extracted_at: number | null;
  email_verified: number;
  email_verified_at: number | null;
  sms_otp_verified: number;
  sms_otp_verified_at: number | null;
  whatsapp_otp_verified: number;
  whatsapp_otp_verified_at: number | null;
  aadhaar_mobile_linked: number;
  aadhaar_mobile_linked_at: number | null;
  password_hash: string | null;
  password_salt: string | null;
  photo_status: 'unverified' | 'verified';
  photo_content_hash: string | null;
  liveness_passed: number;
  liveness_passed_at: number | null;
  location_accepted: number;
  location_accepted_at: number | null;
  finalized_at: number | null;
  created_at: number;
  expires_at: number;
}

function rowToSession(r: Row): RegistrationSession {
  return {
    sessionToken: r.session_token,
    walletAddress: r.wallet_address ?? null,
    personalPiiCipherText: r.personal_pii_ciphertext ?? null,
    maskedMobile: r.masked_mobile ?? null,
    maskedAadhaar: r.masked_aadhaar ?? null,
    aadhaarOcrCipherText: r.aadhaar_ocr_ciphertext ?? null,
    aadhaarDocumentStatus: r.aadhaar_document_status === 'verified' ? 'verified' : 'unverified',
    aadhaarDocumentExtractedAt: r.aadhaar_document_extracted_at ?? null,
    emailVerified: r.email_verified === 1,
    emailVerifiedAt: r.email_verified_at ?? null,
    smsOtpVerified: r.sms_otp_verified === 1,
    smsOtpVerifiedAt: r.sms_otp_verified_at ?? null,
    whatsappOtpVerified: r.whatsapp_otp_verified === 1,
    whatsappOtpVerifiedAt: r.whatsapp_otp_verified_at ?? null,
    aadhaarMobileLinked: r.aadhaar_mobile_linked === 1,
    aadhaarMobileLinkedAt: r.aadhaar_mobile_linked_at ?? null,
    passwordHash: r.password_hash ?? null,
    passwordSalt: r.password_salt ?? null,
    photoStatus: r.photo_status === 'verified' ? 'verified' : 'unverified',
    photoContentHash: r.photo_content_hash ?? null,
    livenessPassed: r.liveness_passed === 1,
    livenessPassedAt: r.liveness_passed_at ?? null,
    locationAccepted: r.location_accepted === 1,
    locationAcceptedAt: r.location_accepted_at ?? null,
    finalizedAt: r.finalized_at ?? null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

function sessionToRow(s: RegistrationSession): Row {
  return {
    session_token: s.sessionToken,
    wallet_address: s.walletAddress,
    personal_pii_ciphertext: s.personalPiiCipherText,
    masked_mobile: s.maskedMobile,
    masked_aadhaar: s.maskedAadhaar,
    aadhaar_ocr_ciphertext: s.aadhaarOcrCipherText,
    aadhaar_document_status: s.aadhaarDocumentStatus,
    aadhaar_document_extracted_at: s.aadhaarDocumentExtractedAt,
    email_verified: s.emailVerified ? 1 : 0,
    email_verified_at: s.emailVerifiedAt,
    sms_otp_verified: s.smsOtpVerified ? 1 : 0,
    sms_otp_verified_at: s.smsOtpVerifiedAt,
    whatsapp_otp_verified: s.whatsappOtpVerified ? 1 : 0,
    whatsapp_otp_verified_at: s.whatsappOtpVerifiedAt,
    aadhaar_mobile_linked: s.aadhaarMobileLinked ? 1 : 0,
    aadhaar_mobile_linked_at: s.aadhaarMobileLinkedAt,
    password_hash: s.passwordHash,
    password_salt: s.passwordSalt,
    photo_status: s.photoStatus,
    photo_content_hash: s.photoContentHash,
    liveness_passed: s.livenessPassed ? 1 : 0,
    liveness_passed_at: s.livenessPassedAt,
    location_accepted: s.locationAccepted ? 1 : 0,
    location_accepted_at: s.locationAcceptedAt,
    finalized_at: s.finalizedAt,
    created_at: s.createdAt,
    expires_at: s.expiresAt,
  };
}

const RECORD_FIELD: Record<string, keyof RegistrationSession> = {
  personal_pii_ciphertext: 'personalPiiCipherText',
  masked_mobile: 'maskedMobile',
  masked_aadhaar: 'maskedAadhaar',
  aadhaar_ocr_ciphertext: 'aadhaarOcrCipherText',
  aadhaar_document_status: 'aadhaarDocumentStatus',
  aadhaar_document_extracted_at: 'aadhaarDocumentExtractedAt',
  email_verified: 'emailVerified',
  email_verified_at: 'emailVerifiedAt',
  sms_otp_verified: 'smsOtpVerified',
  sms_otp_verified_at: 'smsOtpVerifiedAt',
  whatsapp_otp_verified: 'whatsappOtpVerified',
  whatsapp_otp_verified_at: 'whatsappOtpVerifiedAt',
  aadhaar_mobile_linked: 'aadhaarMobileLinked',
  aadhaar_mobile_linked_at: 'aadhaarMobileLinkedAt',
  password_hash: 'passwordHash',
  password_salt: 'passwordSalt',
  photo_status: 'photoStatus',
  photo_content_hash: 'photoContentHash',
  liveness_passed: 'livenessPassed',
  liveness_passed_at: 'livenessPassedAt',
  location_accepted: 'locationAccepted',
  location_accepted_at: 'locationAcceptedAt',
  finalized_at: 'finalizedAt',
};

export class SqliteRegistrationSessionStore implements RegistrationSessionStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(session: RegistrationSession): void {
    const row = sessionToRow(session);
    this.db
      .prepare(
        `INSERT INTO registration_sessions
           (session_token, wallet_address, personal_pii_ciphertext, masked_mobile,
            masked_aadhaar, aadhaar_ocr_ciphertext, aadhaar_document_status,
            aadhaar_document_extracted_at, email_verified, email_verified_at,
            sms_otp_verified, sms_otp_verified_at, whatsapp_otp_verified,
            whatsapp_otp_verified_at, aadhaar_mobile_linked, aadhaar_mobile_linked_at,
            password_hash, password_salt, photo_status, photo_content_hash,
            liveness_passed, liveness_passed_at, location_accepted,
            location_accepted_at, finalized_at, created_at, expires_at)
         VALUES
           (@session_token, @wallet_address, @personal_pii_ciphertext, @masked_mobile,
            @masked_aadhaar, @aadhaar_ocr_ciphertext, @aadhaar_document_status,
            @aadhaar_document_extracted_at, @email_verified, @email_verified_at,
            @sms_otp_verified, @sms_otp_verified_at, @whatsapp_otp_verified,
            @whatsapp_otp_verified_at, @aadhaar_mobile_linked, @aadhaar_mobile_linked_at,
            @password_hash, @password_salt, @photo_status, @photo_content_hash,
            @liveness_passed, @liveness_passed_at, @location_accepted,
            @location_accepted_at, @finalized_at, @created_at, @expires_at)`,
      )
      .run(row);
  }

  get(token: string): RegistrationSession | null {
    const row = this.db.prepare('SELECT * FROM registration_sessions WHERE session_token = ?').get(token) as
      | Row
      | undefined;
    return row ? rowToSession(row) : null;
  }

  getByWallet(walletAddress: string): RegistrationSession | null {
    const row = this.db
      .prepare('SELECT * FROM registration_sessions WHERE wallet_address = ? ORDER BY created_at DESC LIMIT 1')
      .get(walletAddress) as Row | undefined;
    return row ? rowToSession(row) : null;
  }

  update(token: string, patch: RegistrationSessionPatch): RegistrationSession | null {
    const existing = this.get(token);
    if (!existing) return null;
    const merged: RegistrationSession = { ...existing, ...patch };
    const row = sessionToRow(merged);

    // Map each patched session field (camelCase) to its SQL column name.
    const FIELD_TO_COLUMN: Record<string, string> = {};
    for (const [col, field] of Object.entries(RECORD_FIELD)) {
      FIELD_TO_COLUMN[field] = col;
    }

    const sets: string[] = [];
    const values: Record<string, unknown> = {};
    for (const field of Object.keys(patch)) {
      const col = FIELD_TO_COLUMN[field];
      if (col === undefined || !(col in row)) continue;
      sets.push(`${col} = @${col}`);
      values[col] = row[col as keyof Row];
    }

    if (sets.length === 0) {
      return rowToSession(
        this.db.prepare('SELECT * FROM registration_sessions WHERE session_token = ?').get(token) as Row,
      );
    }

    this.db
      .prepare(`UPDATE registration_sessions SET ${sets.join(', ')} WHERE session_token = @session_token`)
      .run({ ...values, session_token: token });
    return rowToSession(
      this.db.prepare('SELECT * FROM registration_sessions WHERE session_token = ?').get(token) as Row,
    );
  }

  destroy(token: string): void {
    this.db.prepare('DELETE FROM registration_sessions WHERE session_token = ?').run(token);
  }

  destroyByWallet(walletAddress: string): void {
    this.db.prepare('DELETE FROM registration_sessions WHERE wallet_address = ?').run(walletAddress);
  }

  purgeExpired(now: number): number {
    const result = this.db.prepare('DELETE FROM registration_sessions WHERE expires_at < ?').run(now);
    return result.changes;
  }
}

/** Deterministic in-memory backend for tests and unconfigured bootstrapping. */
export class InMemoryRegistrationSessionStore implements RegistrationSessionStore {
  private readonly byToken = new Map<string, RegistrationSession>();

  create(session: RegistrationSession): void {
    this.byToken.set(session.sessionToken, session);
  }

  get(token: string): RegistrationSession | null {
    return this.byToken.get(token) ?? null;
  }

  getByWallet(walletAddress: string): RegistrationSession | null {
    let latest: RegistrationSession | null = null;
    for (const s of this.byToken.values()) {
      if (s.walletAddress === walletAddress && (!latest || s.createdAt > latest.createdAt)) latest = s;
    }
    return latest;
  }

  update(token: string, patch: RegistrationSessionPatch): RegistrationSession | null {
    const existing = this.byToken.get(token);
    if (!existing) return null;
    const merged: RegistrationSession = { ...existing, ...patch };
    this.byToken.set(token, merged);
    return merged;
  }

  destroy(token: string): void {
    this.byToken.delete(token);
  }

  destroyByWallet(walletAddress: string): void {
    for (const [token, s] of this.byToken) {
      if (s.walletAddress === walletAddress) this.byToken.delete(token);
    }
  }

  purgeExpired(now: number): number {
    let removed = 0;
    for (const [token, s] of this.byToken) {
      if (s.expiresAt < now) {
        this.byToken.delete(token);
        removed += 1;
      }
    }
    return removed;
  }
}

// ── Forgot-password sessions ──────────────────────────────────────
//
// A forgot-password session binds the RESET only after the server has
// verified all three gates in order: the email OTP, the liveness challenges,
// and the biometric ownership match. Nothing sensitive is stored; only the
// three verified booleans plus freshness bounds.

export interface ForgotPasswordSession {
  readonly walletAddress: string;
  readonly emailVerified: boolean;
  readonly livenessPassed: boolean;
  readonly biometricVerified: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type ForgotPasswordSessionPatch = Partial<
  Pick<ForgotPasswordSession, 'emailVerified' | 'livenessPassed' | 'biometricVerified'>
>;

export interface ForgotPasswordSessionStore {
  get(walletAddress: string): ForgotPasswordSession | null;
  create(session: ForgotPasswordSession): void;
  update(
    walletAddress: string,
    patch: ForgotPasswordSessionPatch,
  ): ForgotPasswordSession | null;
  destroy(walletAddress: string): void;
  purgeExpired(now: number): number;
}

interface ForgotRow {
  wallet_address: string;
  email_verified: number;
  liveness_passed: number;
  biometric_verified: number;
  created_at: number;
  expires_at: number;
}

function rowToForgotSession(r: ForgotRow): ForgotPasswordSession {
  return {
    walletAddress: r.wallet_address,
    emailVerified: r.email_verified === 1,
    livenessPassed: r.liveness_passed === 1,
    biometricVerified: r.biometric_verified === 1,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

function forgotSessionToRow(s: ForgotPasswordSession): ForgotRow {
  return {
    wallet_address: s.walletAddress,
    email_verified: s.emailVerified ? 1 : 0,
    liveness_passed: s.livenessPassed ? 1 : 0,
    biometric_verified: s.biometricVerified ? 1 : 0,
    created_at: s.createdAt,
    expires_at: s.expiresAt,
  };
}

const FORGOT_PATCH_COLUMNS: readonly (keyof ForgotRow)[] = [
  'email_verified',
  'liveness_passed',
  'biometric_verified',
];

export class SqliteForgotPasswordSessionStore implements ForgotPasswordSessionStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  get(walletAddress: string): ForgotPasswordSession | null {
    const row = this.db
      .prepare('SELECT * FROM forgot_password_sessions WHERE wallet_address = ?')
      .get(walletAddress) as ForgotRow | undefined;
    return row ? rowToForgotSession(row) : null;
  }

  create(session: ForgotPasswordSession): void {
    this.db
      .prepare(
        `INSERT INTO forgot_password_sessions
           (wallet_address, email_verified, liveness_passed, biometric_verified, created_at, expires_at)
         VALUES (@wallet_address, @email_verified, @liveness_passed, @biometric_verified, @created_at, @expires_at)`,
      )
      .run(forgotSessionToRow(session));
  }

  update(walletAddress: string, patch: ForgotPasswordSessionPatch): ForgotPasswordSession | null {
    const existing = this.get(walletAddress);
    if (!existing) return null;
    const merged: ForgotPasswordSession = { ...existing, ...patch };
    const row = forgotSessionToRow(merged);
    const sets = FORGOT_PATCH_COLUMNS.map((col) => `${col} = @${col}`).join(', ');
    this.db
      .prepare(`UPDATE forgot_password_sessions SET ${sets} WHERE wallet_address = @wallet_address`)
      .run({ ...row, wallet_address: walletAddress });
    return rowToForgotSession(
      this.db
        .prepare('SELECT * FROM forgot_password_sessions WHERE wallet_address = ?')
        .get(walletAddress) as ForgotRow,
    );
  }

  destroy(walletAddress: string): void {
    this.db.prepare('DELETE FROM forgot_password_sessions WHERE wallet_address = ?').run(walletAddress);
  }

  purgeExpired(now: number): number {
    const result = this.db.prepare('DELETE FROM forgot_password_sessions WHERE expires_at < ?').run(now);
    return result.changes;
  }
}

/** Deterministic in-memory backend for tests. */
export class InMemoryForgotPasswordSessionStore implements ForgotPasswordSessionStore {
  private readonly byWallet = new Map<string, ForgotPasswordSession>();

  get(walletAddress: string): ForgotPasswordSession | null {
    return this.byWallet.get(walletAddress) ?? null;
  }

  create(session: ForgotPasswordSession): void {
    this.byWallet.set(session.walletAddress, session);
  }

  update(walletAddress: string, patch: ForgotPasswordSessionPatch): ForgotPasswordSession | null {
    const existing = this.byWallet.get(walletAddress);
    if (!existing) return null;
    const merged: ForgotPasswordSession = { ...existing, ...patch };
    this.byWallet.set(walletAddress, merged);
    return merged;
  }

  destroy(walletAddress: string): void {
    this.byWallet.delete(walletAddress);
  }

  purgeExpired(now: number): number {
    let removed = 0;
    for (const [wallet, s] of this.byWallet) {
      if (s.expiresAt < now) {
        this.byWallet.delete(wallet);
        removed += 1;
      }
    }
    return removed;
  }
}