// PRIESTATE — Real SMS OTP transport adapters (server-side only).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Implements REAL delivery through an SMS gateway using plain HTTPS:
//   * `twilio`     → Twilio Messages API (Basic auth, from a verified number)
//   * `generic-http` → any gateway exposing a URL template (POST by default)
//
// Every adapter:
//   * is `configured:false` (and thus fail-closed `unavailable`) until a real
//     gateway credential is present in server config,
//   * never fakes delivery — a failed/absent gateway yields a delivery error,
//   * never logs the OTP code, the mobile number, or gateway secrets.
//
// The AccountService generates the code and only persists its HMAC hash after
// `send()` reports success, so an unreachable gateway can never mint an OTP.

export type SmsSendResult =
  | { ok: true }
  | { ok: false; reason: 'unconfigured' | 'rejected' | 'network-error' };

export interface SmsProvider {
  readonly name: string;
  readonly configured: boolean;
  /**
   * Deliver `code` to a normalized E.164 mobile number. Returns ok ONLY when
   * the gateway accepted the message. The raw code never reaches logs.
   */
  send(to: string, code: string): Promise<SmsSendResult>;
}

export interface SmsProviderConfig {
  /** 'twilio' | 'generic-http' | '' */
  readonly provider: string;
  readonly twilio?: {
    readonly accountSid: string;
    readonly authToken: string;
    readonly fromNumber: string;
  };
  readonly genericHttp?: {
    /** URL template containing {to} and {code} placeholders. */
    readonly url: string;
    readonly token?: string;
    readonly timeoutMs?: number;
  };
  readonly timeoutMs?: number;
}

/** Build the configured SMS provider, or an unconfigured fail-closed adapter. */
export function createSmsProviderFromConfig(config?: {
  smsConfigured?: boolean;
  sms?: SmsProviderConfig;
}): SmsProvider {
  const providerName = config?.sms?.provider ?? '';

  if (providerName === 'twilio' && config?.sms?.twilio) {
    const t = config.sms.twilio;
    if (t.accountSid && t.authToken && t.fromNumber) {
      return new TwilioSmsProvider(t.accountSid, t.authToken, t.fromNumber, config.sms.timeoutMs);
    }
  }

  if (providerName === 'generic-http' && config?.sms?.genericHttp) {
    const g = config.sms.genericHttp;
    if (g.url && g.url.includes('{to}') && g.url.includes('{code}')) {
      return new GenericHttpSmsProvider(g.url, g.token, g.timeoutMs ?? config.sms.timeoutMs);
    }
  }

  return { name: 'unconfigured', configured: false, send: () => Promise.resolve({ ok: false, reason: 'unconfigured' }) };
}

/** Twilio Messages API sender (REST v2010-04-01). */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  readonly configured = true;
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber: string;
  private readonly timeoutMs: number;

  constructor(accountSid: string, authToken: string, fromNumber: string, timeoutMs = 10_000) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.fromNumber = fromNumber;
    this.timeoutMs = timeoutMs;
  }

  async send(to: string, code: string): Promise<SmsSendResult> {
    const body = new URLSearchParams({
      To: to,
      From: this.fromNumber,
      Body: `Your PRIESTATE verification code is ${code}. Do not share it with anyone.`,
    });
    const auth = `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: auth,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: body.toString(),
          signal: controller.signal,
        },
      );
      clearTimeout(timer);
      // Twilio returns 201 for a queued message.
      return res.status === 201 || res.status === 200 ? { ok: true } : { ok: false, reason: 'rejected' };
    } catch {
      return { ok: false, reason: 'network-error' };
    }
  }
}

/** Generic HTTP gateway sender: POSTs {to}/{code} into a URL template. */
export class GenericHttpSmsProvider implements SmsProvider {
  readonly name = 'generic-http';
  readonly configured = true;
  private readonly template: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(template: string, token?: string, timeoutMs = 10_000) {
    this.template = template;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async send(to: string, code: string): Promise<SmsSendResult> {
    const url = this.template.replace('{to}', encodeURIComponent(to)).replace('{code}', encodeURIComponent(code));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const res = await fetch(url, { method: 'POST', headers, signal: controller.signal });
      clearTimeout(timer);
      return res.ok || res.status === 202 ? { ok: true } : { ok: false, reason: 'rejected' };
    } catch {
      return { ok: false, reason: 'network-error' };
    }
  }
}