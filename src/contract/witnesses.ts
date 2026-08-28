/**
 * Witnesses for the PRIESTATE contract.
 *
 * PRIESTATE has no private state: sensitive values live in module-level
 * holders (never exposed to the ledger) and are fed into circuits by witnesses.
 *
 *  - `propertyValue`      private property VALUE, used as a witness for the
 *                         `checkEligibility` circuit. Never disclosed.
 *  - `applicantSecretKey` applicant secret used to derive the owner/applicant
 *                         DApp public-key binding disclosed on registrations.
 *  - `officerSecretKey`   designated officer secret used to authorize
 *                         approve/reject; only a derived public key is ever
 *                         disclosed.
 */

export type PriestatePrivateState = Record<string, never>;

export const createPriestatePrivateState = (): PriestatePrivateState => ({});

let _propertyValue = 0n;
let _applicantSecretKey: Uint8Array = new Uint8Array(32);
let _officerSecretKey: Uint8Array = new Uint8Array(32);

export const setPropertyValue = (value: bigint): void => {
  _propertyValue = value;
};

export const setApplicantSecretKey = (key: Uint8Array): void => {
  _applicantSecretKey = key;
};

export const setOfficerSecretKey = (key: Uint8Array): void => {
  _officerSecretKey = key;
};

export const createWitnesses = () => ({
  propertyValue: ({
    privateState,
  }: {
    privateState: PriestatePrivateState;
  }): [PriestatePrivateState, bigint] => [privateState, _propertyValue],
  applicantSecretKey: ({
    privateState,
  }: {
    privateState: PriestatePrivateState;
  }): [PriestatePrivateState, Uint8Array] => [privateState, _applicantSecretKey],
  officerSecretKey: ({
    privateState,
  }: {
    privateState: PriestatePrivateState;
  }): [PriestatePrivateState, Uint8Array] => [privateState, _officerSecretKey],
});
