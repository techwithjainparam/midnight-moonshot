// PRIVESTATE Level-3 — Live location verification: the pure validator and the
// thin browser watcher boundary (Part 7).
//
// Guards that location is MANDATORY, freshly observed, and honest:
//   * a valid fresh/accurate reading → `verified` evidence,
//   * stale / coarse / out-of-range / non-finite / missing readings each FAIL
//     CLOSED to the correct denial,
//   * the watcher maps geolocation permission states honestly (denied /
//     unavailable / timeout) and NEVER fabricates a fix,
//   * stop() clears the underlying watcher and is idempotent.
//
// Uses an injectable fake `GeoApi`; no DOM geolocation is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateLocationReading,
  DEFAULT_LOCATION_CONFIG,
  locationDenyReasonFromErrorCode,
} from '../src/liveness/location';
import { createLocationWatcher } from '../src/liveness/location-watcher';
import type { GeoApi } from '../src/liveness/location-watcher';

const NOW = Date.now();

function freshReading(overrides = {}) {
  return {
    latitude: 12.9716,
    longitude: 77.5946,
    accuracyMeters: 20,
    timestampMs: NOW,
    ...overrides,
  };
}

test('a valid fresh accurate reading is verified', () => {
  const r = validateLocationReading(freshReading(), NOW);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.evidence.status, 'verified');
    assert.equal(r.evidence.latitude, 12.9716);
    assert.ok(r.evidence.nonce && r.evidence.nonce.length > 0);
  }
});

test('missing coords fail closed to location_unavailable', () => {
  assert.deepEqual(
    validateLocationReading(freshReading({ latitude: null }), NOW),
    { ok: false, reason: 'location_unavailable' },
  );
  assert.deepEqual(
    validateLocationReading(freshReading({ accuracyMeters: null }), NOW),
    { ok: false, reason: 'location_unavailable' },
  );
});

test('non-finite and out-of-range coords fail closed to location_invalid', () => {
  assert.deepEqual(
    validateLocationReading(freshReading({ latitude: Number.NaN }), NOW),
    { ok: false, reason: 'location_invalid' },
  );
  assert.deepEqual(
    validateLocationReading(freshReading({ longitude: 200 }), NOW),
    { ok: false, reason: 'location_invalid' },
  );
  assert.deepEqual(
    validateLocationReading(freshReading({ latitude: -100 }), NOW),
    { ok: false, reason: 'location_invalid' },
  );
});

test('an expired fix fails closed to location_stale', () => {
  const stale = freshReading({ timestampMs: NOW - DEFAULT_LOCATION_CONFIG.maxAgeMs - 1 });
  assert.deepEqual(validateLocationReading(stale, NOW), { ok: false, reason: 'location_stale' });
  // A future-dated fix is also rejected (clock-skew guard).
  const future = freshReading({ timestampMs: NOW + 1 });
  assert.deepEqual(validateLocationReading(future, NOW), { ok: false, reason: 'location_stale' });
});

test('accuracy too coarse (or non-positive) fails closed', () => {
  assert.deepEqual(
    validateLocationReading(freshReading({ accuracyMeters: 500 }), NOW),
    { ok: false, reason: 'location_accuracy_insufficient' },
  );
  assert.deepEqual(
    validateLocationReading(freshReading({ accuracyMeters: 0 }), NOW),
    { ok: false, reason: 'location_accuracy_insufficient' },
  );
});

test('location error codes map honestly', () => {
  assert.equal(locationDenyReasonFromErrorCode(1), 'location_denied');
  assert.equal(locationDenyReasonFromErrorCode(2), 'location_unavailable');
  assert.equal(locationDenyReasonFromErrorCode(3), 'location_timeout');
  assert.equal(locationDenyReasonFromErrorCode(null), 'location_timeout');
  assert.equal(locationDenyReasonFromErrorCode(undefined), 'location_timeout');
});

// ── Watcher boundary with an injectable fake GeoApi ─────────────────────

function fakeGeo(): {
  geo: GeoApi;
  calls: { success: ((pos: GeolocationPosition) => void) | null; error: ((code: number) => void) | null; clearCount: number };
} {
  const calls = { success: null as ((pos: GeolocationPosition) => void) | null, error: null as ((code: number) => void) | null, clearCount: 0 };
  const geo: GeoApi = {
    watchPosition(success, error, _opts) {
      calls.success = success;
      calls.error = (code: number) => error?.({ code });
      return 7;
    },
    clearWatch() {
      calls.clearCount += 1;
    },
  };
  return { geo, calls };
}

function pos(over: Partial<{ lat: number; lon: number; acc: number; ts: number }> = {}): GeolocationPosition {
  const o = { lat: 12.9716, lon: 77.5946, acc: 20, ts: Date.now(), ...over };
  return {
    coords: { latitude: o.lat, longitude: o.lon, accuracy: o.acc, altitude: null, heading: null },
    timestamp: o.ts,
  } as unknown as GeolocationPosition;
}

test('watcher becomes active with evidence on a good fix and stops cleanly', () => {
  const { geo, calls } = fakeGeo();
  const watcher = createLocationWatcher({ geolocation: geo, config: { maxAgeMs: DEFAULT_LOCATION_CONFIG.maxAgeMs } });
  assert.equal(watcher.getState().state, 'inactive'); // not started yet
  watcher.start();
  assert.equal(watcher.getState().state, 'requesting');
  assert.ok(calls.success, 'watchPosition must be registered with a success callback');
  calls.success(pos());
  assert.equal(watcher.getState().state, 'active');
  assert.equal(watcher.getState().evidence?.latitude, 12.9716);
  watcher.stop();
  assert.equal(calls.clearCount, 1);
  assert.equal(watcher.getState().state, 'inactive');
  // stop() is idempotent — repeated calls must not double-clear.
  watcher.stop();
  assert.equal(calls.clearCount, 1);
});

test('watcher maps geolocation errors honestly to denied/unavailable/timeout', () => {
  const cases: Array<[number, string]> = [
    [1, 'location_denied'],
    [2, 'location_unavailable'],
    [3, 'location_timeout'],
  ];
  for (const [code, expected] of cases) {
    const { geo, calls } = fakeGeo();
    const watcher = createLocationWatcher({ geolocation: geo });
    watcher.start();
    assert.ok(calls.error, 'watchPosition must register an error callback');
    calls.error(code);
    assert.equal(watcher.getState().state, expected, `code ${code} -> ${expected}`);
    watcher.stop();
  }
});

test('watcher without a geolocation API stays inactive (fail closed)', () => {
  const watcher = createLocationWatcher(); // geolocation: undefined
  watcher.start();
  assert.equal(watcher.getState().state, 'inactive');
  watcher.stop();
});