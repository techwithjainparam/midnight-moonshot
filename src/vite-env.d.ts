/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public base URL of the PRIESTATE verification API. NOT a secret. */
  readonly VITE_VERIFICATION_API_URL?: string;
  readonly VITE_NETWORK_ID?: string;
  readonly VITE_DEFAULT_CONTRACT?: string;
  readonly VITE_DEFAULT_THRESHOLD?: string;
  readonly VITE_DEMO_OFFICER_ADDRESSES?: string;
}

/**
 * Build-time constant injected by vite.config.ts: the deployment recorded in
 * .midnight-state.json for the active network (null when none matches).
 * Consumed by src/contract-address.ts — do not use directly elsewhere.
 */
declare const __PRIESTATE_DEPLOYED__: { network: string; address: string } | null;
