// PRIESTATE Level-3 — Demo face-match semantics.
//
// The demo matcher is explicitly NOT a real biometric system. These tests pin
// down its pure, dependency-free core so it is deterministic and safe:
//   * correlation is symmetric, bounded to [0,1], and identical for a signal
//     with itself,
//   * the match/no-match decision respects a configurable threshold,
//   * raising the threshold makes matching stricter (fewer matches),
//   * dissimilar signatures score low and do not match,
//   * results are clearly labelled demo (never claim official identity).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  correlation,
  decideMatchScore,
  demoResultLabel,
  configuredThresholdRequiresHigherScore,
} from '../src/verify/face-match';

test('correlation is 1.0 for an identical signal and symmetric', () => {
  const a = [0, 10, 20, 30, 40, 50];
  assert.equal(correlation(a, a), 1, 'identical signals should correlate to 1');
  assert.equal(correlation(a, [0, 10, 20, 30, 40, 50]), 1);
  assert.equal(correlation([1, 2, 3], [3, 2, 1]), correlation([3, 2, 1], [1, 2, 3]));
});

test('correlation stays within [0,1] and is low for dissimilar signals', () => {
  const bright = Array.from({ length: 64 }, (_, i) => i);
  const dark = Array.from({ length: 64 }, () => 0);
  const score = correlation(bright, dark);
  assert.ok(score >= 0 && score <= 1, 'correlation must be within [0,1]');
  assert.ok(score < 0.5, 'dissimilar signals should score low');
});

test('decideMatchScore honours a configurable threshold', () => {
  const high = decideMatchScore(0.9, 0.72);
  assert.equal(high.ok, true);
  assert.equal(high.label, 'match');
  const low = decideMatchScore(0.3, 0.72);
  assert.equal(low.ok, false);
  assert.equal(low.label, 'no-match');
});

test('raising the threshold is stricter for the same score', () => {
  const score = 0.7;
  assert.equal(decideMatchScore(score, 0.6).ok, true);
  assert.equal(decideMatchScore(score, 0.9).ok, false);
});

test('result label is honest demo copy', () => {
  const ok = decideMatchScore(0.9, 0.72);
  const label = demoResultLabel(ok);
  assert.ok(label.includes('DEMO'));
  // It must state it is a DEMO check and explicitly deny it is an official
  // verification — it must never claim to BE an official result.
  assert.ok(label.toLowerCase().includes('not an official'));
  const noMatch = decideMatchScore(0.2, 0.72);
  assert.ok(demoResultLabel(noMatch).includes('not confirmed'));
});

test('the default threshold is a positive, non-trivial strictness', () => {
  assert.equal(configuredThresholdRequiresHigherScore(), true);
});
