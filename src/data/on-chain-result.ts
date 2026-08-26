/**
 * Session-scoped record of an ON-CHAIN eligibility verification result.
 *
 * The only source of a verification result is the contract's public ledger
 * (`eligibilityResult`), captured right after the checkEligibility
 * transaction finalizes. This module passes that value from the verify flow
 * to the result page within the same browser session. It never stores or
 * derives the private property value.
 */

export interface OnChainEligibilityRecord {
  propertyId: string;
  /** The boolean published by the contract's ledger state. */
  result: boolean;
  finalizedAt: string;
}

const KEY_PREFIX = 'priestate.onChainEligibility.';

function storage(): Storage | undefined {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage;
  } catch {
    /* node/test environment */
  }
  return undefined;
}

export function saveOnChainEligibility(record: OnChainEligibilityRecord): void {
  storage()?.setItem(KEY_PREFIX + record.propertyId, JSON.stringify(record));
}

/** Returns the recorded ON-CHAIN result, or null when none exists this session. */
export function loadOnChainEligibility(
  propertyId: string,
): OnChainEligibilityRecord | null {
  const raw = storage()?.getItem(KEY_PREFIX + propertyId);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OnChainEligibilityRecord>;
    if (
      parsed &&
      typeof parsed.result === 'boolean' &&
      typeof parsed.finalizedAt === 'string'
    ) {
      return {
        propertyId,
        result: parsed.result,
        finalizedAt: parsed.finalizedAt,
      };
    }
  } catch {
    /* corrupt entry — treat as unverified */
  }
  return null;
}
