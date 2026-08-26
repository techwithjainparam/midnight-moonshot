/**
 * Fixed contract-address resolution for PRIESTATE.
 *
 * Verification must JOIN an already-deployed contract rather than deploying
 * a fresh one per page visit. The address is resolved once, from (in order):
 *
 *   1. VITE_DEFAULT_CONTRACT            — explicit build/dev configuration
 *   2. __PRIESTATE_DEPLOYED__           — injected by vite.config.ts from the
 *                                         network-matched entry in
 *                                         .midnight-state.json (written by
 *                                         `npm run deploy`)
 *
 * If neither yields an address for the ACTIVE network, callers fall back to
 * the existing deploy-with-threshold path. This module never invents an
 * address: an absent or mismatched record resolves to undefined.
 *
 * Browser-safe: no Node built-ins. `import.meta.env` is provided by Vite;
 * `process.env` is only consulted under Node (tests/SSR) where it exists.
 */

export type PriestateNetworkId = 'undeployed' | 'preview' | 'preprod';

const VALID_NETWORK_IDS: readonly PriestateNetworkId[] = ['undeployed', 'preview', 'preprod'];
const HEX_CONTRACT_RE = /^[0-9a-fA-F]{64}$/;

/** Mirrors the validation in hooks/useWallet.ts without importing React code. */
export function activeNetworkId(): PriestateNetworkId {
  const raw =
    readImportMetaEnv()?.VITE_NETWORK_ID ?? process.env?.VITE_NETWORK_ID ?? 'preprod';
  return (VALID_NETWORK_IDS as readonly string[]).includes(raw)
    ? (raw as PriestateNetworkId)
    : 'preprod';
}

export function isValidContractAddress(v: unknown): v is string {
  return typeof v === 'string' && HEX_CONTRACT_RE.test(v);
}

interface InjectedDeployment {
  network: string;
  address: string;
}

function readImportMetaEnv(): Record<string, string | undefined> | undefined {
  // Guarded so the module also loads under plain Node (tsx --test).
  try {
    return (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  } catch {
    return undefined;
  }
}

function readInjectedDeployment(): InjectedDeployment | null {
  // Direct identifier reference: vite.config.ts `define` substitutes it at
  // build time. The `typeof` guard keeps this module importable under plain
  // Node (unit tests), where the constant is absent unless a test sets
  // globalThis.__PRIESTATE_DEPLOYED__ explicitly.
  if (typeof __PRIESTATE_DEPLOYED__ === 'undefined') return null;
  const v = __PRIESTATE_DEPLOYED__;
  return v && typeof v === 'object' && typeof v.address === 'string' ? v : null;
}

export interface FixedAddressResolution {
  address: string;
  source: 'VITE_DEFAULT_CONTRACT' | 'deployment-state';
}

/**
 * Resolve the fixed PRIESTATE contract address for the given network, or
 * undefined when verification should fall back to the deploy path.
 */
export function getFixedContractAddress(
  networkId: PriestateNetworkId = activeNetworkId(),
): FixedAddressResolution | undefined {
  const fromEnv =
    readImportMetaEnv()?.VITE_DEFAULT_CONTRACT ?? process.env?.VITE_DEFAULT_CONTRACT;
  if (isValidContractAddress(fromEnv)) {
    return { address: fromEnv, source: 'VITE_DEFAULT_CONTRACT' };
  }

  const injected = readInjectedDeployment();
  if (
    injected &&
    injected.network === networkId &&
    isValidContractAddress(injected.address)
  ) {
    return { address: injected.address, source: 'deployment-state' };
  }

  return undefined;
}
