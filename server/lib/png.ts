// PRIESTATE — Minimal pure-JS PNG decoder (server-side only).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Decodes an 8-bit PNG (color types 0, 2, 3, 4, 6 — covering grayscale, RGB,
// palette, gray+alpha, and RGBA) into a flattened 8-bit RGBA buffer so the
// server can run REAL per-pixel validation (background whiteness / subject
// presence) on uploaded passport photos without trusting the browser. Uses the
// Node built-in `zlib` for inflate, so there is no native/graphical dependency.
//
// It validates structure and FAILS CLOSED on anything unsupported or corrupt;
// an undecodable upload is rejected, never "accepted".

import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** Flattened RGBA (4 bytes per pixel), 8-bit per channel. */
  readonly rgba: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const COLOR_GRAY = 0;
const COLOR_RGB = 2;
const COLOR_PALETTE = 3;
const COLOR_GRAY_ALPHA = 4;
const COLOR_RGBA = 6;

interface Chunk {
  readonly type: string;
  readonly data: Buffer;
}

function readChunks(buf: Buffer): { chunks: Chunk[]; error: string | null } {
  if (buf.length < PNG_SIGNATURE.length + 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { chunks: [], error: 'not a PNG' };
  }
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    offset += 4;
    const type = buf.subarray(offset, offset + 4).toString('latin1');
    offset += 4;
    if (offset + length > buf.length) return { chunks, error: `truncated chunk ${type}` };
    const data = Buffer.from(buf.subarray(offset, offset + length));
    offset += length + 4; // skip CRC
    chunks.push({ type, data });
    if (type === 'IEND') break;
  }
  return { chunks, error: null };
}

function under(a: number, b: number): number {
  const v = a - b;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function upOver(a: number, b: number): number {
  const v = a - b;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Undo PNG scanline filtering (types 0–4) into raw bytes.
 */
function unfilterScanlines(width: number, height: number, bpp: number, raw: Buffer): { output: Buffer; error: string | null } {
  const stride = width * bpp;
  if (raw.length !== (stride + 1) * height) {
    return { output: Buffer.alloc(0), error: 'invalid scanline length' };
  }
  const output = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const lineStart = y * stride;
    const rawStart = y * (stride + 1) + 1;
    if (filter > 4) return { output: Buffer.alloc(0), error: 'bad filter type' };
    for (let x = 0; x < stride; x++) {
      const cur = raw[rawStart + x];
      const left = x >= bpp ? output[lineStart + x - bpp] : 0;
      const up = y > 0 ? output[lineStart + x - stride] : 0;
      const upLeft = y > 0 && x >= bpp ? output[lineStart + x - stride - bpp] : 0;
      let val = cur;
      switch (filter) {
        case 0:
          break;
        case 1:
          val = under(cur, left);
          break;
        case 2:
          val = under(cur, up);
          break;
        case 3:
          val = under(cur, Math.floor((left + up) / 2));
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          val = upOver(cur, predictor);
          break;
        }
      }
      output[lineStart + x] = val >>> 0;
    }
  }
  return { output, error: null };
}

/**
 * Decode a PNG buffer to RGBA. Returns null on any structural error.
 */
