// PRIESTATE — Reverse-geocoding provider (server-side only).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Resolves a picked map coordinate (from the personal-details map step) to a
// human-readable Indian address through the OpenStreetMap Nominatim service.
// The request is proxied through this server (never called directly from the
// browser) so the client cannot hit the upstream, and so the result is
// validated + normalized here. We honour Nominatim's fair-use requirements
// (identifying User-Agent + at most one request per second in flight).
//
// Also used to auto-detect/validate the pincode for the selected location when
// the pincode resolver is unreachable. Fail-closed: an upstream error is
// REPORTED, never silently accepted.

export interface ReverseGeocodeResult {
  readonly ok: true;
  readonly displayName: string | null;
  readonly district: string | null;
  /**
   * The settlement itself, when the upstream address parts identify one.
   *
   * Nominatim reports `city` for Indian localities but its `district`/`county`
   * for the enclosing ward, so `district` alone yields "Bangalore North"
   * instead of "Bengaluru". Added alongside `district` (which is left exactly
   * as before for existing callers) so callers that need a real city name can
   * prefer it.
   */
  readonly city: string | null;
  readonly state: string | null;
  readonly postcode: string | null;
  readonly country: string | null;
}

export type ReverseGeocodeOutcome =
  | ReverseGeocodeResult
  | { ok: false; reason: 'unconfigured' | 'network-error' | 'invalid-response' };

export interface GeocodingProvider {
  readonly name: string;
  readonly configured: boolean;
  /**
   * `zoom` selects the granularity Nominatim returns. It defaults to 14, the
   * settlement level, which is what existing callers were written against.
   * A higher zoom returns building/street level parts plus the postcode, which
   * a full postal address form needs.
   */
  reverse(lat: number, lng: number, zoom?: number): Promise<ReverseGeocodeOutcome>;
}

export interface GeocodingProviderConfig {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxInFlightPerSecond?: number;
}

const DEFAULT_BASE = 'https://nominatim.openstreetmap.org';
const IDENTIFYING_UA = 'priestate-registration/1.0 (PRIESTATE property eligibility verification)';

export class NominatimReverseGeocoder implements GeocodingProvider {
  readonly name = 'nominatim-osm';
  readonly configured = true;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private lastRequestAt = 0;

  constructor(config: GeocodingProviderConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 8000;
  }

  async reverse(lat: number, lng: number, zoom = 14): Promise<ReverseGeocodeOutcome> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { ok: false, reason: 'invalid-response' };
    }
    // Nominatim only accepts zoom 0-18; anything else is treated as the default.
    const safeZoom = Number.isFinite(zoom) ? Math.min(18, Math.max(0, Math.round(zoom))) : 14;

    // Throttle to >= 1s between upstream requests (Nominatim fair use).
    const wait = Math.max(0, 1000 - (Date.now() - this.lastRequestAt));
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    let parsed: unknown;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const url = `${this.baseUrl}/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(
        lng,
      )}&zoom=${safeZoom}&addressdetails=1&accept-language=en`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': IDENTIFYING_UA },
        signal: controller.signal,
      });
      clearTimeout(timer);
      this.lastRequestAt = Date.now();
      if (!res.ok) return { ok: false, reason: 'network-error' };
      parsed = (await res.json()) as unknown;
    } catch {
      this.lastRequestAt = Date.now();
      return { ok: false, reason: 'network-error' };
    }

    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, reason: 'invalid-response' };
    }
    const p = parsed as Record<string, unknown>;
    if (p.error) return { ok: false, reason: 'invalid-response' };
    const address = (p.address ?? {}) as Record<string, unknown>;
    const str = (key: string): string | null => (typeof address[key] === 'string' ? (address[key] as string) : null);
    // The settlement, most specific first. `district`/`county` are deliberately
    // NOT candidates here: for India they name the enclosing ward.
    const city = str('city') ?? str('town') ?? str('village') ?? str('municipality') ?? str('hamlet');
    return {
      ok: true,
      displayName: typeof p.display_name === 'string' ? p.display_name : null,
      district: typeof address.district === 'string' ? address.district : typeof address.county === 'string' ? (address.county as string) : null,
      city,
      state: typeof address.state === 'string' ? address.state : null,
      postcode: typeof address.postcode === 'string' ? address.postcode : null,
      country: typeof address.country === 'string' ? address.country : null,
    };
  }
}

/** Build the configured geocoding provider (always the Nominatim adapter). */
export function createGeocodingProviderFromConfig(cfg?: {
  baseUrl?: string;
  timeoutMs?: number;
}): GeocodingProvider {
  return new NominatimReverseGeocoder(cfg ?? {});
}