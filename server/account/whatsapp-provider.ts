// PRIESTATE — Real WhatsApp OTP transport adapter (server-side only).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Delivers OTP codes through the WhatsApp Business Platform Cloud API over
// plain HTTPS:
//
//   POST <base>/<version>/<phone-number-id>/messages
//   Authorization: Bearer <WHATSAPP_GATEWAY_API_TOKEN>
//   { "messaging_product": "whatsapp", "to": "<E.164 number>",
//     "type": "text", "text": { "body": "..." } }
//
// The adapter is `configured:false` (fail-closed `unavailable`) until a real
// WhatsApp Business API token and phone-number id are configured. It never
// fakes delivery and never logs the OTP, the mobile number, or the token.

export type WhatsAppSendResult =
  | { ok: true }
  | { ok: false; reason: 'unconfigured' | 'rejected' | 'network-error' };

export interface WhatsAppProvider {
  readonly name: string;
  readonly configured: boolean;
  send(to: string, code: string): Promise<WhatsAppSendResult>;
}

export interface WhatsAppProviderConfig {
  readonly apiToken: string;
  readonly phoneNumberId: string;
  /** Override the Cloud API base (defaults to graph.facebook.com). */
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_BASE = 'https://graph.facebook.com';
const DEFAULT_VERSION = 'v21.0';

/** Build the configured WhatsApp provider, or an unconfigured fail-closed one. */
export function createWhatsAppProviderFromConfig(config?: {
  whatsappConfigured?: boolean;
  whatsapp?: WhatsAppProviderConfig;
  whatsappApiToken?: string;
  whatsappPhoneNumberId?: string;
  whatsappBaseUrl?: string;
}): WhatsAppProvider {
  const apiToken = config?.whatsapp?.apiToken ?? config?.whatsappApiToken ?? '';
  const phoneNumberId = config?.whatsapp?.phoneNumberId ?? config?.whatsappPhoneNumberId ?? '';
  const baseUrl = config?.whatsapp?.baseUrl ?? config?.whatsappBaseUrl ?? DEFAULT_BASE;
  if (apiToken && phoneNumberId) {
    return new MetaWhatsAppProvider({
      apiToken,
      phoneNumberId,
      baseUrl,
      apiVersion: config?.whatsapp?.apiVersion ?? DEFAULT_VERSION,
      timeoutMs: config?.whatsapp?.timeoutMs,
    });
  }
  return { name: 'unconfigured', configured: false, send: () => Promise.resolve({ ok: false, reason: 'unconfigured' }) };
}

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'meta-cloud-api';
  readonly configured = true;
  private readonly apiToken: string;
  private readonly phoneNumberId: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(config: { apiToken: string; phoneNumberId: string; baseUrl?: string; apiVersion?: string; timeoutMs?: number }) {
    this.apiToken = config.apiToken;
    this.phoneNumberId = config.phoneNumberId;
    const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    const version = config.apiVersion ?? DEFAULT_VERSION;
    this.endpoint = `${base}/${version}/${encodeURIComponent(this.phoneNumberId)}/messages`;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async send(to: string, code: string): Promise<WhatsAppSendResult> {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        body: `Your PRIESTATE verification code is ${code}. Do not share it with anyone. It expires in a few minutes.`,
      },
    };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok ? { ok: true } : { ok: false, reason: 'rejected' };
    } catch {
      return { ok: false, reason: 'network-error' };
    }
  }
}