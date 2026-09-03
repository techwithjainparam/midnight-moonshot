// PRIESTATE — Registration liveness detection (Level 3 Part 4).
//
// ⚠️ DESIGN HONESTY
// Liveness detection answers ONE question: "Is this a real, live person in
// front of the camera rather than a static photo or simple replay?" It does
// NOT by itself identify WHO the person is — identity verification (Aadhaar
// face matching, login face matching) is explicitly out of scope for this
// part and lives elsewhere.
//
// No fake boolean ("isHuman = true") ever decides liveness. Liveness is
// derived EXCLUSIVELY from observable, verifiable artifacts produced by the
// active challenge flow: the user must complete a randomized sequence of
// actions that the vision engine can genuinely observe. Anything the engine
// cannot detect fails closed (`vision_unavailable`).
//
// Privacy: frames are always processed in memory. Camera frames and derived
// biometric signals are NEVER written to the public Midnight ledger, placed
// in URLs or localStorage, logged, or sent to arbitrary third parties.

/** A single active liveness action the user must perform. */
export type ChallengeAction =
  | 'blink-twice'
  | 'turn-left'
  | 'turn-right'
  | 'move-closer'
  | 'look-up'
  | 'look-down'
  | 'raise-hand'
  | 'move-head';

/** A vision capability that an action may require. */
export type VisionCapability = 'motion' | 'biometricActions' | 'faceDetection';

/** Human-readable instruction for a liveness challenge. */
export interface LivenessChallenge {
  readonly id: string;
  readonly action: ChallengeAction;
  readonly instruction: string;
  /**
   * Which vision capability is REQUIRED to observe this action. If the active
   * vision engine does not advertise this capability, the challenge sequence
   * for that engine must NOT include it (fail closed rather than fake it).
   */
  readonly requiredCapability: VisionCapability;
}

/** Capabilities a vision engine advertises. Absent = cannot detect. */
export interface VisionCapabilities {
  /**
   * Frame-to-frame motion. Our in-memory engine can reliably observe that
   * *something* significant changed between two frames (motion), which is the
   * core "live person, not a static photo" signal.
   */
  readonly motion: boolean;
  /**
   * Biometric-grade actions: blink, head pose via landmarks, hand gestures.
   * The bundled in-memory engine does NOT implement any of these — they are
   * reserved for a real provider. When false, challenges requiring them are
   * excluded.
   */
  readonly biometricActions: boolean;
  /** Face detection / facial landmarks. False for the in-memory engine. */
  readonly faceDetection: boolean;
}

/**
 * The lifecycle of a liveness session. Explicit and driven by a pure reducer
 * (see state-machine.ts), matching the spec's target shape.
 */
export type LivenessStateName =
  | 'idle'
  | 'requesting_camera'
  | 'camera_ready'
  | 'challenge_active'
  | 'liveness_passed'
  | 'camera_denied'
  | 'camera_unavailable'
  | 'vision_unavailable'
  | 'challenge_failed'
  | 'timeout'
  | 'cancelled';

/** Result of a single frame observation fed into the active challenge. */
export interface FrameObservation {
  readonly motionDetected: boolean;
  /** 0..1 estimated motion magnitude in the frame since the previous frame. */
  readonly motionMagnitude: number;
}

/** A frame quality assessment (framing guidance before challenges run). */
export interface FrameQuality {
  /** Mean brightness of the downsized grey frame, 0..1. */
  readonly brightness: number;
  /** Contrast (std-dev of grey intensities), 0..1. */
  readonly contrast: number;
  readonly usable: boolean;
  /** Human guidance when not usable (move closer / improve lighting / center). */
  readonly guidance: readonly string[];
}

/** Session configuration that drives the state machine. */
export interface LivenessConfig {
  /** How many challenges a full sequence must contain. */
  readonly challengeCount: number;
  /** Per-challenge attempt budget (consecutive frames). */
  readonly attemptsPerChallenge: number;
  /** Hard deadline (ms) for the whole liveness session. */
  readonly sessionTimeoutMs: number;
}