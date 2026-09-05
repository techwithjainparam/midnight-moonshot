// PRIESTATE — Real landmark/face provider boundary (Level 3 Part 7).
//
// This is the ONLY place that imports `@vladmandic/face-api` (TFJS). It is:
//   * BROWSER-ONLY — uses the metapackage's vendored TFJS esm build (the Node
//     `main` requires `@tensorflow/tfjs-node`, which we do NOT install). Node
//     tests therefore never touch TFJS; the pure analysis in `landmark.ts` and
//     `landmark-verifier.ts` is what runs under `npm test`.
//   * LAZY — the library and 16MB of models are only fetched on first need.
//   * FAIL-CLOSED — if the provider/model-load fails, we advertise NO
//     biometricActions/faceDetection capability rather than faking anything.
//
// Live usage: face-api's `detectAllFaces(input).withFaceLandmarks()` gives us,
// per face, a `detection` (with pixel-space `box`, `imageWidth/imageHeight`,
// `score`) and a `landmarks` (68 `positions`). We normalise those into the
// dimensionless `LandmarkFrame` shape the pure analysis expects.

import {
  FaceLandmarkFrame,
  LandmarkPoint,
} from './landmark';
import type { RawFrame } from './camera-capture';
import type { VisionCapabilities } from './types';

/** Capabilities advertised once the real provider + models load successfully. */
export const REAL_LANDMARK_CAPABILITIES: VisionCapabilities = {
  motion: true,
  biometricActions: true,
  faceDetection: true,
};

/**
 * Capabilities advertised when the real provider is present but its models are
 * NOT loaded (or loading failed). Motion is still available (the in-memory
 * engine backs it) but we do NOT pretend to detect faces or biometrics.
 */
export const UNLOADED_BIOMETRIC_CAPABILITIES: VisionCapabilities = {
  motion: true,
  biometricActions: false,
  faceDetection: false,
};

/** Capabilities when the browser cannot load the provider at all. */
export const UNDETECTABLE_CAPABILITIES: VisionCapabilities = {
  motion: false,
  biometricActions: false,
  faceDetection: false,
};

/**
 * A lazy, browser-only face-api facade. Construct via `realLandmarkProvider()`.
 * Detecting requires the models to be loaded first; any failure to load leaves
 * `capabilities` at the unloaded/undetectable values (fail closed).
 */
export interface LandmarkProvider {
  /** Advertised capability of the CURRENT load state. */
  readonly capabilities: VisionCapabilities;
  /** Load the bundled detector + landmark models from /models. */
  loadModels: () => Promise<void>;
  /**
   * Detect faces + 68 landmarks in a raw camera frame. Returns null (no throw)
   * if models are not loaded or inference fails, so callers can fail closed.
   */
  detect: (frame: RawFrame) => Promise<readonly FaceLandmarkFrame[] | null>;
}

/**
 * Interface for the subset of the face-api module surface we use, so tests can
 * hand us a fake without importing TFJS.
 */
export interface FaceApiModule {
  detectAllFaces(input: unknown, options?: unknown): {
    withFaceLandmarks(useTiny?: boolean): {
      run(): Promise<
        ReadonlyArray<{
          detection: {
            box: { x: number; y: number; width: number; height: number };
            score: number;
            imageWidth: number;
            imageHeight: number;
          };
          landmarks: { positions: readonly { x: number; y: number }[] };
        }>
      >;
    };
  };
}

/**
 * Build a real provider guarded by lazy `import('@vladmandic/face-api')`.
 * `loadModule` is overridable for tests. Models are expected under `/models/`
 * (served by Vite from `public/models`, populated by `copy-face-models`).
 */
export async function realLandmarkProvider(
  loadModule: () => Promise<FaceApiModule> = () =>
    import(/* @vite-ignore */ '@vladmandic/face-api') as Promise<FaceApiModule>,
): Promise<LandmarkProvider> {
  let module: FaceApiModule | null = null;
  const state = { capabilities: UNDETECTABLE_CAPABILITIES as VisionCapabilities, loaded: false };

  const loadModels = async (): Promise<void> => {
    if (state.loaded) return;
    try {
      module = await loadModule();
      // Load only the two networks we need (tiny detector + tiny landmarks).
      const nets = (module as unknown as { nets: { tinyFaceDetector: { loadFromUri(u: string): Promise<void> }; faceLandmark68TinyNet: { loadFromUri(u: string): Promise<void> } } }).nets;
      await nets.tinyFaceDetector.loadFromUri('/models/');
      await nets.faceLandmark68TinyNet.loadFromUri('/models/');
      state.loaded = true;
      state.capabilities = REAL_LANDMARK_CAPABILITIES;
    } catch {
      state.loaded = false;
      state.capabilities = UNLOADED_BIOMETRIC_CAPABILITIES;
    }
  };

  const detect = async (frame: RawFrame): Promise<readonly FaceLandmarkFrame[] | null> => {
    if (!state.loaded || !module) return null;
    try {
      const input = canvasFrom(frame);
      // face-api's fluent pipeline: detectAllFaces(img).withFaceLandmarks().run()
      const detector = module.detectAllFaces(input) as unknown as {
        withFaceLandmarks(useTiny?: boolean): { run(): Promise<unknown> };
      };
      const results = await detector.withFaceLandmarks(true).run();
      // Normalise pixel-space detections into dimensionless landmark frames.
      const faces: FaceLandmarkFrame[] = [];
      for (const r of results as ReadonlyArray<{
        detection: {
          box: { x: number; y: number; width: number; height: number };
          score: number;
          imageWidth: number;
          imageHeight: number;
        };
        landmarks: { positions: readonly { x: number; y: number }[] };
      }>) {
        const d = r.detection;
        const iw = Math.max(1, d.imageWidth);
        const ih = Math.max(1, d.imageHeight);
        const box = {
          left: d.box.x / iw,
          top: d.box.y / ih,
          width: d.box.width / iw,
          height: d.box.height / ih,
        };
        const landmarks: LandmarkPoint[] = r.landmarks.positions.slice(0, 68).map((p) => ({
          x: p.x / iw,
          y: p.y / ih,
        }));
        faces.push({
          box,
          detectionScore: d.score,
          landmarks,
          faceCount: (results as unknown[]).length,
        });
      }
      return faces;
    } catch {
      return null;
    }
  };

  return { capabilities: state.capabilities, loadModels, detect };
}

/** Draw a raw frame into a temporary canvas face-api can consume. */
function canvasFrom(frame: RawFrame): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const img = ctx.createImageData(frame.width, frame.height);
    img.data.set(frame.rgb as unknown as ArrayLike<number>);
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}