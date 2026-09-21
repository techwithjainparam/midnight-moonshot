// PRIESTATE — India Post pincode lookup provider (server-side only).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Validates an Indian 6-digit pincode against India Post data via the public
// postalpincode.in API and returns the resolved district/state/area. THE
// SERVER decides whether an entered pincode is real — the browser is never
// trusted. Negative/cached lookups are kept in a short-lived in-memory cache
// to avoid hammering the upstream; the response is deterministic per pincode.
//
// Fail-closed: an unreachable upstream or a "No records found" answer is
// reported as `invalid` — a pincode is never silently accepted.

export interface PincodeInfo {
  readonly pincode: string;
  readonly valid: boolean;
  readonly postOffices: readonly string[];
  readonly district: string | null;
  readonly state: string | null;
}

export type PincodeLookupResult =
  | { ok: true; info: PincodeInfo }
  | { ok: false; reason: 'unconfigured' | 'network-error' | 'invalid-response' };

export interface PincodeProvider {
  readonly name: string;
  readonly configured: boolean;
  lookup(pincode: string): Promise<PincodeLookupResult>;
}

export interface PincodeProviderConfig {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_BASE = 'https://api.postalpincode.in';

interface PostalApiEntry {
  readonly Message?: string;
  readonly Status?: string;
  readonly PostOffice?:
    | readonly {
        readonly Name?: string;
        readonly District?: string;
        readonly State?: string;
        readonly Country?: string;
      }[]
    | null;
}

export class PostalIndiaPincodeProvider implements PincodeProvider {
  readonly name = 'india-post';
  readonly configured = true;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, PincodeInfo>();
  private readonly inflight = new Map<string, Promise<PincodeLookupResult>>();

  constructor(config: PincodeProviderConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 8000;
  }

  lookup(pincodeRaw: string): Promise<PincodeLookupResult> {
    const pincode = pincodeRaw.trim();
    const cached = this.cache.get(pincode);
    if (cached) return Promise.resolve({ ok: true, info: cached });
    const inflight = this.inflight.get(pincode);
    if (inflight) return inflight;
    const work = this.doLookup(pincode).finally(() => this.inflight.delete(pincode));
    this.inflight.set(pincode, work);
    return work;
  }

  private async doLookup(pincode: string): Promise<PincodeLookupResult> {
    if (!/^[1-9]\d{5}$/.test(pincode)) {
      const invalid: PincodeInfo = {
        pincode,
        valid: false,
        postOffices: [],
        district: null,
        state: null,
      };
      this.cache.set(pincode, invalid);
      return { ok: true, info: invalid };
    }

    let parsed: unknown;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(`${this.baseUrl}/pincode/${encodeURIComponent(pincode)}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, reason: 'network-error' };
      parsed = (await res.json()) as unknown;
    } catch {
      return { ok: false, reason: 'network-error' };
    }

    const info = this.interpret(pincode, parsed);
    this.cache.set(pincode, info);
    return { ok: true, info };
  }

  private interpret(pincode: string, payload: unknown): PincodeInfo {
    const entries = Array.isArray(payload) ? (payload as readonly PostalApiEntry[]) : [];
    const entry = entries[0];
    if (!entry || entry.Status !== 'Success' || !Array.isArray(entry.PostOffice) || entry.PostOffice.length === 0) {
      return { pincode, valid: false, postOffices: [], district: null, state: null };
    }
    const offices = entry.PostOffice.filter((o) => o.Country === 'India');
    const states = [...new Set(offices.map((o) => o.State ?? '').filter(Boolean))];
    const districts = [...new Set(offices.map((o) => o.District ?? '').filter(Boolean))];
    return {
      pincode,
      valid: offices.length > 0 && states.length > 0,
      postOffices: offices.map((o) => o.Name ?? '').filter(Boolean),
      district: districts[0] ?? null,
      state: states[0] ?? null,
    };
  }
}

/** Build the configured pincode provider (always the postalpincode.in adapter). */
export function createPincodeProviderFromConfig(cfg?: {
  baseUrl?: string;
  timeoutMs?: number;
}): PincodeProvider {
  return new PostalIndiaPincodeProvider(cfg ?? {});
}