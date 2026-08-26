/**
 * Witnesses for the PRIESTATE contract.
 *
 * PRIESTATE has no private state: the private property value lives in a
 * module-level holder (never exposed to the ledger) and is fed into the
 * `checkEligibility` circuit by the `propertyValue` witness. Only the
 * boolean eligibility result is disclosed on the public ledger.
 */

export type PriestatePrivateState = Record<string, never>;

export const createPriestatePrivateState = (): PriestatePrivateState => ({});

let _propertyValue = 0n;

export const setPropertyValue = (value: bigint): void => {
  _propertyValue = value;
};

export const createWitnesses = () => ({
  propertyValue: ({
    privateState,
  }: {
    privateState: PriestatePrivateState;
  }): [PriestatePrivateState, bigint] => [privateState, _propertyValue],
});
