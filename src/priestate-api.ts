/**
 * Shared business logic for the PRIESTATE contract.
 *
 * Platform-agnostic — works from browser (Lace) or CLI (wallet-sdk).
 * Each platform provides its own provider implementations.
 *
 * @packageDocumentation
 */

import * as Priestate from '../contracts/managed/priestate/contract/index.js';
import { type ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { type Logger } from 'pino';
import {
  type PriestateDerivedState,
  type PriestateProviders,
  type DeployedPriestateContract,
  priestatePrivateStateKey,
} from './common-types.js';
import { CompiledPriestateContract, createPriestatePrivateState } from './contract/index.js';
import { setPropertyValue } from './contract/witnesses.js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import {
  map,
  concatMap,
  take,
  timeout,
  throwError,
  from,
  firstValueFrom,
  type Observable,
} from 'rxjs';

/**
 * API for a deployed PRIESTATE contract.
 *
 * Created via `PriestateAPI.deploy()` (admin) or `PriestateAPI.join()` (player).
 */
export class PriestateAPI {
  private constructor(
    public readonly deployedContract: DeployedPriestateContract,
    providers: PriestateProviders,
    private readonly logger?: Logger,
  ) {
    this.deployedContractAddress = deployedContract.deployTxData.public.contractAddress;
    providers.privateStateProvider.setContractAddress(this.deployedContractAddress);

    this.state$ = providers.publicDataProvider
      .contractStateObservable(this.deployedContractAddress, { type: 'latest' })
      .pipe(
        map((contractState) => Priestate.ledger(contractState.data)),
        map((ledgerState): PriestateDerivedState => ({
          eligibilityThreshold: ledgerState.eligibilityThreshold,
          eligibilityResult: ledgerState.eligibilityResult,
        })),
      );
  }

  readonly deployedContractAddress: ContractAddress;
  readonly state$: Observable<PriestateDerivedState>;

  /**
   * Privately check whether the given property value meets the contract's
   * eligibility threshold. The value is fed to the `checkEligibility`
   * circuit via the `propertyValue` witness and never leaves the client.
   *
   * Resolves with the ON-CHAIN `eligibilityResult` from the contract's
   * public ledger state once the transaction has finalized — never a
   * client-side recomputation.
   */
  async checkEligibility(propertyValue: bigint): Promise<boolean> {
    setPropertyValue(propertyValue);
    this.logger?.info({ deployedContractAddress: this.deployedContractAddress }, 'Checking eligibility for property value');
    return firstResultAfterTx(
      (this.deployedContract as any).callTx.checkEligibility(),
      this.state$,
    );
  }

  /** Deploy a new PRIESTATE contract with the given eligibility threshold (admin operation). */
  static async deploy(
    providers: PriestateProviders,
    eligibilityThreshold: bigint,
    logger?: Logger,
  ): Promise<PriestateAPI> {
    const deployedContract = await deployContract(providers as any, {
      compiledContract: CompiledPriestateContract,
      privateStateId: priestatePrivateStateKey,
      initialPrivateState: createPriestatePrivateState(),
      args: [eligibilityThreshold],
    });
    return new PriestateAPI(deployedContract, providers, logger);
  }

  /** Join an existing PRIESTATE contract (player operation). */
  static async join(
    providers: PriestateProviders,
    contractAddress: ContractAddress,
    logger?: Logger,
  ): Promise<PriestateAPI> {
    const deployedContract = await findDeployedContract(providers as any, {
      contractAddress,
      compiledContract: CompiledPriestateContract,
      privateStateId: priestatePrivateStateKey,
      initialPrivateState: createPriestatePrivateState(),
    });
    return new PriestateAPI(deployedContract, providers, logger);
  }
}

export * from './common-types.js';

/** How long to wait for the indexer to publish the post-transaction ledger state. */
export const ELIGIBILITY_RESULT_TIMEOUT_MS = 60_000;

/**
 * Wait for the transaction to finalize, then read `eligibilityResult` from
 * the FIRST contract-ledger emission that arrives afterwards.
 *
 * The result is whatever the contract's public ledger state says — the
 * circuit outcome — not a value recomputed from the private input. The
 * private property value is never an argument here and never enters any
 * public state.
 */
export function firstResultAfterTx(
  tx: Promise<unknown>,
  state$: Observable<PriestateDerivedState>,
  timeoutMs: number = ELIGIBILITY_RESULT_TIMEOUT_MS,
): Promise<boolean> {
  return firstValueFrom(
    from(tx).pipe(
      concatMap(() =>
        state$.pipe(
          take(1),
          map((s) => s.eligibilityResult),
        ),
      ),
      timeout({
        first: timeoutMs,
        with: () =>
          throwError(
            () =>
              new Error(
                'Timed out waiting for the on-chain eligibilityResult after the checkEligibility transaction.',
              ),
          ),
      }),
    ),
  );
}
