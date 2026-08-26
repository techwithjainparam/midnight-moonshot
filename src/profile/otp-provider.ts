// PRIESTATE — Pluggable OTP provider architecture (FEATURE 1).
//
// The contact-verification flow issues a one-time code through an
// `OtpProvider`. The interface is deliberately backend-shaped so a real
// SMS/email provider can be dropped in without touching the UI:
//
//   sendOtp(contact)            → issues/delivers a code for the contact
//   verifyOtp(contact, code)    → checks a user-entered code
//
// ═══════════════════════════════════════════════════════════════════
// ⚠️  NO REAL OTP PROVIDER IS CONFIGURED IN THIS PROJECT
// ═══════════════════════════════════════════════════════════════════
// The default provider is `DemoLocalOtpProvider` (see
// ./demo-otp-provider.ts): codes are generated client-side, held in
// memory, and DISPLAYED ON SCREEN. It sets `deliversRealCodes = false`,
// which forces the UI to show the code with a clear "development mode"
// label instead of claiming anything was sent by SMS/email.
//
// To go to production, implement `OtpProvider` against your backend
// (server-issued codes delivered via SMS/email, rate limiting, delivery
// receipts; API keys held server-side only) and register it:
//
//   setOtpProvider(new MyBackendOtpProvider());
//
// No paid service is configured or assumed here — that decision is left
// entirely to the deployment.
// ═══════════════════════════════════════════════════════════════════

import type { ContactType } from './contact-verification';
import { DemoLocalOtpProvider } from './demo-otp-provider';

/** The contact a code is issued for / verified against. */
export interface OtpContact {
  readonly contactType: ContactType;
  /** Normalized email address or E.164-style mobile number. */
  readonly contactValue: string;
}

/** A code issuance. `devCode` is present ONLY when no real delivery exists. */
export interface OtpChallenge {
  /** Epoch ms at which the issued code expires. */
  readonly expiresAt: number;
  /**
   * Development-only: the raw code, shown on screen because nothing was
   * actually delivered. Real providers MUST leave this undefined.
   */
  readonly devCode?: string;
}

export type OtpSendResult =
  | { ok: true; challenge: OtpChallenge }
  | { ok: false; reason: 'unsupported' | 'provider-error'; message?: string };

export type OtpVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'invalid' | 'too-many-attempts' };

export interface OtpProvider {
  /** Stable identifier recorded for traceability. */
  readonly name: string;
  readonly displayName: string;
  /**
   * True ONLY when this provider actually delivers codes out-of-band
   * (SMS/email) via a backend. When false, the UI must never claim a
   * code was sent — it shows the on-screen development code instead.
   */
  readonly deliversRealCodes: boolean;
  /** Issue (and, for real providers, deliver) a one-time code. */
  sendOtp(contact: OtpContact): Promise<OtpSendResult>;
  /** Check a user-entered code against the active challenge. */
  verifyOtp(contact: OtpContact, code: string): Promise<OtpVerifyResult>;
}

// ── Provider selection ─────────────────────────────────────────────

const defaultOtpProvider: OtpProvider = new DemoLocalOtpProvider();

let configuredProvider: OtpProvider | null = null;

/**
 * Register the OTP provider used by the app. Intended for a real
 * backend-backed implementation; pass `null` to restore the development
 * fallback (`DemoLocalOtpProvider`).
 */
export function setOtpProvider(provider: OtpProvider | null): void {
  configuredProvider = provider;
}

/** The active OTP provider (development fallback unless overridden). */
export function getOtpProvider(): OtpProvider {
  return configuredProvider ?? defaultOtpProvider;
}
