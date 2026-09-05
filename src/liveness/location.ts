// PRIESTATE — Live location verification (Level 3 Part 7).
//
// ⚠️ HONEST CAPABILITY: browser geolocation (`navigator.geolocation`) is NOT a
// cryptographic physical-location attestation. It is the browser/OS-reported
// position (Wi-Fi/cell/GPS-derived) and is spoof-able in principle. It is used
// here ONLY as an honest, user-granted, freshly-observed location signal during
// registration — never claimed to prove physical presence. The Product proposal
// is not updated here (per Part 7 scope) — only this plan doc talks about the
// boundary.
//
// The module is SPLIT into:
//   1. a PURE validator (this file) — no DOM, unit-testable in Node. It decides
//      what counts as a "valid, fresh, accurate enough" reading and what failure
//      state to surface. It never modifies shared state.
//   2. a thin browser watcher boundary (location-watcher.ts) that wires the
//      validator to `navigator.geolocation.watchPosition` and always clears the
//      watcher on every exit path (complete / failure / cancel / unmount / expiry).

/** Normalised, server-sendable location evidence (never a raw coords dump to the ledger). */
export interface LocationEvidence {
  readonly status: 'verified';
  /** Latitude in decimal degrees, already range-checked. */
  readonly latitude: number;
  /** Longitude in decimal degrees, already range-checked. */
  readonly longitude: number;
  /** Reported position accuracy in metres (95% CI), range-checked. */
  readonly accuracyMeters: number;
  /** Unix ms timestamp when the browser acquired the position. */
  readonly timestampMs: number;
  /** A stable nonce so a replay cannot be passed off as freshly acquired. */
  readonly nonce: string;
}

/** Input the browser provides to the validator for a single reading. */
export interface RawLocationReading {
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accuracyMeters: number | null;
  readonly timestampMs: number;
}

/** Outcome of validating one reading against config. */
export type LocationValidationResult =
  | { readonly ok: true; readonly evidence: LocationEvidence }
  | { readonly ok: false; readonly reason: LocationDenyReason };

/**
 * Why a location reading was rejected. These are surfaced honestly in the UI
 * (and fold into the session outcome), never faked into a pass.
 */
export type LocationDenyReason =
  | 'location_denied'          // user refused the permission prompt
  | 'location_unavailable'     // no fix / not available in this context
  | 'location_timeout'         // watcher never produced a fix in time
  | 'location_stale'           // fix older than allowed freshness window
  | 'location_invalid'         // coords out of range / non-finite
  | 'location_accuracy_insufficient'; // accuracy worse than threshold

export interface LocationConfig {
  /** Max allowed age of a fix, ms. Default 30s. */
  readonly maxAgeMs: number;
  /** Max acceptable position accuracy, m. Default 100 m. */
  readonly maxAccuracyMeters: number;
  /** Coordinate range guards (roughly valid lat/lon, generous). */
  readonly maxAbsLatitude: number;
  readonly maxAbsLongitude: number;
}

export const DEFAULT_LOCATION_CONFIG: LocationConfig = {
  maxAgeMs: 30_000,
  maxAccuracyMeters: 100,
  maxAbsLatitude: 90,
  maxAbsLongitude: 180,
};

/**
 * Validate a single reading against the config. Pure and deterministic.
 * A reading missing coords, non-finite, out of range, stale, or too-inaccurate
 * fails closed — it is NEVER coerceable into a pass.
 */
export function validateLocationReading(
  reading: RawLocationReading,
  nowMs: number,
  config: Partial<LocationConfig> = {},
): LocationValidationResult {
  const cfg = { ...DEFAULT_LOCATION_CONFIG, ...config };

  const { latitude, longitude, accuracyMeters } = reading;

  if (latitude === null || longitude === null || accuracyMeters === null) {
    return { ok: false, reason: 'location_unavailable' };
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracyMeters)) {
    return { ok: false, reason: 'location_invalid' };
  }
  if (Math.abs(latitude) > cfg.maxAbsLatitude || Math.abs(longitude) > cfg.maxAbsLongitude) {
    return { ok: false, reason: 'location_invalid' };
  }

  const ageMs = nowMs - reading.timestampMs;
  if (ageMs < 0 || ageMs > cfg.maxAgeMs) {
    return { ok: false, reason: 'location_stale' };
  }

  if (accuracyMeters <= 0 || accuracyMeters > cfg.maxAccuracyMeters) {
    return { ok: false, reason: 'location_accuracy_insufficient' };
  }

  return {
    ok: true,
    evidence: {
      status: 'verified',
      latitude,
      longitude,
      accuracyMeters,
      timestampMs: reading.timestampMs,
      nonce: makeNonce(reading),
    },
  };
}

/**
 * Derive the state that a failed validation should surface. Separated so the
 * watcher layer can map error codes AND validation denials to a single suffix.
 * Returns just the human-reason tag (used by the UI + tests).
 */
export function locationDenyReasonFromErrorCode(code: number | null | undefined): LocationDenyReason {
  switch (code) {
    case 1: // PERMISSION_DENIED
      return 'location_denied';
    case 2: // POSITION_UNAVAILABLE
      return 'location_unavailable';
    case 3: // TIMEOUT
    case null:
    case undefined:
    default:
      return 'location_timeout';
  }
}

/**
 * A short, deterministic nonce derived from a reading, so the same coordinates
 * replayed later can be recognised as not-fresh. NOT at all secret — its job is
 * only to make identical fixes distinguishable across time windows.
 */
export function makeNonce(reading: RawLocationReading): string {
  const lat = Math.round((reading.latitude ?? 0) * 1e7) % 1_000_000;
  const lon = Math.round((reading.longitude ?? 0) * 1e7) % 1_000_000;
  return `pvs-${reading.timestampMs >> 10}-${lat}-${lon}`;
}