/**
 * PRIESTATE common types and abstractions.
 * @module
 */

import { type MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { type FoundContract } from '@midnight-ntwrk/midnight-js-contracts';
import { type Registration } from '../contracts/managed/priestate/contract/index.js';
import { type PriestatePrivateState } from './contract/index.js';

export const priestatePrivateStateKey = 'priestatePrivateState';
export type PriestatePrivateStateId = typeof priestatePrivateStateKey;

export type PriestateCircuitKeys =
  | 'checkEligibility'
  | 'submitRegistration'
  | 'approveRegistration'
  | 'rejectRegistration';
export type PriestateProviders = MidnightProviders<PriestateCircuitKeys, PriestatePrivateStateId, PriestatePrivateState>;
export type DeployedPriestateContract = FoundContract<any>;

export { RegistrationStatus } from '../contracts/managed/priestate/contract/index.js';
export type { Registration as PriestateRegistration } from '../contracts/managed/priestate/contract/index.js';

export interface PriestateDerivedState {
  readonly eligibilityThreshold: bigint;
  readonly eligibilityResult: boolean;
  readonly officer: Uint8Array;
  readonly registrationCounter: bigint;
  readonly registrations: ReadonlyMap<bigint, Registration>;
}
