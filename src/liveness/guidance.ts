// PRIESTATE — Liveness framing guidance (Level 3 Part 4).
//
// Honest, human-readable coaching messages shown BEFORE and DURING challenges.
// Guidance is derived only from what the in-memory engine can actually measure
// (brightness, contrast, and frame-to-frame motion) — it never claims to see a
// "face" or detect a pose, because this engine cannot.

import { FrameQuality } from './types';

/**
 * Turn a frame-quality assessment into concise, actionable guidance. Returns an
 * empty array when the frame is usable (no guidance needed).
 */
export function guidanceForQuality(q: FrameQuality): readonly string[] {
  if (q.usable) return [];
  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of q.guidance) {
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

/** Coaching hint for a motion challenge when no motion has been observed yet. */
export function motionHint(attempt: number): string {
  if (attempt < 20) return 'Follow the instruction — we are watching for movement.';
  if (attempt < 40) return 'Keep going. Move a little more clearly and hold each pose.';
  return 'Still not detected. Make bigger, slower movements and improve the lighting.';
}