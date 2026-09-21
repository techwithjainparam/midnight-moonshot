// PRIESTATE — Browser geolocation watcher boundary (Level 3 Part 7).
//
// Thin, DOM-bound wrapper over `navigator.geolocation.watchPosition()`. It:
//   * requests location permission via the standard watchPosition prompt,
//   * accumulates fixes into a validated `LocationEvidence` when good,
//   * maps failures to honest states (denied / unavailable / timeout),
//   * STOPPED the watcher on every exit path — the caller must invoke `stop()`.
//
// Everything except the DOM `watchPosition` call is delegated to the pure
// `validateLocationReading` so Node tests never need the geolocation API.

import {
  DEFAULT_LOCATION_CONFIG,
  LocationConfig,
  LocationDenyReason,
  LocationEvidence,
  locationDenyReasonFromErrorCode,
  validateLocationReading,
} from './location';

/**
 * The subset of `navigator.geolocation` we depend on, injectable for tests.
 * Keeps the whole surface under our control (avoids fragile global mocks).
 */
export interface GeoApi {
  watchPosition(
    success: (pos: GeolocationPosition) => void,
    error?: ((err: GeolocationPositionError | { code: number }) => void) | null,
    options?: PositionOptions,
  ): number;
  clearWatch(id: number): void;
}

export type LocationSessionState =
  | 'requesting'            // watcher started, awaiting first usable fix
  | 'active'                // we have a validated, fresh, accurate-enough fix
  | 'location_denied'
  | 'location_unavailable'
  | 'location_timeout'
  | 'location_stale'
  | 'location_invalid_cache'      // a fix arrived but was rejected
  | 'location_accuracy_insufficient'
  | 'inactive';                   // stopped / never started

export interface LocationSession {
  readonly state: LocationSessionState;
  readonly evidence: LocationEvidence | null;
  /** Human guidance shown while the user waits or after a denial. */
  readonly message: string | null;
}

const EMPTY: LocationSession = {
  state: 'inactive',
  evidence: null,
  message: null,
};

export interface LocationWatcherOptions {
  readonly config?: Partial<LocationConfig>;
  readonly geolocation?: GeoApi;
  /** Continuous watch (default) vs a single `getCurrentPosition` snapshot. */
  readonly continuous?: boolean;
}

/** Internal mutable state, invisible outside the factory closure. */
interface InternalState {
  session: LocationSession;
  watchId: number | null;
  startedAt: number;
}

/**
 * Create a live location verifier bound to the given geolocation API (defaults
 * to `navigator.geolocation` in a browser; injectable for tests). Returns a
 * handle with `getState()`, `start()` and `stop()`; `stop()` is idempotent and
 * clears the underlying watcher, so callers MUST call it on completion /
 * failure / cancel / unmount / expiry.
 *
 * Without a usable geolocation API (no browser, insecure context, or explicit
 * injection of `undefined`) it stays `inactive` — the location gate FAILS
 * CLOSED and is never faked.
 */
export function createLocationWatcher(
  options: LocationWatcherOptions = {},
): {
  getState: () => LocationSession;
  start: () => void;
  stop: () => void;
} {
  const cfg = { ...DEFAULT_LOCATION_CONFIG, ...options.config };
  const geo: GeoApi | undefined =
    options.geolocation ??
    (typeof navigator !== 'undefined' && navigator.geolocation
      ? (navigator.geolocation as unknown as GeoApi)
      : undefined);
  const state: InternalState = {
    session: EMPTY,
    watchId: null,
    startedAt: 0,
  };

  const update = (next: LocationSession) => {
    state.session = next;
  };

  const onSuccess = (pos: GeolocationPosition) => {
    const result = validateLocationReading(
      {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracyMeters: pos.coords.accuracy,
        timestampMs: pos.timestamp,
      },
      Date.now(),
      cfg,
    );
    if (result.ok) {
      update({ state: 'active', evidence: result.evidence, message: null });
    } else {
      update({
        state: mapDenyToSession(result.reason),
        evidence: null,
        message: denyMessage(result.reason),
      });
    }
  };

  const onError = (err: { code?: number } | GeolocationPositionError) => {
    const reason = locationDenyReasonFromErrorCode(err.code);
    update({ state: mapDenyToSession(reason), evidence: null, message: denyMessage(reason) });
  };

  return {
    getState: () => state.session,
    start: () => {
      if (!geo) return; // no geolocation API → stays inactive (fail closed)
      if (state.watchId !== null) return; // already running
      state.startedAt = Date.now();
      update({ state: 'requesting', evidence: null, message: null });
      try {
        state.watchId = geo.watchPosition(
          onSuccess,
          (e) => onError(e as GeolocationPositionError),
          {
            enableHighAccuracy: true,
            maximumAge: cfg.maxAgeMs,
            timeout: cfg.maxAgeMs,
          },
        );
      } catch {
        update({ state: 'location_unavailable', evidence: null, message: denyMessage('location_unavailable') });
      }
    },
    stop: () => {
      if (geo && state.watchId !== null) {
        geo.clearWatch(state.watchId);
      }
      state.watchId = null;
      update(EMPTY);
    },
  };
}

function mapDenyToSession(reason: LocationDenyReason): LocationSessionState {
  return reason === 'location_invalid' ? 'location_invalid_cache' : reason;
}

function denyMessage(reason: LocationDenyReason): string {
  switch (reason) {
    case 'location_denied':
      return 'Location permission was denied. Location is required for registration identity verification.';
    case 'location_unavailable':
      return 'No location signal is available. Move near a window and try again.';
    case 'location_timeout':
      return 'Location could not be acquired in time. Try again.';
    case 'location_stale':
      return 'The location fix is too old to be trusted. Retry.';
    case 'location_invalid':
      return 'The reported location is invalid. Retry.';
    case 'location_accuracy_insufficient':
      return 'The location accuracy is too coarse. Move outdoors and retry.';
    default:
      return 'Location unavailable.';
  }
}