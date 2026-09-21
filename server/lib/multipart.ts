// PRIESTATE — Minimal multipart/form-data parser (server-side only).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Parses an RFC 2046 multipart/form-data body from the raw bytes of an HTTP
// request (used for document/photo uploads). It only supports the single
// `multipart/form-data; boundary=...` content type, tolerates CRLF/LF line
// endings, and fails closed on any malformed framing or overlong body.

export interface ParsedFilePart {
  readonly name: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly data: Buffer;
}

export interface ParsedMultipartBody {
  readonly files: readonly ParsedFilePart[];
  readonly fields: Readonly<Record<string, string>>;
}

export type MultipartParseResult =
  | { ok: true; body: ParsedMultipartBody }
  | { ok: false; reason: 'not-multipart' | 'no-boundary' | 'malformed' | 'unterminated' | 'too-large' };

export const MAX_MULTIPART_BYTES = 16 * 1024 * 1024;

/** Extract the `boundary` from a `Content-Type` header. */
export function boundaryFromContentType(contentType: string | undefined): string | null {
  if (!contentType || contentType.split(';')[0].trim().toLowerCase() !== 'multipart/form-data') {
    return null;
  }
  for (const part of contentType.split(';').slice(1)) {
    const [k, ...rest] = part.trim().split('=');
    if (k === undefined) continue;
    if (k.trim().toLowerCase() === 'boundary') {
      const value = rest.join('=').trim();
      const unquoted = value.replace(/^["']|["']$/g, '');
      return unquoted.length > 0 && unquoted.length <= 200 ? unquoted : null;
    }
  }
  return null;
}

export function parseMultipart(
  contentType: string | undefined,
  raw: Buffer,
  maxBytes: number = MAX_MULTIPART_BYTES,
): MultipartParseResult {
  if (raw.length > maxBytes) return { ok: false, reason: 'too-large' };
  const boundary = boundaryFromContentType(contentType);
  if (!boundary) return { ok: false, reason: 'not-multipart' };

  const delimiter = Buffer.from(`--${boundary}`, 'binary');
  const first = Buffer.from(`--${boundary}--`, 'binary');

  const firstIdx = indexOf(raw, delimiter);
  if (firstIdx !== 0) return { ok: false, reason: 'malformed' };

  const files: ParsedFilePart[] = [];
  const fields: Record<string, string> = {};
  let pos = delimiter.length;
  if (pos < raw.length && (raw[pos] === 0x0d || raw[pos] === 0x0a)) {
    pos = skipLineEnd(raw, pos);
  } else {
    return { ok: false, reason: 'malformed' };
  }

  while (pos < raw.length) {
    const nextFinal = indexOf(raw, first, pos);
    // A part separator `--boundary` must NOT be a prefix of the closing
    // `--boundary--`: find the next `--boundary` that is not followed by `--`.
    const nextDelim = indexOfSeparator(raw, delimiter, pos);
    const stop = nextFinal >= 0 && (nextDelim < 0 || nextFinal < nextDelim) ? nextFinal : nextDelim;
    if (stop < 0) return { ok: false, reason: 'unterminated' };

    // The CRLF just before a delimiter belongs to the boundary framing, not
    // to the part content.
    let contentEnd = stop;
    if (contentEnd > pos && raw[contentEnd - 1] === 0x0a) {
      contentEnd -= 1;
      if (contentEnd > pos && raw[contentEnd - 1] === 0x0d) contentEnd -= 1;
    }
    const partRaw = raw.subarray(pos, contentEnd);

    pos = stop + delimiter.length;
    if (stop === nextFinal) {
      if (pos < raw.length) {
        const skip = skipLineEnd(raw, pos);
        if (skip !== pos) pos = skip;
      }
    } else if (pos < raw.length && (raw[pos] === 0x0d || raw[pos] === 0x0a)) {
      pos = skipLineEnd(raw, pos);
    } else if (stop !== nextFinal) {
      return { ok: false, reason: 'malformed' };
    }

    const parsed = parsePart(partRaw);
    if (!parsed) return { ok: false, reason: 'malformed' };
    const { headers, body } = parsed;
    const disposition = headers['content-disposition'];
    if (!disposition) return { ok: false, reason: 'malformed' };
    const name = /;?\s*name="([^"]*)"/.exec(disposition)?.[1];
    if (!name) return { ok: false, reason: 'malformed' };
    if (name in fields) return { ok: false, reason: 'malformed' };

    const fileName = /;?\s*filename="([^"]*)"/i.exec(disposition)?.[1] ?? '';
    if (fileName) {
      const mimeType = headers['content-type'] ?? 'application/octet-stream';
      files.push({ name, fileName, mimeType, data: Buffer.from(body) });
    } else {
      fields[name] = body.toString('utf8');
    }

    if (stop === nextFinal) break;
  }

  return { ok: true, body: { files, fields } };
}

function parsePart(raw: Buffer): { headers: Record<string, string>; body: Buffer } | null {
  const headerEnd = raw.indexOf('\r\n\r\n');
  const headerEndLf = headerEnd < 0 ? raw.indexOf('\n\n') : headerEnd;
  if (headerEndLf < 0) return null;
  const headerBlock = raw.subarray(0, headerEndLf).toString('utf8');
  const bodyBegin = headerEndLf + (raw[headerEndLf] === 0x0d ? 4 : 2);
  const headers: Record<string, string> = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) return null;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key || key in headers) return null;
    headers[key] = value;
  }
  if (!('content-disposition' in headers)) return null;
  return { headers, body: raw.subarray(bodyBegin) };
}

function indexOf(haystack: Buffer, needle: Buffer, from = 0): number {
  if (needle.length === 0) return from;
  if (needle.length > haystack.length - from) return -1;
  outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Find the next occurrence of `delimiter` that is NOT immediately followed by
 * `--` (which would make it part of the closing `--delimiter--` frame). This
 * keeps a part separator from being confused with the end-of-body marker.
 */
function indexOfSeparator(haystack: Buffer, delimiter: Buffer, from = 0): number {
  let base = from;
  for (;;) {
    const at = indexOf(haystack, delimiter, base);
    if (at < 0) return -1;
    const after = at + delimiter.length;
    if (haystack[after] === 0x2d && haystack[after + 1] === 0x2d) {
      // This is the closing frame; keep scanning for a real separator.
      base = after;
      continue;
    }
    return at;
  }
}

function skipLineEnd(buf: Buffer, pos: number): number {
  if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) return pos + 2;
  if (buf[pos] === 0x0a) return pos + 1;
  return pos;
}