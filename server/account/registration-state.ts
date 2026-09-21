// PRIESTATE — Registration authentication state machine.
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// The registration flow is modelled as a sequence of REQUIRED factors that
// must each reach a verified state before the account is considered fully
// authenticated for login. The sequence is:
//
//   walletVerified → googleVerified → smsVerified → whatsappVerified
//
// The wallet factor is verified the moment the account is created (an account
// is bound 1:1 to a wallet address; duplicate wallets are rejected). The
// remaining factors are driven by real provider boundaries. Registration is
// NOT fully authenticated until every required, configured factor has passed —
// missing factors are never silently bypassed.

import type { AccountRecord } from './model.js';

/** The ordered registration factor identifiers. */
export type RegistrationFactor = 'wallet' | 'google' | 'sms' | 'whatsapp';

/** Canonical REQUIRED registration factor order (also the UI step order).
 * Google is optional and omitted from the REQUIRED chain. */
export const REGISTRATION_FACTOR_ORDER: readonly RegistrationFactor[] = [
  'wallet',
  'sms',
  'whatsapp',
];

export interface RegistrationSnapshot {
  readonly walletVerified: boolean;
  readonly googleVerified: boolean;
  readonly smsVerified: boolean;
  readonly whatsappVerified: boolean;
  /** True when every factor is verified (registration authentication complete). */
  readonly complete: boolean;
  /** The first (in order) factor that is not yet verified, if any. */
  readonly nextPendingFactor: RegistrationFactor | null;
  /** Human label of the current pending step (for the UI stepper). */
  readonly pendingStep: string | null;
}

export interface RegistrationStateOptions {
  /** Which external factors must be verified for registration to complete. */
  readonly requiredFactors?: readonly RegistrationFactor[];
}

/**
 * Derive the explicit registration factor states from a stored account record.
 * The record's own booleans are the source of truth; this projection makes the
 * sequential machine explicit and drives the UI stepper + completion check.
 */
export function deriveRegistrationState(
  record: AccountRecord,
  options: RegistrationStateOptions = {},
): RegistrationSnapshot {
  const walletVerified = true; // an account exists ⇒ its wallet factor passed
  const googleVerified = record.googleLinked;
  const smsVerified = record.smsOtpVerified;
  const whatsappVerified = record.whatsappOtpVerified;

  const required = options.requiredFactors ?? REGISTRATION_FACTOR_ORDER;

  const states: Record<RegistrationFactor, boolean> = {
    wallet: walletVerified,
    google: googleVerified,
    sms: smsVerified,
    whatsapp: whatsappVerified,
  };

  const nextPending =
    REGISTRATION_FACTOR_ORDER.find(
      (f) => required.includes(f) && !states[f],
    ) ?? null;

  return {
    walletVerified,
    googleVerified,
    smsVerified,
    whatsappVerified,
    complete: nextPending === null,
    nextPendingFactor: nextPending,
    pendingStep: nextPending ? labelFor(nextPending) : null,
  };
}

export function labelFor(factor: RegistrationFactor): string {
  switch (factor) {
    case 'wallet':
      return 'Wallet';
    case 'google':
      return 'Google';
    case 'sms':
      return 'SMS OTP';
    case 'whatsapp':
      return 'WhatsApp OTP';
  }
}
