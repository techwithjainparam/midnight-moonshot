// PRIESTATE — Login authentication state machine (Level 3 Part 5).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// The login flow is modelled as a SEQUENCE of REQUIRED factors that must each
// reach a verified state before the account is granted an authenticated
// server session. The sequence is:
//
//   wallet → google → sms → whatsapp → complete
//
//   * wallet  — verified the moment an account exists for the connected wallet
//               (an account is bound 1:1 to a wallet; duplicate wallets are
//               rejected at registration). This is the authoritative
//               server-side account-existence check.
//   * google  — real OAuth provider boundary (wallet-bound state + nonce).
//   * sms     — SMS OTP (server-generated, hashed, short-lived, single-use).
//   * whatsapp— WhatsApp OTP (same OTP security contract).
//   * complete— the terminal step: ONLY once every required factor is verified
//               does the server mint an authenticated session (see
//               AccountService.login).
//
// This projection is derived from the same persisted account record that
// registration uses, but is framed explicitly as the LOGIN factor sequence.
// It never fabricates a factor and never leaks PII: it exposes only booleans
// and a human step label. A missing factor is never silently skipped.
//
// Nothing here ever reaches the Midnight ledger.

import type { AccountRecord } from './model.js';

/** The ordered login factor identifiers (excluding the terminal Complete). */
export type LoginFactor = 'wallet' | 'google' | 'sms' | 'whatsapp';

/** Canonical REQUIRED login factor order (also the UI step order). Google is
 * optional and therefore omitted from the REQUIRED chain. */
export const LOGIN_FACTOR_ORDER: readonly LoginFactor[] = [
  'wallet',
  'sms',
  'whatsapp',
];

export interface LoginSnapshot {
  /** True only when an account exists for the wallet (the wallet factor). */
  readonly walletVerified: boolean;
  readonly googleVerified: boolean;
  readonly smsVerified: boolean;
  readonly whatsappVerified: boolean;
  /** True when every REQUIRED login factor is verified (ready for Complete). */
  readonly allFactorsReady: boolean;
  /** The first (in order) factor that is not yet verified, if any. */
  readonly nextPendingFactor: LoginFactor | null;
  /** Human label of the current pending step (for the UI stepper). */
  readonly pendingStep: string | null;
}

export interface LoginStateOptions {
  /** Which external factors must be verified for login to complete. */
  readonly requiredFactors?: readonly LoginFactor[];
}

/**
 * Derive the explicit login factor states from a stored account record. The
 * record's own booleans are the source of truth; this projection makes the
 * sequential login machine explicit and drives the UI stepper + the session
 * readiness gate. A null record yields null (no account ⇒ no login state).
 */
export function deriveLoginState(
  record: AccountRecord | null,
  options: LoginStateOptions = {},
): LoginSnapshot | null {
  if (!record) return null;

  const required = options.requiredFactors ?? LOGIN_FACTOR_ORDER;
  const walletVerified = true; // an account exists ⇒ its wallet factor passed
  const googleVerified = record.googleLinked;
  const smsVerified = record.smsOtpVerified;
  const whatsappVerified = record.whatsappOtpVerified;

  const states: Record<LoginFactor, boolean> = {
    wallet: walletVerified,
    google: googleVerified,
    sms: smsVerified,
    whatsapp: whatsappVerified,
  };

  const nextPendingFactor =
    LOGIN_FACTOR_ORDER.find(
      (f) => required.includes(f) && !states[f],
    ) ?? null;

  return {
    walletVerified,
    googleVerified,
    smsVerified,
    whatsappVerified,
    allFactorsReady: nextPendingFactor === null,
    nextPendingFactor,
    pendingStep: nextPendingFactor ? labelFor(nextPendingFactor) : null,
  };
}

export function labelFor(factor: LoginFactor): string {
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