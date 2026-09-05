// PRIESTATE — REAL SMS/WhatsApp transport adapter tests (J.4).
//
// Exercises the REAL outbound HTTPS transports (Twilio Messages API, generic
// HTTP gateway, WhatsApp Business Cloud API) against a stubbed `fetch`, proving
// the exact requests the server sends: correct URL/endpoint, auth headers,
// form/JSON bodies, success status handling, and fail-closed 'rejected' /
// 'network-error' / 'unconfigured' behavior. No OTP is ever logged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwilioSmsProvider, GenericHttpSmsProvider, createSmsProviderFromConfig } from '../server/account/sms-provider';
import { MetaWhatsAppProvider, createWhatsAppProviderFromConfig } from '../server/account/whatsapp-provider';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(handler: (url: string, init: RequestInit | undefined) => { status: number; body?: unknown }): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : new URL(String(input)).toString();
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

const TO = '+919876543210';
const CODE = '314159';

// ── Twilio Messages API ─────────────────────────────────────────

test('TwilioSmsProvider posts the correct URL, auth header, and body; success on 201', async (t) => {
  const fetchStub = stubFetch(() => ({ status: 201, body: { sid: 'SM123' } }));
  t.after(fetchStub.restore);

  const provider = new TwilioSmsProvider('AC123456', 'auth-token-abc', '+15005550006');
  const result = await provider.send(TO, CODE);
  assert.deepEqual(result, { ok: true });

  assert.equal(fetchStub.calls.length, 1);
  const { url, init } = fetchStub.calls[0];
  assert.equal(url, 'https://api.twilio.com/2010-04-01/Accounts/AC123456/Messages.json');
  assert.equal(init?.method, 'POST');
  const headers = init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${Buffer.from('AC123456:auth-token-abc').toString('base64')}`);
  assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');
  const body = (init?.body as URLSearchParams)?.toString() ?? '';
  assert.equal(body, new URLSearchParams({
    To: TO,
    From: '+15005550006',
    Body: 'Your PRIESTATE verification code is 314159. Do not share it with anyone.',
  }).toString());
});

test('Twilio non-2xx (400) is a rejected delivery', async (t) => {
  const fetchStub = stubFetch(() => ({ status: 400, body: { message: 'Invalid phone number' } }));
  t.after(fetchStub.restore);
  const provider = new TwilioSmsProvider('AC1', 'tok', '+15005550006');
  assert.deepEqual(await provider.send(TO, CODE), { ok: false, reason: 'rejected' });
});

test('Twilio network failure is a network-error and never a fake success', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const provider = new TwilioSmsProvider('AC1', 'tok', '+15005550006');
  assert.deepEqual(await provider.send(TO, CODE), { ok: false, reason: 'network-error' });
});

// ── Generic HTTP gateway ────────────────────────────────────────

test('GenericHttpSmsProvider interpolates {to}/{code}, sends Bearer token, accepts 202', async (t) => {
  const fetchStub = stubFetch(() => ({ status: 202, body: { ok: true } }));
  t.after(fetchStub.restore);

  const provider = new GenericHttpSmsProvider('https://gateway.example.com/sms?to={to}&code={code}', 'gateway-token-9');
  const result = await provider.send(TO, CODE);
  assert.deepEqual(result, { ok: true });

  assert.equal(fetchStub.calls.length, 1);
  const { url, init } = fetchStub.calls[0];
  assert.equal(url, `https://gateway.example.com/sms?to=${encodeURIComponent(TO)}&code=${encodeURIComponent(CODE)}`);
  assert.equal(init?.method, 'POST');
  assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer gateway-token-9');
});

test('GenericHttpSmsProvider 500 is rejected', async (t) => {
  const fetchStub = stubFetch(() => ({ status: 500 }));
  t.after(fetchStub.restore);
  const provider = new GenericHttpSmsProvider('https://gateway.example.com/sms?to={to}&code={code}', 'tok');
  assert.deepEqual(await provider.send(TO, CODE), { ok: false, reason: 'rejected' });
});

