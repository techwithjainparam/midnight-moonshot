// PRIESTATE — Login face-verification provider boundary (Level 3 Part 6).
//
// ⚠️ SEPARATES TWO CONCEPTS THAT MUST NOT BE CONFLATED:
//   1. LIVENESS  — "is a real, live person in front of the camera?" (Part 4's
//                  in-memory motion engine, src/liveness/state-machine.ts).
//   2. FACE MATCH — "does this live face match a registered identity/reference?"
//                  This module's responsibility.
//
// This module defines the PROVIDER BOUNDARY for real computer-vision face
// verification:
//   * face detection,
//   * liveness challenge/action observation,
//   * face embedding / reference comparison,
//   * capability discovery.
//
// Honesty contract (mirrors src/liveness/vision-provider.ts):
//   * No CV/face library is currently bundled, so the bundled in-memory
//     provider advertises NO face capability and holds NO reference identity.
//     It therefore ALWAYS answers `provider_unavailable` — it NEVER returns a
//     fabricated match, score, or "faceMatched = true".
//   * A real provider (e.g. a trusted device/on-server CV model + a secure
//     private reference store) wires in later by supplying its own
//     implementation of `FaceVerificationProvider`, without changing the
//     machine, the UI, or the session gate.
//
// Privacy:
//   * No face image, embedding, biometric, Aadhaar number, or identity
//     document is ever stored, uploaded, logged, placed in a URL/query/localStorage,
//     or written to the Midnight ledger. The result surface carries only an
//     enumerated verdict string + an optional opaque 0..1 score/error label.

/** Capabilities a real face-verification provider would advertise. */
export type FaceVerificationCapability =
  | 'faceDetection' // localise a face bounding box / landmarks
  | 'faceEmbedding' // produce + compare a biometric embedding to a reference
  | 'livenessActions'; // observe blink / head-pose / gestures for active liveness

/** The exhaustive, NON-overlapping set of face-verification outcomes. */
export type FaceMatchVerdict =
  | 'matched'
  | 'mismatch'
  | 'insufficient_quality'
  | 'no_face'
  | 'multiple_faces'
  | 'provider_unavailable'
  | 'error';

/** A single, provider-produced verification outcome. */
export interface FaceVerificationResult {
  readonly verdict: FaceMatchVerdict;
  /**
   * Opaque match confidence in 0..1, present ONLY on matched/mismatch and only
   * when the provider actually computes one. Never fabricated.
   */
  readonly score?: number;
  /** Optional human-readable, non-PII diagnostic label. */
  readonly label?: string;
}

/**
 * The dead-simple provider contract. A real implementation supplies new
 * capability discovery + verification without touching the rest of the flow.
 */
export interface FaceVerificationProvider {
  /** Capabilities the provider genuinely advertises. */
  readonly capabilities: ReadonlySet<FaceVerificationCapability>;
  /**
   * Whether the account actually holds a legitimate biometric reference the
   * provider can compare against. In this build this is ALWAYS false — the
   * demo match (src/verify/face-match.ts) is client-side and transient and is
   * NOT a stored reference. A production deployment stores a reference in a
   * secure server/private boundary, never on-chain.
   */
  readonly hasReferenceIdentity: boolean;
  /** Provider identity for honest status/failure copy (never a secret). */
  readonly description: string;
  /** Run verification. Fail-closed: absent capability → provider_unavailable. */
  verify(): FaceVerificationResult;
}

/**
 * The bundled in-memory provider. It exists to make the boundary real and to
 * keep the fail-closed path exercised — it cannot detect a face, run an active
 * liveness action, or match any identity. It MUST NOT be mistaken for biometric
 * verification and it NEVER fabricates success.
 */
export const IN_MEMORY_FACE_PROVIDER: FaceVerificationProvider = {
  capabilities: new Set(),
  hasReferenceIdentity: false,
  description: 'in-memory (no face capability)',
  verify(): FaceVerificationResult {
    return {
      verdict: 'provider_unavailable',
      label: 'No computer-vision face-verification provider is available and no registered reference identity exists.',
    };
  },
};

export type FaceCapabilityDiscovery =
  | 'capable_with_reference'
  | 'capable_no_reference'
  | 'not_capable';

/**
 * Map a provider + reference to the login face stage disposition. Pure and
 * deterministic so tests can assert the fail-closed branches precisely.
 */
export function discoverFaceCapability(
  caps: ReadonlySet<FaceVerificationCapability>,
  hasReferenceIdentity: boolean,
): FaceCapabilityDiscovery {
  const faceAndLiveness =
    caps.has('faceDetection') &&
    (caps.has('faceEmbedding') || caps.has('livenessActions'));
  if (!faceAndLiveness) return 'not_capable';
  return hasReferenceIdentity ? 'capable_with_reference' : 'capable_no_reference';
}