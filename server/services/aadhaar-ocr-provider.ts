// PRIESTATE — Real Aadhaar document OCR provider (server-side only).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Sends the uploaded Aadhaar document image to a REAL OCR vendor over HTTPS
// (Surepass-style: `POST {baseUrl}/api/v1/ocr/aadhaar` with a `file` part and a
// bearer token) and returns the EXTRACTED fields — the document filename is
// NEVER used for data extraction (an Aadhaar number must come out of the OCR
// engine, not out of a client-supplied file name).
//
// Processing is temporary and contained:
//   * the bytes reach the vendor only inside an HTTP call,
//   * the caller stores a temp file and MUST delete it after processing,
//   * nothing in this adapter writes the image to disk or to logs,
//   * a failure to reach the vendor or an ambiguous response FAILS CLOSED.
//
// When no OCR credential is configured the adapter reports `configured:false`
// and every call refuses — the feature is never faked.

export interface AadhaarOcrExtraction {
  readonly fullName: string;
  readonly dateOfBirth: string | null;
  readonly gender: string | null;
  readonly addressOnAadhaar: string | null;
  /** Masked fragment only, if the vendor returns one; never relied upon. */
  readonly maskedAadhaar: string | null;
}

export type AadhaarOcrResult =
  | { ok: true; extraction: AadhaarOcrExtraction }
  | { ok: false; reason: 'unconfigured' | 'provider-error' | 'invalid-response' };

export interface AadhaarOcrProvider {
  readonly name: string;
  readonly configured: boolean;
  /**
   * Perform OCR on the given document bytes. `fileName` is carried only for
   * upstream MIME metadata; data extraction NEVER reads the filename.
   */
  ocr(fileName: string, buffer: Buffer, mimeType: string): Promise<AadhaarOcrResult>;
}

export interface AadhaarOcrProviderConfig {
  readonly providerName: string;
  readonly apiToken: string;
  readonly baseUrl: string;
  readonly ocrPath: string;
  readonly timeoutMs: number;
}

const DEFAULT_OCR_PATH = '/api/v1/ocr/aadhaar';

export class SurepassAadhaarOcrProvider implements AadhaarOcrProvider {
  readonly name: string;
  readonly configured: boolean;
  private readonly apiToken: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(cfg: AadhaarOcrProviderConfig) {
    this.name = cfg.providerName || 'surepass-aadhaar-ocr';
    this.apiToken = cfg.apiToken;
    // Real credentials required; without them the adapter FAILS CLOSED and
    // reports `configured:false` (the feature is never faked).
    this.configured = Boolean(cfg.apiToken && cfg.baseUrl);
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const path = cfg.ocrPath ? `/${cfg.ocrPath.replace(/^\/+/, '')}` : DEFAULT_OCR_PATH;
    this.endpoint = `${base}${path}`;
    this.timeoutMs = cfg.timeoutMs ?? 20_000;
  }

  async ocr(fileName: string, buffer: Buffer, mimeType: string): Promise<AadhaarOcrResult> {
    if (!this.configured) return { ok: false, reason: 'unconfigured' };
    let parsed: unknown;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(buffer)], { type: mimeType || 'application/octet-stream' }),
        sanitizeFileName(fileName),
      );
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiToken}` },
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, reason: 'provider-error' };
      parsed = (await res.json()) as unknown;
    } catch {
      return { ok: false, reason: 'provider-error' };
    }

    const extraction = interpretAadhaarOcrResponse(parsed);
    if (!extraction) return { ok: false, reason: 'invalid-response' };
    return { ok: true, extraction };
  }
}

/** Strip directory traversal / path separators from the upload file name. */
function sanitizeFileName(raw: string): string {
  return raw.split('/').pop()?.split('\\').pop()?.slice(0, 120) ?? 'aadhaar-document.jpg';
}

/**
 * Read the vendor's extraction from common response shapes. Returns null
 * unless the OCR engine genuinely produced a usable full name — anything
 * ambiguous fails closed. Never reads the filename.
 */
export function interpretAadhaarOcrResponse(payload: unknown): AadhaarOcrExtraction | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p.success === false) return null;

  const root = p.data !== null && typeof p.data === 'object' ? (p.data as Record<string, unknown>) : {};
  const fullName = pickString(root, ['name', 'full_name', 'fullName'])?.[0] ?? '';
  if (!fullName || !/^[A-Za-z][A-Za-z .'-]{1,79}$/u.test(fullName.trim())) return null;

  const dob = pickString(root, ['dob', 'date_of_birth', 'DOB'])?.[0] ?? null;
  const gender = pickString(root, ['gender', 'sex'])?.[0] ?? null;
  const address = joinAddress(root);
  const maskedAadhaar = pickString(root, ['aadhaar_number', 'aadhaar_no', 'masked_aadhaar'])?.[0] ?? null;

  return {
    fullName: fullName.trim(),
    dateOfBirth: isValidDateOnly(dob) ? dob : null,
    gender,
    addressOnAadhaar: address,
    maskedAadhaar,
  };
}

function pickString(obj: Record<string, unknown>, paths: readonly string[]): string[] {
  for (const path of paths) {
    const v = pick(obj, path);
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    if (typeof v === 'object' && v !== null) {
      const inner = pick(v as Record<string, unknown>, 'value');
      if (typeof inner === 'string' && inner.trim()) return [inner.trim()];
    }
  }
  return [];
}

function pick(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur !== null && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function joinAddress(root: Record<string, unknown>): string | null {
  const direct = pick(root, 'address');
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (direct !== null && typeof direct === 'object') {
    const address = direct as Record<string, unknown>;
    const parts = [];
    const keys = [
      'street_address', 'house_name', 'house_number', 'locality', 'village', 'town', 'city',
      'district', 'state', 'post_office', 'landmark', 'pincode', 'pin_code', 'country',
    ];
    for (const k of keys) {
      const v = address[k];
      if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    }
    return parts.length > 0 ? parts.join(', ') : null;
  }
  const joined = [
    pick(root, 'address_line1'),
    pick(root, 'address_line2'),
    pick(root, 'address_line3'),
    pick(root, 'district'),
    pick(root, 'state'),
    pick(root, 'pincode'),
  ]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
  return joined.length > 0 ? joined.join(', ') : null;
}

function isValidDateOnly(iso: string | null): boolean {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  return true;
}

/** Build the configured OCR provider, or a fail-closed unconfigured one. */
export function createAadhaarOcrProviderFromConfig(cfg?: {
  providerName?: string;
  apiToken?: string;
  baseUrl?: string;
  ocrPath?: string;
  timeoutMs?: number;
}): AadhaarOcrProvider {
  if (cfg?.apiToken && cfg?.baseUrl) {
    return new SurepassAadhaarOcrProvider({
      providerName: cfg.providerName ?? '',
      apiToken: cfg.apiToken,
      baseUrl: cfg.baseUrl,
      ocrPath: cfg.ocrPath ?? '',
      timeoutMs: cfg.timeoutMs ?? 20_000,
    });
  }
  return {
    name: 'unconfigured',
    configured: false,
    ocr: () => Promise.resolve({ ok: false, reason: 'unconfigured' }),
  };
}