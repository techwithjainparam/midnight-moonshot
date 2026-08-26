import { CompiledContract } from '@midnight-ntwrk/compact-js';

export * as Priestate from '../../contracts/managed/priestate/contract/index.js';
export { createWitnesses, setPropertyValue, createPriestatePrivateState } from './witnesses.js';
export type { PriestatePrivateState } from './witnesses.js';

import * as PriestateContract from '../../contracts/managed/priestate/contract/index.js';
import { createWitnesses } from './witnesses.js';

export const CompiledPriestateContract = CompiledContract.make(
  'priestate',
  PriestateContract.Contract,
).pipe(
  CompiledContract.withWitnesses(createWitnesses()),
  CompiledContract.withCompiledFileAssets('./contracts/managed/priestate'),
);
