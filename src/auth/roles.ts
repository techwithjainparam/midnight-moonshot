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
 * Demo binding of registry records to "the current user".
 *
 * There is no backend yet, so mock records cannot be tied to real wallet
 * addresses. For demonstration purposes every connected USER is treated
 * as the owner of these record ids. DEMO ONLY.
 */
export const DEMO_USER_PROPERTY_IDS: readonly string[] = ['reg-001', 'reg-003'];

export function isOwnedByCurrentUser(propertyId: string): boolean {
  return DEMO_USER_PROPERTY_IDS.includes(propertyId);
}
