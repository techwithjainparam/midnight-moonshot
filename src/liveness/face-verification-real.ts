// PRIESTATE — Real login face-verification descriptor provider (Level 3 Part 6).
//
// The real biometric reference lives on the verification server (encrypted at
// rest with a SEPARATE key), and the server does the actual match. All this
// module must do is produce a REAL live 128-d face embedding from the camera
// so the server can compare it to the stored reference. It never sees the
// reference and it never decides "matched" — the server owns that verdict.
//
// Design (mirrors `landmark-provider.ts`):
//   * BROWSER-ONLY + LAZY — `@vladmandic/face-api` and the recognition model
//     are only fetched on first need.
//   * FAIL-CLOSED — the recognition weights are vendored into `public/models`
//     (via `scripts/copy-face-models.ts`, which also copies the tiny detector +
//     tiny landmark nets) and served from `/models/`. `ensureReady()` only
//     reports success once detection + landmark + recognition nets all load;
//     any failure advertises NO descriptor capability rather than faking an
//     embedding.
//
// Privacy: the embedding is produced in memory, sent ONLY to the server's
// one-use verification endpoint under a single-use wallet-bound token, and is
// never stored by this client, placed in a URL/query/localStorage, logged, or
// written to the Midnight ledger.

import type { RawFrame } from './camera-capture';
import type { FaceVerificationCapability } from './face-verification';
import type { LandmarkProvider } from './landmark-provider';

export const EMBEDDING_DIM = 128;

/**
 * The descriptor provider exposes only what genuinely loaded. Real capability
 * set once the detector + landmark + recognition networks are all live.
 */
export const REAL_DESCRIPTOR_CAPABILITIES: ReadonlySet<FaceVerificationCapability> =
  new Set(['faceDetection', 'faceEmbedding', 'livenessActions']);

/**
 * Minimal surface of the face-api recognition machinery we use, so tests can
 * inject a fake without importing TFJS.
 */
export interface FaceRecognitionApi {
  nets: {
    faceRecognitionNet: { loadFromUri(uri: string): Promise<void> };
  };
  /** Produce a 128-d descriptor for one face. */
  computeFaceDescriptor(input: unknown): Promise<Float32Array>;
}

/**
 * A lazy real descriptor source. `ensureReady()` returns true only when the
 * face-api recognition network actually loaded (its weights are vendored under
 * `/models` by `scripts/copy-face-models.ts`). `descriptor(raw)` then yields a
 * real 128-d embedding usable with the server's verification endpoint.
 */
export interface RealDescriptorProvider {
  /** Advertising only what actually loaded; empty set = fail closed. */
  readonly capabilities: ReadonlySet<FaceVerificationCapability>;
  /** Load detector/landmark + recognition models. False on any failure. */
  ensureReady: () => Promise<boolean>;
  /** Produce a real 128-d embedding from a single live frame. */
  descriptor: (frame: RawFrame) => Promise<readonly number[] | null>;
}

export async function realDescriptorProvider(
  loadModule: () => Promise<FaceRecognitionApi | null> = loadFaceApiModule,
): Promise<RealDescriptorProvider> {
  const landmark = await loadLandmarkProvider();
  let module: FaceRecognitionApi | null = null;
  let modelLoaded = false;
  const capabilities = new Set<FaceVerificationCapability>();

  const ensureReady = async (): Promise<boolean> => {
    if (modelLoaded) return true;
    try {
      await landmark.loadModels();
      if (!landmark.capabilities.faceDetection) return false;
      module = await loadModule();
      if (!module) return false;
      await module.nets.faceRecognitionNet.loadFromUri('/models/face_recognition_model');
      modelLoaded = true;
      capabilities.clear();
      REAL_DESCRIPTOR_CAPABILITIES.forEach((c) => capabilities.add(c));
      return true;
    } catch {
      modelLoaded = false;
      capabilities.clear();
      return false;
    }
  };

  const descriptor = async (frame: RawFrame): Promise<readonly number[] | null> => {
    if (!modelLoaded || !module) return null;
    try {
      const detected = await landmark.detect(frame);
      if (!detected || detected.length !== 1) return null;
      const canvas = canvasFrom(frame);
      const vec = await module.computeFaceDescriptor(canvas);
      if (!vec || vec.length !== EMBEDDING_DIM) return null;
      const out: number[] = new Array(EMBEDDING_DIM);
      for (let i = 0; i < EMBEDDING_DIM; i += 1) out[i] = vec[i] ?? 0;
      return out;
    } catch {
      return null;
    }
  };

  return { capabilities, ensureReady, descriptor };
}

async function loadLandmarkProvider(): Promise<LandmarkProvider> {
  const { realLandmarkProvider } = await import('./landmark-provider');
  return realLandmarkProvider();
}

async function loadFaceApiModule(): Promise<FaceRecognitionApi | null> {
  try {
    const mod = (await import(/* @vite-ignore */ '@vladmandic/face-api')) as unknown as FaceRecognitionApi | null;
    return mod;
  } catch {
    return null;
  }
}

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