export function decodePng(buf: Buffer): DecodedPng | null {
  const { chunks, error } = readChunks(buf);
  if (error) return null;

  const ihdr = chunks.find((c) => c.type === 'IHDR');
  const idat = chunks.filter((c) => c.type === 'IDAT');
  const plte = chunks.find((c) => c.type === 'PLTE');
  if (!ihdr || idat.length === 0) return null;
  if (ihdr.data.length !== 13) return null;

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const compression = ihdr.data[10];
  const filterMethod = ihdr.data[11];
  const interlace = ihdr.data[12];

  if (width === 0 || height === 0 || width > 8192 || height > 8192) return null;
  if (bitDepth !== 8) return null;
  if (compression !== 0 || filterMethod !== 0 || interlace !== 0) return null;
  if (![COLOR_GRAY, COLOR_RGB, COLOR_PALETTE, COLOR_GRAY_ALPHA, COLOR_RGBA].includes(colorType)) return null;

  const channels =
    colorType === COLOR_GRAY ? 1
    : colorType === COLOR_GRAY_ALPHA ? 2
    : colorType === COLOR_RGB ? 3
    : colorType === COLOR_RGBA ? 4
    : 1;
  const bpp = channels;

  const compressed = Buffer.concat(idat.map((c) => c.data));
  let inflated: Buffer;
  try {
    inflated = inflateSync(compressed);
  } catch {
    return null;
  }

  const { output, error: unfilterError } = unfilterScanlines(width, height, bpp, inflated);
  if (unfilterError) return null;

  const rgba = Buffer.alloc(width * height * 4);
  let palette: Buffer | null = null;
  if (colorType === COLOR_PALETTE) {
    if (!plte || plte.data.length % 3 !== 0) return null;
    palette = plte.data;
  }

  const tRNS = chunks.find((c) => c.type === 'tRNS');

  for (let i = 0; i < width * height; i++) {
    const off = i * bpp;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    switch (colorType) {
      case COLOR_GRAY:
        r = g = b = output[off];
        break;
      case COLOR_GRAY_ALPHA:
        r = g = b = output[off];
        a = output[off + 1];
        break;
      case COLOR_RGB:
        r = output[off];
        g = output[off + 1];
        b = output[off + 2];
        break;
      case COLOR_RGBA:
        r = output[off];
        g = output[off + 1];
        b = output[off + 2];
        a = output[off + 3];
        break;
      case COLOR_PALETTE: {
        const idx = output[off];
        const pOff = idx * 3;
        r = palette![pOff];
        g = palette![pOff + 1];
        b = palette![pOff + 2];
        break;
      }
    }
    if (tRNS && colorType === COLOR_PALETTE && tRNS.data.length > 0) {
      const idx = output[off];
      if (idx < tRNS.data.length) a = tRNS.data[idx];
    }
    const outOff = i * 4;
    rgba[outOff] = r;
    rgba[outOff + 1] = g;
    rgba[outOff + 2] = b;
    rgba[outOff + 3] = a;
  }

  return { width, height, rgba };
}

/**
 * Sample a square block of pixels (corner regions, e.g. 8×8) and report the
 * fraction of pixels that read as "background" (transparent or near-white).
 * Used by the server-side photo validator.
 */
export function backgroundFraction(
  rgba: Buffer,
  width: number,
  height: number,
  block: { x0: number; y0: number; x1: number; y1: number },
): number {
  const x0 = Math.max(0, Math.min(width - 1, block.x0));
  const y0 = Math.max(0, Math.min(height - 1, block.y0));
  const x1 = Math.max(x0, Math.min(width - 1, block.x1));
  const y1 = Math.max(y0, Math.min(height - 1, block.y1));
  let bg = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const off = (y * width + x) * 4;
      const alpha = rgba[off + 3];
      if (alpha < 16) {
        bg++;
        total++;
        continue;
      }
      const r = rgba[off];
      const g = rgba[off + 1];
      const b = rgba[off + 2];
      if (r > 235 && g > 235 && b > 235) bg++;
      total++;
    }
  }
  return total === 0 ? 0 : bg / total;
}

/**
 * Whole-image foreground fraction: pixels that are neither near-white nor
 * transparent (i.e. the actual subject) over the total pixel count.
 */
export function foregroundFraction(rgba: Buffer, width: number, height: number): number {
  let fg = 0;
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const off = i * 4;
    const a = rgba[off + 3];
    const r = rgba[off];
    const g = rgba[off + 1];
    const b = rgba[off + 2];
    if (a >= 16 && !(r > 235 && g > 235 && b > 235)) fg++;
  }
  return total === 0 ? 0 : fg / total;
}