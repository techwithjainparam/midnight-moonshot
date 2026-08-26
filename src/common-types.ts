/**
 * PRIESTATE common types and abstractions.
 * @module
 */

import { type MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { type FoundContract } from '@midnight-ntwrk/midnight-js-contracts';
import { type PriestatePrivateState } from './contract/index.js';

export const priestatePrivateStateKey = 'priestatePrivateState';
export type PriestatePrivateStateId = typeof priestatePrivateStateKey;

export type PriestateCircuitKeys = 'checkEligibility';
export type PriestateProviders = MidnightProviders<PriestateCircuitKeys, PriestatePrivateStateId, PriestatePrivateState>;
export type DeployedPriestateContract = FoundContract<any>;

export interface PriestateDerivedState {
  readonly eligibilityThreshold: bigint;
  readonly eligibilityResult: boolean;
}
