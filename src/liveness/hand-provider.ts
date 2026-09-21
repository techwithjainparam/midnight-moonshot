// PRIESTATE — Real hand/finger landmark provider boundary for the registration
// liveness hand-up + finger-count challenges.
//
// BROWSER-ONLY, LAZY, FAIL-CLOSED. This is the ONLY place that imports
// `@mediapipe/tasks-vision`. It:
//   * is imported lazily on first need (the package + WASM + model are heavy
//     and are only fetched when a hand challenge actually runs),
//   * loads the WASM fileset from `/mediapipe/` (vendored by
//     `scripts/copy-hand-models.ts`) and the HandLandmarker model from
//     `/models/hand_landmarker.task` (also vendored), serving both offline —
//     no runtime third-party request,
//   * runs REAL MediaPipe Hands inference over camera frames and normalises the
//     21-landmark mesh + confidence into the pure, testable `HandLandmarks`
//     shape consumed by `hand.ts`,
//   * advertises NO hand capability and returns `null` if the module, the
//     wasm/fileset, or the model cannot be loaded — the liveness flow then
//     fails closed instead of fabricating gesture evidence,
//   * exposes `dispose()` so the wasm-backed landmarker can be released when
//     the liveness session ends (camera/mic teardown lives in the component).
//
// The remainder of the app never touches @mediapipe/tasks-vision directly.

import type { RawFrame } from './camera-capture';
import type { HandLandmarks } from './hand';

export interface HandProviderCapabilities {
  readonly handDetection: boolean;
}

/** Capabilities when the real provider + model are loaded. */
export const REAL_HAND_CAPABILITIES: HandProviderCapabilities = { handDetection: true };

/** Capabilities when loading failed or never attempted. */
export const NO_HAND_CAPABILITIES: HandProviderCapabilities = { handDetection: false };

/**
 * Minimal surface of the @mediapipe/tasks-vision API we use, so Node tests can
 * inject a fake module without importing MediaPipe or touching the DOM.
 */
export interface MediaPipeVisionModule {
  FilesetResolver: {
    forVisionTasks(basePath: string, useModule?: boolean): Promise<unknown>;
  };
  HandLandmarker: {
    createFromOptions(
      fileset: unknown,
      options: {
        baseOptions: { modelAssetPath: string; delegate?: 'CPU' | 'GPU' };
        runningMode: 'VIDEO';
        numHands: number;
        minHandDetectionConfidence: number;
        minHandPresenceConfidence: number;
        minTrackingConfidence: number;
      },
    ): Promise<{
      detectForVideo(
        frame: ImageData,
        timestampMs: number,
      ): {
        landmarks: ReadonlyArray<ReadonlyArray<{ x: number; y: number; z?: number }>>;
        handedness: ReadonlyArray<ReadonlyArray<{ score: number; categoryName?: string }>>;
      };
      close(): void;
    }>;
  };
}

export interface HandDetectorProvider {
  /** Advertised capability of the CURRENT load state. */
  readonly capabilities: HandProviderCapabilities;
  /** Load /mediapipe wasm fileset + the hand model. Fail-closed on error. */
  loadModels: () => Promise<void>;
  /** Detect a hand in one raw camera frame. `null` → nothing usable (never fabricates). */
  detect: (frame: RawFrame) => Promise<HandLandmarks | null>;
  /** Release the wasm landmarker; safe to call multiple times. */
  dispose: () => void;
}

/** Default locations served from the app's public dir (offline-capable). */
export const HAND_WASM_BASE =
  (typeof import.meta.env !== 'undefined' && import.meta.env?.VITE_HAND_WASM_BASE) || '/mediapipe/';
export const HAND_MODEL_URL =
  (typeof import.meta.env !== 'undefined' && import.meta.env?.VITE_HAND_MODEL_URL) || '/models/hand_landmarker.task';

/**
 * Build the real provider, guarding on a lazy
 * `import('@mediapipe/tasks-vision')`. `loadModule` is overridable for tests.
 */
export async function realHandProvider(
  loadModule: () => Promise<MediaPipeVisionModule> = () =>
    import('@mediapipe/tasks-vision') as Promise<MediaPipeVisionModule>,
): Promise<HandDetectorProvider> {
  let module: MediaPipeVisionModule | null = null;
  let landmarker: {
    detectForVideo(frame: ImageData, timestampMs: number): {
      landmarks: ReadonlyArray<ReadonlyArray<{ x: number; y: number; z?: number }>>;
      handedness: ReadonlyArray<ReadonlyArray<{ score: number }>>;
    };
    close(): void;
  } | null = null;

  const capabilities: { handDetection: boolean } = { handDetection: NO_HAND_CAPABILITIES.handDetection };

  const loadModels = async (): Promise<void> => {
    if (capabilities.handDetection) return;
    try {
      module = await loadModule();
      const fileset = await module.FilesetResolver.forVisionTasks(HAND_WASM_BASE);
      landmarker = await module.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      capabilities.handDetection = true;
    } catch {
      capabilities.handDetection = false;
    }
  };

  const detect = async (frame: RawFrame): Promise<HandLandmarks | null> => {
    if (!capabilities.handDetection || !landmarker) return null;
    try {
      const image = imageDataFrom(frame);
      const result = landmarker.detectForVideo(image, performance.now());
      const hand = result.landmarks[0];
      if (!hand) return null;
      const score = result.handedness?.[0]?.[0]?.score ?? 1;
      return {
        landmarks: hand.map((p) => ({ x: p.x, y: p.y })),
        score,
      };
    } catch {
      return null;
    }
  };

  const dispose = (): void => {
    try {
      landmarker?.close();
    } catch {
      // already closed / never created
    }
    landmarker = null;
    capabilities.handDetection = false;
  };

  return { capabilities, loadModels, detect, dispose };
}

/** Convert a raw RGB frame into an RGBA ImageData MediaPipe can ingest. */
function imageDataFrom(frame: RawFrame): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx?.createImageData(frame.width, frame.height);
  if (!image || !ctx) {
    throw new Error('no 2d context');
  }
  const { width, height } = frame;
  const src = frame.rgb;
  const out = image.data;
  for (let i = 0; i < width * height; i += 1) {
    const s = i * 3;
    const d = i * 4;
    out[d] = src[s];
    out[d + 1] = src[s + 1];
    out[d + 2] = src[s + 2];
    out[d + 3] = 255;
  }
  return image;
}