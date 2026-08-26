/**
 * Browser-side provider initialization and contract connection management
 * for PRIESTATE. Connects to the wallet and bridges wallet operations
 * to the PriestateAPI.
 */

import { type ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { BehaviorSubject, type Observable } from 'rxjs';
import { type Logger } from 'pino';
import { type ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { PriestateAPI, type PriestateProviders } from './priestate-api.js';
import { initializeProviders } from './dapp-wallet.js';
import { activeNetworkId, getFixedContractAddress } from './contract-address.js';

export type PriestateDeployment =
  | { readonly status: 'in-progress' }
  | { readonly status: 'deployed'; readonly api: PriestateAPI }
  | { readonly status: 'failed'; readonly error: Error };

/**
 * Manages PRIESTATE contract connections in a browser setting.
 * Reuses the wallet connection established by the UI rather than creating
 * a second connection (which would trigger a duplicate approval popup).
 */
export class BrowserPriestateManager {
  readonly #deploymentsSubject = new BehaviorSubject<Array<BehaviorSubject<PriestateDeployment>>>([]);
  #initializedProviders: Promise<PriestateProviders> | undefined;
  #connectedAPI: ConnectedAPI | undefined;

  constructor(private readonly logger: Logger) {}

  /** Store the already-connected wallet API so providers reuse it. */
  setConnectedAPI(api: ConnectedAPI): void {
    this.#connectedAPI = api;
    // If providers were already initialized with a different connection,
    // reset them so the new connection is used.
    this.#initializedProviders = undefined;
  }

  readonly deployments$: Observable<Array<Observable<PriestateDeployment>>> = this.#deploymentsSubject;

  resolve(contractAddress?: ContractAddress, eligibilityThreshold?: bigint): Observable<PriestateDeployment> {
    // Fixed-address wiring: verification must join the already-deployed
    // contract — an explicit address, VITE_DEFAULT_CONTRACT, or the
    // network-matched deployment recorded by `npm run deploy`. Only when no
    // fixed address exists do we fall back to deploying a fresh contract
    // (which then requires the eligibility threshold).
    const effective =
      contractAddress ?? getFixedContractAddress(activeNetworkId())?.address;
    const deployments = this.#deploymentsSubject.value;
    const existing = deployments.find(
      (d) => d.value.status === 'deployed' && d.value.api.deployedContractAddress === effective,
    );
    if (existing) return existing;

    const deployment = new BehaviorSubject<PriestateDeployment>({ status: 'in-progress' });
    if (effective) {
      void this.run(deployment, (providers) => PriestateAPI.join(providers, effective, this.logger));
    } else {
      if (eligibilityThreshold === undefined) {
        throw new Error('Eligibility threshold is required when deploying a new PRIESTATE contract.');
      }
      void this.run(deployment, (providers) => PriestateAPI.deploy(providers, eligibilityThreshold, this.logger));
    }
    this.#deploymentsSubject.next([...deployments, deployment]);
    return deployment;
  }

  private getProviders(): Promise<PriestateProviders> {
    return this.#initializedProviders ?? (this.#initializedProviders = initializeProviders(this.logger, this.#connectedAPI));
  }

  /** Drop the cached providers and clear all tracked deployments. */
  disconnect(): void {
    this.#initializedProviders = undefined;
    this.#connectedAPI = undefined;
    this.#deploymentsSubject.next([]);
  }

  private async run(
    deployment: BehaviorSubject<PriestateDeployment>,
    factory: (providers: PriestateProviders) => Promise<PriestateAPI>,
  ): Promise<void> {
    try {
      const providers = await this.getProviders();
      const api = await factory(providers);
      deployment.next({ status: 'deployed', api });
    } catch (error: unknown) {
      let err: Error;
      if (error instanceof Error) {
        err = error;
      } else if (typeof error === 'string') {
        err = new Error(error);
      } else {
        err = new Error('Unknown error during contract operation');
      }
      deployment.next({ status: 'failed', error: err });
    }
  }
}
