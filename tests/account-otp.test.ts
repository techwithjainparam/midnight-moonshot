// PRIESTATE Level-3 — OTP semantics for SMS / WhatsApp factors.
//
// Verifies the OtpService guarantees that back the account multi-factor flow:
//   * codes are stored only as HMAC-SHA256 hashes, never plaintext,
//   * a code is single-use and consumed on success,
//   * wrong attempts are capped and the cap invalidates the code,
//   * codes expire after a TTL,
//   * re-issuing for the same key is cooldown-limited,
//   * issuance per window is rate-limited,
//   * the delivered code is never contained in the stored form.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OtpService, type OtpIssueOk } from '../server/lib/otp-service';

function makeOtp(over: Partial<ConstructorParameters<typeof OtpService>[0]> = {}): OtpService {
  return new OtpService({
    hashSecret: 'otp-semantics-test-secret',
    ttlMs: 5 * 60 * 1000,
    maxAttempts: 3,
    resendCooldownMs: 1000,
    maxSendsPerWindow: 2,
    sendWindowMs: 60 * 1000,
    ...over,
  });
}

const KEY = 'sms:+919876543210';

test('stored OTP is hashed: the raw code never appears in the service state', () => {
  const otp = makeOtp();
  const issued = otp.issue(KEY) as OtpIssueOk;
  const state = (otp as unknown as { active: Map<string, { codeHash: string }> }).active;
  const stored = state.get(KEY);
  assert.ok(stored);
  assert.ok(!stored.codeHash.includes(issued.code));
  assert.notEqual(stored.codeHash, issued.code);
});

test('a code verifies once and is then single-use', () => {
  const otp = makeOtp();
  const issued = otp.issue(KEY) as OtpIssueOk;
  assert.equal(otp.verify(KEY, issued.code).ok, true);
  const again = otp.verify(KEY, issued.code);
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.reason, 'expired');
});

test('wrong attempts are capped and the cap invalidates the code', () => {
  const otp = makeOtp();
  const issued = otp.issue(KEY) as OtpIssueOk;
  assert.equal(otp.verify(KEY, '000001').ok, false);
  assert.equal(otp.verify(KEY, '000002').ok, false);
  const third = otp.verify(KEY, '000003');
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.reason, 'too-many-attempts');
  // Even the correct code is now rejected after the cap.
  assert.equal(otp.verify(KEY, issued.code).ok, false);
});

test('an expired code is rejected', () => {
  let now = 1_000_000;
  const otp = makeOtp({ now: () => now });
  const issued = otp.issue(KEY) as OtpIssueOk;
  now = issued.expiresAt + 1;
  const r = otp.verify(KEY, issued.code);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'expired');
});

test('cooldown blocks immediate resend for the same key', () => {
  const otp = makeOtp();
  assert.equal(otp.issue(KEY).ok, true);
  const second = otp.issue(KEY);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, 'cooldown');
});

test('issuance is rate-limited within a rolling window', () => {
  let now = 0;
  const otp = makeOtp({ now: () => now });
  assert.equal(otp.issue(KEY).ok, true); // 1st send
  now += 2000; // skip past cooldown
  assert.equal(otp.issue(KEY).ok, true); // 2nd send (still within window cap of 2)
  now += 2000; // skip past cooldown
  const third = otp.issue(KEY);
  assert.equal(third.ok, false); // hit the 2-per-window cap
  if (!third.ok) assert.equal(third.reason, 'rate-limited');
});

test('delivered code is nonzero-length and strictly numeric', () => {
  const otp = makeOtp();
  const issued = otp.issue(KEY) as OtpIssueOk;
  assert.equal(issued.code.length, 6);
  assert.ok(/^\d{6}$/.test(issued.code));
});

test('sweep removes expired active codes', () => {
  let now = 1_000_000;
  const otp = makeOtp({ now: () => now });
  const issued = otp.issue(KEY) as OtpIssueOk;
  now = issued.expiresAt + 1;
  otp.sweep();
  const state = (otp as unknown as { active: Map<string, unknown> }).active;
  assert.equal(state.has(KEY), false);
});

test('service refuses to start without a non-trivial hash secret', () => {
  assert.throws(() => new OtpService({ hashSecret: 'short' }));
});
