// PRIESTATE — Development OTP fallback (FEATURE 1).
//
// ═══════════════════════════════════════════════════════════════════
// ⚠️  DEMO/DEV ONLY — NOT PRODUCTION AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════
// No SMS/email backend exists in this project. This provider:
//
//   * generates codes client-side and holds them in memory only,
//   * NEVER delivers anything — it returns the code as `devCode` so the
//     UI can display it on screen with a clear development label,
//   * proves NOTHING about control of the email/phone number.
//
// It exists purely so the verification UX can be exercised locally.
// Replace it via `setOtpProvider(...)` with a real backend-backed
// implementation before any production use.
// ═══════════════════════════════════════════════════════════════════

import type { ContactType } from './contact-verification';
import type {
  OtpContact,
  OtpProvider,
  OtpSendResult,
  OtpVerifyResult,
} from './otp-provider';

interface DemoOtpEntry {
  code: string;
  expiresAt: number;
  attempts: number;
}

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

/** In-memory only — codes never persist and are cleared on reload. */
const demoOtps = new Map<string, DemoOtpEntry>();

function otpKey(contactType: ContactType, contactValue: string): string {
  return `${contactType}:${contactValue.trim().toLowerCase()}`;
}

export interface DemoOtp {
  /** The 6-digit code. Returned to the UI for on-screen display only. */
  readonly code: string;
  readonly expiresAt: number;
}

/**
 * Generate a fresh DEMO verification code for a contact value.
 * DEMO ONLY — a real implementation issues codes server-side and
 * delivers them via SMS/email; nothing here is secure.
 */
export function createDemoOtp(contactType: ContactType, contactValue: string): DemoOtp {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const entry: DemoOtpEntry = { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 };
  demoOtps.set(otpKey(contactType, contactValue), entry);
  return { code, expiresAt: entry.expiresAt };
}

export type DemoOtpResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'invalid' | 'too-many-attempts' };

/** Check a code against the active DEMO OTP for a contact value. */
export function verifyDemoOtp(contactType: ContactType, contactValue: string, code: string): DemoOtpResult {
  const key = otpKey(contactType, contactValue);
  const entry = demoOtps.get(key);
  if (!entry) return { ok: false, reason: 'expired' };
  if (Date.now() > entry.expiresAt) {
    demoOtps.delete(key);
    return { ok: false, reason: 'expired' };
  }
  if (entry.attempts >= MAX_OTP_ATTEMPTS) {
    demoOtps.delete(key);
    return { ok: false, reason: 'too-many-attempts' };
  }
  entry.attempts += 1;
  if (code.trim() !== entry.code) {
    return entry.attempts >= MAX_OTP_ATTEMPTS
      ? { ok: false, reason: 'too-many-attempts' }
      : { ok: false, reason: 'invalid' };
  }
  demoOtps.delete(key);
  return { ok: true };
}

/**
 * OtpProvider implementation wrapping the local DEMO logic above.
 * `deliversRealCodes` is always false — the UI relies on this flag to
 * show the code honestly instead of claiming an SMS/email was sent.
 */
export class DemoLocalOtpProvider implements OtpProvider {
  readonly name = 'demo-local-otp';
  readonly displayName = 'Development OTP (code shown on screen)';
  readonly deliversRealCodes = false as const;

  async sendOtp(contact: OtpContact): Promise<OtpSendResult> {
    const otp = createDemoOtp(contact.contactType, contact.contactValue);
    return {
      ok: true,
      challenge: { expiresAt: otp.expiresAt, devCode: otp.code },
    };
  }

  async verifyOtp(contact: OtpContact, code: string): Promise<OtpVerifyResult> {
    return verifyDemoOtp(contact.contactType, contact.contactValue, code);
  }
}
