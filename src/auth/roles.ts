// PRIESTATE — Role & access model (DEMO).
//
// Defines the two application roles:
//
//   USER    — a connected wallet that owns/manages its own applications.
//   OFFICER — an authorized registry officer who reviews submitted
//             applications in the Officer Portal.
//
// ═══════════════════════════════════════════════════════════════════
// ⚠️  DEMO AUTHORIZATION — NOT PRODUCTION AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════
//
// Officer authorization below is a DEMO MECHANISM ONLY. It does NOT
// represent government identity verification, credentialing, or any
// production-grade authentication. Real deployments must replace this
// with proper authorized-officer credentials issued/verified by the
// responsible authority (and ultimately enforced on-chain / by the
// backend authorization layer).
//
// Demo mechanism (in order of precedence):
//
// 1. Allow-list: addresses listed in VITE_DEMO_OFFICER_ADDRESSES
//    (comma-separated, set at build time) are treated as officers.
// 2. Explicit demo grant: `grantDemoOfficer()` stores a session-scoped
//    flag. It is only exposed behind the clearly-labeled "DEMO
//    SIMULATION" control on the Officer Portal unauthorized screen so
//    the portal UX can be exercised without pre-configured addresses.
//
// Everything here is client-side and trivially bypassable; it exists to
// shape the UI/UX correctly (separation of roles), not to secure data.

export type Role = 'USER' | 'OFFICER';

/** Session-storage key for the explicit demo officer grant. */
const DEMO_OFFICER_GRANT_KEY = 'priestate.demo.officer-grant';

// Fallback when sessionStorage is unavailable (tests, storage disabled).
let memoryGrant = false;

function envAllowList(): string[] {
  // Guarded access so this module stays importable outside Vite (tests/node).
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const raw = env?.VITE_DEMO_OFFICER_ADDRESSES ?? '';
  return raw
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
}

export function isDemoOfficerAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return envAllowList().includes(normalized);
}

export function hasDemoOfficerGrant(): boolean {
  try {
    return sessionStorage.getItem(DEMO_OFFICER_GRANT_KEY) === 'granted';
  } catch {
    return memoryGrant;
  }
}

/**
 * Explicitly simulate officer authorization for this session.
 * DEMO ONLY — cleared when the browser tab closes.
 */
export function grantDemoOfficer(): void {
  memoryGrant = true;
  try {
    sessionStorage.setItem(DEMO_OFFICER_GRANT_KEY, 'granted');
  } catch {
    // sessionStorage unavailable — in-memory fallback still applies.
  }
}

export function revokeDemoOfficer(): void {
  memoryGrant = false;
  try {
    sessionStorage.removeItem(DEMO_OFFICER_GRANT_KEY);
  } catch {
    // ignore
  }
}

/**
 * Determine the role of a connected wallet.
 *
 * wallet connected → determine role → USER | OFFICER
 *
 * A disconnected wallet has no role (callers must handle that before
 * calling this — see AuthContext).
 */
export function determineRole(address: string): Role {
  if (isDemoOfficerAddress(address) || hasDemoOfficerGrant()) {
    return 'OFFICER';
  }
  return 'USER';
}

/**
 * Registry-record ownership.
 *
 * SECURITY: ownership is NEVER decided in the browser. The previous build
 * hardcoded a list of record ids that every connected wallet was treated as
 * owning, which granted production users access to other people's records.
 * That list is gone.
 *
 * A client-side id list is not authorization, so this now fails closed: no
 * record is "owned" by the connected wallet on the strength of frontend
 * state alone. Records are visible to a USER only when they are finalized
 * and APPROVED (see `src/data/visibility.ts`). Real per-wallet ownership
 * must come from a server-side authorization check — there is no such
 * endpoint yet, so nothing claims to own anything.
 */
export function isOwnedByCurrentUser(_propertyId: string): boolean {
  return false;
}
