/**
 * Wallet integration for PRIESTATE.
 *
 * Connects to a Midnight wallet via the DApp Connector API (v4.x) and
 * initializes the provider set required by midnight-js (wallet, zk config,
 * proof, indexer public data, private state).
 *
 * Wallet-agnostic — works with any Midnight DApp Connector v4.x wallet
 * (1AM, Lace, or others). Proving is delegated to the connected wallet
 * through the DApp Connector's `getProvingProvider` API.
 */

import { type Logger } from 'pino';
import { ErrorCodes, type APIError, type ConnectedAPI, type InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { createProofProvider } from '@midnight-ntwrk/midnight-js-types';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { Binding, CostModel, type FinalizedTransaction, Proof, SignatureEnabled, Transaction, type TransactionId } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { type NetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { UnboundTransaction } from '@midnight-ntwrk/midnight-js-types';
import semver from 'semver';
import { catchError, concatMap, filter, firstValueFrom, interval, map, take, throwError, timeout } from 'rxjs';
import { inMemoryPrivateStateProvider } from './in-memory-private-state-provider.js';
import { type PriestatePrivateState } from './contract/index.js';
import { type PriestateCircuitKeys, type PriestatePrivateStateId, type PriestateProviders } from './common-types.js';

const COMPATIBLE_CONNECTOR_API_VERSION = '4.x';

/** Presence of an installable/compatible wallet in the browser context. */
export type WalletAvailability = 'none' | 'incompatible' | 'available';

/** True if the given error was raised by the DApp Connector API. */
export const isAPIError = (error: unknown): error is APIError =>
  typeof error === 'object' &&
  error !== null &&
  (error as APIError).type === 'DAppConnectorAPIError';

/** Human-readable reason for a failed connection attempt. */
export const describeConnectionError = (error: unknown): string => {
  if (isAPIError(error)) {
    switch (error.code) {
      case ErrorCodes.Rejected:
        return 'Wallet connection was rejected. Approve the connection request in the wallet and try again.';
      case ErrorCodes.PermissionRejected:
        return 'Wallet permission was rejected. Allow the connection request in the wallet and try again.';
      case ErrorCodes.Disconnected:
        return 'The wallet connection was lost. Reconnect to continue.';
      case ErrorCodes.InvalidRequest:
        return 'The wallet rejected the connection request as invalid. Try again or reinstall the wallet.';
      case ErrorCodes.InternalError:
        return 'The wallet reported an internal error. Try again or restart the browser.';
    }
  }
  return 'An unexpected error occurred while connecting.';
};

export const getFirstCompatibleWallet = (): InitialAPI | undefined => {
  if (!window.midnight) return undefined;
  return Object.values(window.midnight).find(
    (wallet): wallet is InitialAPI =>
      !!wallet &&
      typeof wallet === 'object' &&
      'apiVersion' in wallet &&
      semver.satisfies(wallet.apiVersion, COMPATIBLE_CONNECTOR_API_VERSION),
  );
};

export const getWalletAvailability = (): WalletAvailability => {
  if (!window.midnight) return 'none';
  return getFirstCompatibleWallet() ? 'available' : 'incompatible';
};

export const connectToWallet = (networkId: string): Promise<ConnectedAPI> =>
  firstValueFrom(
    interval(100).pipe(
      map(() => getFirstCompatibleWallet()),
      filter((api): api is InitialAPI => !!api),
      take(1),
      timeout({ first: 3_000, with: () => throwError(() => new Error('Could not find a Midnight wallet.')) }),
      concatMap(async (initialAPI) => initialAPI.connect(networkId)),
      timeout({ first: 5_000, with: () => throwError(() => new Error('Wallet failed to respond.')) }),
      catchError((error: unknown) => throwError(() => describeAsConnectError(error))),
    ),
  );

const describeAsConnectError = (error: unknown): Error => {
  if (isAPIError(error)) {
    return new Error(describeConnectionError(error));
  }
  return error instanceof Error ? error : new Error('Wallet not authorized');
};

export const initializeProviders = async (
  _logger: Logger,
  existingConnection?: ConnectedAPI,
): Promise<PriestateProviders> => {
  const networkId = import.meta.env.VITE_NETWORK_ID as NetworkId;

  const connectedAPI = existingConnection ?? await connectToWallet(networkId);
  const config = await connectedAPI.getConfiguration();
  setNetworkId(config.networkId);
  const shieldedAddresses = await connectedAPI.getShieldedAddresses();
  const zkConfigProvider = new FetchZkConfigProvider<PriestateCircuitKeys>(window.location.origin, fetch.bind(window));

  const provingProvider = await connectedAPI.getProvingProvider(zkConfigProvider.asKeyMaterialProvider());
  const proofProvider = createProofProvider(provingProvider, CostModel.initialCostModel());

  return {
    privateStateProvider: inMemoryPrivateStateProvider<PriestatePrivateStateId, PriestatePrivateState>(),
    zkConfigProvider,
    proofProvider,
    publicDataProvider: indexerPublicDataProvider(config.indexerUri, config.indexerWsUri),
    walletProvider: {
      getCoinPublicKey: () => shieldedAddresses.shieldedCoinPublicKey,
      getEncryptionPublicKey: () => shieldedAddresses.shieldedEncryptionPublicKey,
      balanceTx: async (tx: UnboundTransaction): Promise<FinalizedTransaction> => {
        const received = await connectedAPI.balanceUnsealedTransaction(toHex(tx.serialize()));
        return Transaction.deserialize<SignatureEnabled, Proof, Binding>(
          'signature',
          'proof',
          'binding',
          fromHex(received.tx),
        );
      },
    },
    midnightProvider: {
      submitTx: async (tx: FinalizedTransaction): Promise<TransactionId> => {
        await connectedAPI.submitTransaction(toHex(tx.serialize()));
        return tx.identifiers()[0];
      },
    },
  };
};
