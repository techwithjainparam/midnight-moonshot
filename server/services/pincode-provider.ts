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
// TRANSIENT FAILURES: the public upstream occasionally drops the first connect
// or answers slowly (the fetch is aborted on timeout). Because a pincode that
// "could not be reached" must never be silently accepted, but a single hiccup
// otherwise makes an otherwise-fine pincode look broken, this provider retries
// ONLY the transport-level failure cases (fetch threw, timeout, or a non-2xx
// HTTP status) a bounded number of times with small backoff. A pincode the
// upstream definitively rejects ("No records found", empty payload) is NEVER
// retried — it is an authoritative invalid answer. After all retries the
// lookup still FAILS CLOSED with `network-error`; the caller reports a clean
// user-facing error and nothing is accepted.
//
// Fail-closed: a persistently unreachable upstream or a "No records found"
// answer means a pincode is never silently accepted.

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
  /** Max time per single upstream attempt (ms). Default: 8000. */
  readonly timeoutMs?: number;
  /** Additional attempts after the first (network failures only). Default: 2. */
  readonly maxRetries?: number;
  /** Base backoff between retries (ms), doubled per attempt. Default: 350. */
  readonly retryBaseDelayMs?: number;
}

const DEFAULT_BASE = 'https://api.postalpincode.in';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 350;

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
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly cache = new Map<string, PincodeInfo>();
  private readonly inflight = new Map<string, Promise<PincodeLookupResult>>();

  constructor(config: PincodeProviderConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, config.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryBaseDelayMs = Math.max(0, config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
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

  private async fetchOnce(pincode: string): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/pincode/${encodeURIComponent(pincode)}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
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

    // Retry ONLY the transport-level failures (timeout / dropped connection /
    // non-2xx). A successfully parsed answer — including a definitive "No
    // records found" — is final and never retried. Each retry waits backing
    // off (retryBaseDelayMs, then doubled), still bounded so a hard failure
    // surfaces as `network-error` (fail-closed) within a couple of seconds.
    let parsed: unknown = null;
    let attempts = 0;
    let delay = this.retryBaseDelayMs;
    for (; parsed === null && attempts <= this.maxRetries; attempts++) {
      if (attempts > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
      parsed = await this.fetchOnce(pincode);
    }
    if (parsed === null) {
      if (attempts > 1) {
        console.warn(
          `[priestate] pincode lookup ${pincode}: upstream unreachable after ${attempts} attempts within ${this.timeoutMs}ms each — keeping fail-closed.`,
        );
      }
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
  maxRetries?: number;
  retryBaseDelayMs?: number;
}): PincodeProvider {
  return new PostalIndiaPincodeProvider(cfg ?? {});
}