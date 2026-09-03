// PRIESTATE — Client-side account session store (Level 3).
//
// Stores ONLY public-safe account state per wallet address: accountId, masked
// display fragments, and booleans for which factors have completed. It NEVER
// stores a password, an OTP, the raw Aadhaar, the address, the DOB, the
// mobile, the passport photo, or a selfie — those live only server-side
// (encrypted at rest). Like all demo-client storage it is NOT a security
// boundary; the multi-factor enforcement happens on the verification server.

import type { PublicAccountView } from './account-types';

const STORAGE_KEY = 'priestate.accounts.v1';

export interface ClientAccount {
  readonly accountId: string;
  readonly walletAddress: string;
  readonly fullName?: string;
  readonly maskedMobile: string;
  readonly maskedAadhaar: string;
  readonly smsOtpVerified: boolean;
  readonly whatsappOtpVerified: boolean;
  readonly googleLinked: boolean;
  readonly identityVerified: boolean;
  readonly createdAt: number;
}

function read(): Map<string, ClientAccount> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as ClientAccount[];
    if (!Array.isArray(parsed)) return new Map();
    return new Map(parsed.map((a) => [a.walletAddress, a]));
  } catch {
    return new Map();
  }
}

function write(accounts: Map<string, ClientAccount>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...accounts.values()]));
  } catch {
    // Storage unavailable → session-only account state.
  }
}

/** Persist a server account view, dropping anything not safe to keep. */
export function saveAccount(view: PublicAccountView): ClientAccount {
  const accounts = read();
  const safe: ClientAccount = {
    accountId: view.accountId,
    walletAddress: view.walletAddress,
    fullName: view.fullName,
    maskedMobile: view.maskedMobile,
    maskedAadhaar: view.maskedAadhaar,
    smsOtpVerified: view.smsOtpVerified,
    whatsappOtpVerified: view.whatsappOtpVerified,
    googleLinked: view.googleLinked,
    identityVerified: view.identityVerified,
    createdAt: view.createdAt,
  };
  accounts.set(safe.walletAddress, safe);
  write(accounts);
  return safe;
}

export function getAccount(walletAddress: string): ClientAccount | null {
  return read().get(walletAddress) ?? null;
}

export function listAccounts(): ClientAccount[] {
  return [...read().values()];
}

/** Clear the stored account for a wallet (used on logout). */
export function removeAccount(walletAddress: string): void {
  const accounts = read();
  accounts.delete(walletAddress);
  write(accounts);
}

/** True only when every factor for a stored account has completed. */
export function isAccountFullyVerified(account: ClientAccount | null): boolean {
  if (!account) return false;
  return (
    account.identityVerified &&
    account.googleLinked &&
    account.smsOtpVerified &&
    account.whatsappOtpVerified
  );
}

/** Flip the local identity-verified flag for a wallet (outcome already sent). */
export function markClientIdentityVerified(walletAddress: string): ClientAccount | null {
  const accounts = read();
  const existing = accounts.get(walletAddress);
  if (!existing) return null;
  const next: ClientAccount = { ...existing, identityVerified: true };
  accounts.set(walletAddress, next);
  write(accounts);
  return next;
}
