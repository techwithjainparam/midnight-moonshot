// PRIESTATE Level-3 — Desktop→mobile carry-over session semantics.
//
// Verifies the mobile fallback is safe:
//   * tokens are opaque and single-use,
//   * an unknown or already-consumed token is rejected,
//   * the carry-over URL carries no PII,
//   * the expiry guard flags an expired session.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMobileSession,
  mobileSessionUrl,
  redeemMobileSession,
  isMobileSessionExpired,
  type MobileSession,
} from '../src/verify/mobile-session';

test('a created session redeems once and reports the wallet', () => {
  const session = createMobileSession('0x' + 'a'.repeat(64));
  const first = redeemMobileSession(session.token);
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.walletAddress, '0x' + 'a'.repeat(64));
});

test('a session token is single-use', () => {
  const session = createMobileSession('0x' + 'b'.repeat(64));
  assert.equal(redeemMobileSession(session.token).ok, true);
  const second = redeemMobileSession(session.token);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, 'used');
});

test('unknown or malformed tokens are rejected', () => {
  const r = redeemMobileSession('not-a-real-token');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'invalid');
});

test('carry-over URL carries only token + wallet (no PII)', () => {
  const session = createMobileSession('0x' + 'c'.repeat(64));
  const url = mobileSessionUrl(session, 'http://localhost:3000');
  assert.ok(url.includes('mobileSession='));
  assert.ok(!url.includes('aadhaar'));
  assert.ok(!url.includes('123456789012'));
});

test('expiry guard flags an expired session via helper', () => {
  const expired: MobileSession = {
    token: 'x',
    walletAddress: '0x' + 'd'.repeat(64),
    expiresAt: Date.now() - 1000,
    used: false,
  };
  assert.equal(isMobileSessionExpired(expired), true);
  const live: MobileSession = { ...expired, expiresAt: Date.now() + 60_000 };
  assert.equal(isMobileSessionExpired(live), false);
});
