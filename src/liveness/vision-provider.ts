// PRIESTATE — Vision-engine boundary + in-memory motion/quality analysis.
//
// ⚠️ WHAT THIS ENGINE CAN AND CANNOT DO (honest capabilities):
//   * motion: YES — it computes frame-to-frame perceptual change on a small
//     greyscale grid. A significant, sustained change is a genuine, observable
//     "something moved" signal, usable as the core live-person check.
//   * biometricActions (blink, head-pose, raise-hand gestures): NO.
//     These require a real landmark/pose model and are therefore NEVER
//     fabricated — challenges needing them are excluded (fail closed).
//   * faceDetection: NO. No face is "seen"; only motion + frame quality.
//
// Everything is processed IN MEMORY on a tiny (e.g. 16x16) greyscale grid of
// each frame. No raw pixels, biometric data, or identifiers are retained,
// serialized, logged, or transmitted.

import { VisionCapabilities, FrameObservation, FrameQuality } from './types';

/** The capabilities this in-memory engine honestly advertises. */
export const IN_MEMORY_VISION_CAPABILITIES: VisionCapabilities = {
  motion: true,
  biometricActions: false,
  faceDetection: false,
};

/** Downsample a source to a small greyscale grid (as a flat len = w*h array). */
export type GreyFrame = ReadonlyArray<number>;

export interface GreyFrameSource {
  readonly widthPx: number;
  readonly heightPx: number;
  /** Read pixels at x,y (0..1 luminance). Implemented by the capture layer. */
  sample: (x: number, y: number) => number;
}

export interface MotionDetectorOptions {
  readonly grid: number;              // grid size (cells per side)
  readonly threshold?: number;        // mean |delta| that counts as motion (0..1)
  readonly hysteresisFrames?: number; // consecutive frames above threshold required
}

/**
 * Analyze one captured frame grid for motion versus a previous grid. Pure and
 * deterministic. `previous` may be null (first frame → no motion).
 */
export function analyzeFrameMotion(
  prev: GreyFrame | null,
  curr: GreyFrame,
  threshold = 0.04,
): FrameObservation {
  if (prev === null || prev.length !== curr.length || prev.length === 0) {
    return { motionDetected: false, motionMagnitude: 0 };
  }
  let sum = 0;
  for (let i = 0; i < curr.length; i += 1) {
    sum += Math.abs(curr[i] - prev[i]);
  }
  const magnitude = sum / curr.length;
  return { motionDetected: magnitude >= threshold, motionMagnitude: round4(magnitude) };
}

/**
 * Assess a frame grid for usability: brightness and contrast on the greyscale
 * grid. Pure and deterministic. Produces honest framing guidance.
 */
export function assessFrameQuality(
  frame: GreyFrame,
  opts: { minBrightness?: number; minContrast?: number } = {},
): FrameQuality {
  if (frame.length === 0) {
    return {
      brightness: 0,
      contrast: 0,
      usable: false,
      guidance: ['Camera is producing no visible image. Check the lens.'],
    };
  }
  let sum = 0;
  for (const v of frame) sum += v;
  const brightness = sum / frame.length;

  let varianceSum = 0;
  for (const v of frame) varianceSum += (v - brightness) * (v - brightness);
  const contrast = Math.sqrt(varianceSum / frame.length);

  const minBrightness = opts.minBrightness ?? 0.10;
  const minContrast = opts.minContrast ?? 0.04;

  const guidance: string[] = [];
  if (brightness < minBrightness) guidance.push('Improve lighting — the frame is too dark.');
  if (brightness > 0.92) guidance.push('Reduce glare — the frame is too bright.');
  if (contrast < minContrast) guidance.push('Move closer and keep your face centered.');
  if (guidance.length === 0) {
    return { brightness: round4(brightness), contrast: round4(contrast), usable: true, guidance: [] };
  }
  return { brightness: round4(brightness), contrast: round4(contrast), usable: false, guidance };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}