test('GenericHttpSmsProvider network failure is a network-error', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('socket hang up'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const provider = new GenericHttpSmsProvider('https://gateway.example.com/sms?to={to}&code={code}');
  assert.deepEqual(await provider.send(TO, CODE), { ok: false, reason: 'network-error' });
});

// ── WhatsApp Business Cloud API ─────────────────────────────────

test('MetaWhatsAppProvider posts the Cloud API endpoint with Bearer + JSON payload; success on 200', async (t) => {
  const fetchStub = stubFetch(() => ({ status: 200, body: { messages: [{ id: 'wamid-1' }] } }));
  t.after(fetchStub.restore);

  const provider = new MetaWhatsAppProvider({ apiToken: 'wa-token-77', phoneNumberId: '1234567890' });
  const result = await provider.send(TO, CODE);
  assert.deepEqual(result, { ok: true });

  assert.equal(fetchStub.calls.length, 1);
  const { url, init } = fetchStub.calls[0];
  assert.equal(url, 'https://graph.facebook.com/v21.0/1234567890/messages');
  assert.equal(init?.method, 'POST');
  const headers = init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer wa-token-77');
  assert.equal(headers['Content-Type'], 'application/json');
  const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
  assert.equal(payload.messaging_product, 'whatsapp');
  assert.equal(payload.to, TO);
  assert.equal(payload.type, 'text');
  const text = payload.text as Record<string, string>;
  assert.ok(text.body.includes(CODE));
});

test('MetaWhatsAppProvider honors baseUrl/version overrides', async (t) => {
  const fetchStub = stubFetch(() => ({ status: 200 }));
  t.after(fetchStub.restore);
  const provider = new MetaWhatsAppProvider({
    apiToken: 't',
    phoneNumberId: '999',
    baseUrl: 'https://graph.example.com/',
    apiVersion: 'v17.0',
  });
  assert.deepEqual(await provider.send(TO, CODE), { ok: true });
  assert.equal(fetchStub.calls[0].url, 'https://graph.example.com/v17.0/999/messages');
});

test('MetaWhatsAppProvider 403 is rejected', async (t) => {
  const fetchStub = stubFetch(() => ({ status: 403, body: { error: { message: 'unauthorized' } } }));
  t.after(fetchStub.restore);
  const provider = new MetaWhatsAppProvider({ apiToken: 't', phoneNumberId: '1' });
  assert.deepEqual(await provider.send(TO, CODE), { ok: false, reason: 'rejected' });
});

test('MetaWhatsAppProvider network failure is a network-error', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const provider = new MetaWhatsAppProvider({ apiToken: 't', phoneNumberId: '1' });
  assert.deepEqual(await provider.send(TO, CODE), { ok: false, reason: 'network-error' });
});

// ── Factory fail-closed guards ──────────────────────────────────

test('SMS/WhatsApp factories yield unconfigured providers that never fake delivery', async () => {
  const sms = createSmsProviderFromConfig({});
  assert.equal(sms.configured, false);
  assert.equal(sms.name, 'unconfigured');
  assert.deepEqual(await sms.send(TO, CODE), { ok: false, reason: 'unconfigured' });

  const smsTwilioMissing = createSmsProviderFromConfig({ sms: { provider: 'twilio' } });
  assert.equal(smsTwilioMissing.configured, false);

  const smsGenericMissingTemplate = createSmsProviderFromConfig({ sms: { provider: 'generic-http', genericHttp: { url: 'https://x' } } });
  assert.equal(smsGenericMissingTemplate.configured, false, 'generic-http requires {to} and {code} placeholders');

  const wa = createWhatsAppProviderFromConfig({});
  assert.equal(wa.configured, false);
  assert.deepEqual(await wa.send(TO, CODE), { ok: false, reason: 'unconfigured' });

  const waMissingToken = createWhatsAppProviderFromConfig({ whatsappPhoneNumberId: '1' });
  assert.equal(waMissingToken.configured, false);
});