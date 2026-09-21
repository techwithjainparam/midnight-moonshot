// PRIESTATE — Registration stepper (Part 1) shared client types.
//
// These types mirror the public-safe projections the server returns for the
// `/api/v1/registration/*` flow. The browser never holds raw PII beyond what it
// entered; every decision (verified booleans, hashes, evidence acceptance) is
// server-authoritative and this client only reflects it.

/** Capabilities echoed by GET /api/v1/registration/capabilities. */
export interface RegistrationCapabilities {
  readonly smsConfigured: boolean;
  readonly whatsappConfigured: boolean;
  readonly emailConfigured: boolean;
  readonly aadhaarOcrConfigured: boolean;
  readonly aadhaarMobileConfigured: boolean;
  readonly pincodeConfigured: boolean;
  readonly geocodingConfigured: boolean;
  readonly passwordRecoveryConfigured: boolean;
}

/** Public-safe server projection of one in-flight registration session. */
export interface RegistrationStatus {
  /** Wallet-free registration: null until the citizen associates a wallet. */
  readonly walletAddress: string | null;
  readonly active: boolean;
  readonly personalVerified: boolean;
  readonly aadhaarDocumentStatus: 'unverified' | 'verified';
  readonly emailVerified: boolean;
  readonly smsOtpVerified: boolean;
  readonly whatsappOtpVerified: boolean;
  readonly aadhaarMobileLinked: boolean;
  readonly passwordSet: boolean;
  readonly photoStatus: 'unverified' | 'verified';
  readonly livenessPassed: boolean;
  readonly locationAccepted: boolean;
  readonly maskedMobile: string | null;
  readonly maskedAadhaar: string | null;
  readonly maskedEmail: string | null;
  readonly finalized: boolean;
  readonly expiresAt: number;
}

/** The sequential step ids of the Part 1 registration stepper. */
export type RegistrationStep =
  | 'personal'
  | 'aadhaar-document'
  | 'email'
  | 'sms-otp'
  | 'whatsapp-otp'
  | 'aadhaar-mobile'
  | 'password'
  | 'photo'
  | 'liveness'
  | 'location'
  | 'finalize';

/** Order the stepper MUST follow (server enforces the same order). */
export const REGISTRATION_STEP_ORDER: readonly RegistrationStep[] = [
  'personal',
  'aadhaar-document',
  'email',
  'sms-otp',
  'whatsapp-otp',
  'aadhaar-mobile',
  'password',
  'photo',
  'liveness',
  'location',
  'finalize',
];

export const REGISTRATION_STEP_LABELS: Record<RegistrationStep, string> = {
  personal: 'Personal details & Aadhaar',
  'aadhaar-document': 'Aadhaar document OCR',
  email: 'Email verification',
  'sms-otp': 'SMS OTP',
  'whatsapp-otp': 'WhatsApp OTP',
  'aadhaar-mobile': 'Aadhaar-mobile link',
  password: 'Password',
  photo: 'Passport photo',
  liveness: 'Live liveness',
  location: 'Live location',
  finalize: 'Finish',
};

/** Derive the current required step from a server status (server order). */
export function currentRegistrationStep(status: RegistrationStatus | null): RegistrationStep {
  if (!status || !status.personalVerified) return 'personal';
  if (status.aadhaarDocumentStatus !== 'verified') return 'aadhaar-document';
  if (!status.emailVerified) return 'email';
  if (!status.smsOtpVerified) return 'sms-otp';
  if (!status.whatsappOtpVerified) return 'whatsapp-otp';
  if (!status.aadhaarMobileLinked) return 'aadhaar-mobile';
  if (!status.passwordSet) return 'password';
  if (status.photoStatus !== 'verified') return 'photo';
  if (!status.livenessPassed) return 'liveness';
  if (!status.locationAccepted) return 'location';
  return 'finalize';
}

/** Challenge types the server may issue for the liveness session. */
export type RegistrationLivenessChallengeType =
  | 'blink'
  | 'head-movement'
  | 'hand-up'
  | 'finger-count'
  | 'phrase';

export interface RegistrationLivenessChallenge {
  readonly challengeId: string;
  readonly type: RegistrationLivenessChallengeType;
  readonly ordinal: number;
  readonly params: {
    readonly count?: number;
    readonly phrase?: string;
  };
}

/** Evidence the client submits for ONE server-issued challenge. */
export interface RegistrationLivenessEvidenceInput {
  readonly ordinal: number;
  readonly type: RegistrationLivenessChallengeType;
  readonly observedMs?: number;
  readonly count?: number;
  readonly transcript?: string;
}

export interface RegistrationLivenessProgress {
  readonly total: number;
  readonly completed: number;
  readonly done: boolean;
}

/** Success body of POST /api/v1/registration/liveness/start. */
export interface RegistrationLivenessStart {
  readonly ok: true;
  readonly challenges: readonly RegistrationLivenessChallenge[];
  readonly expiresInMs: number;
}

/** Success body of POST /api/v1/registration/liveness/evidence. */
export interface RegistrationLivenessEvidenceSubmit {
  readonly ok: true;
  readonly progress: RegistrationLivenessProgress;
  readonly livenessPassed: boolean;
}