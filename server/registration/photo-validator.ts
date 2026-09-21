// PRIESTATE — Server-side passport-photo validation (server-side only).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// The client performs REAL AI background segmentation (see the photo step).
// The server does NOT trust the browser: it decodes the submitted PNG and runs
// REAL per-pixel checks to confirm a passport-style image:
//   * the four corner regions are white/transparent (a segmented background),
//   * a foreground subject occupies a plausible passport-photo fraction,
//   * the aspect ratio is near-square (passport-style crop).
// An upload that fails these checks is rejected — a CSS "white box" trick
// (subject pixels bleeding to the frame) is caught because the corners would
// remain non-background.
//
// The raw bytes are held only for the duration of validation and are never
// persisted in clear; callers store only an encrypted copy (or nothing).

import { decodePng, backgroundFraction, foregroundFraction } from '../lib/png.js';

export interface PhotoValidationConfig {
  readonly maxBytes: number;
  readonly minDimensionPx: number;
  readonly maxDimensionPx: number;
  readonly minBackgroundFractionPerCorner: number;
  readonly minForegroundFraction: number;
  readonly maxForegroundFraction: number;
  readonly minAspectRatio: number;
  readonly maxAspectRatio: number;
}

export const DEFAULT_PHOTO_VALIDATION_CONFIG: Required<PhotoValidationConfig> = {
  maxBytes: 8 * 1024 * 1024,
  minDimensionPx: 300,
  maxDimensionPx: 2048,
  minBackgroundFractionPerCorner: 0.7,
  minForegroundFraction: 0.02,
  maxForegroundFraction: 0.7,
  minAspectRatio: 0.55,
  maxAspectRatio: 1.45,
};

export type PhotoValidationResult =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: 'too-large' | 'not-png' | 'dimensions' | 'background' | 'aspect' | 'subject' };

/**
 * Decode + validate a passport-photo PNG. Pure, deterministic, fail-closed:
 * any structural or content anomaly is rejected. `raw` must be a PNG buffer
 * (the browser step converts camera/file captures to PNG before uploading).
 */
export function validatePassportPhoto(
  raw: Buffer,
  config: Partial<PhotoValidationConfig> = {},
): PhotoValidationResult {
  const cfg = { ...DEFAULT_PHOTO_VALIDATION_CONFIG, ...config };

  if (raw.length > cfg.maxBytes) return { ok: false, reason: 'too-large' };

  const png = decodePng(raw);
  if (!png) return { ok: false, reason: 'not-png' };

  if (png.width < cfg.minDimensionPx || png.width > cfg.maxDimensionPx) {
    return { ok: false, reason: 'dimensions' };
  }
  if (png.height < cfg.minDimensionPx || png.height > cfg.maxDimensionPx) {
    return { ok: false, reason: 'dimensions' };
  }

  const aspect = png.width / png.height;
  if (aspect < cfg.minAspectRatio || aspect > cfg.maxAspectRatio) {
    return { ok: false, reason: 'aspect' };
  }

  const block = 8;
  const topLeft = { x0: 0, y0: 0, x1: block, y1: block };
  const topRight = { x0: png.width - block - 1, y0: 0, x1: png.width - 1, y1: block };
  const bottomLeft = { x0: 0, y0: png.height - block - 1, x1: block, y1: png.height - 1 };
  const bottomRight = {
    x0: png.width - block - 1,
    y0: png.height - block - 1,
    x1: png.width - 1,
    y1: png.height - 1,
  };
  const corners = [topLeft, topRight, bottomLeft, bottomRight].map((c) =>
    backgroundFraction(png.rgba, png.width, png.height, c),
  );
  if (corners.some((f) => f < cfg.minBackgroundFractionPerCorner)) {
    return { ok: false, reason: 'background' };
  }

  const fg = foregroundFraction(png.rgba, png.width, png.height);
  if (fg < cfg.minForegroundFraction || fg > cfg.maxForegroundFraction) {
    return { ok: false, reason: 'subject' };
  }

  return { ok: true, width: png.width, height: png.height };
}