/**
 * Vendors the real MediaPipe HandLandmarker assets that the registration
 * liveness hand-up / finger-count challenges need:
 *
 *   1. The MediaPipe "Tasks Vision" WASM loader pair
 *      (vision_wasm_internal.js + .wasm) from the installed
 *      `@mediapipe/tasks-vision` package → `public/mediapipe/`.
 *   2. The HandLandmarker model (`hand_landmarker.task`) from Google's
 *      official MediaPipe model zoo → `public/models/`.
 *
 * The browser provider (`src/liveness/hand-provider.ts`) calls
 * `FilesetResolver.forVisionTasks('/mediapipe/')` and points the landmarker's
 * `modelAssetPath` at `/models/hand_landmarker.task`, both served offline by
 * the app once this script has run (part of `predev` / `prebuild`).
 *
 * The model is only fetched when a hand challenge first needs it and is served
 * locally afterwards — no runtime third-party request. If the download fails
 * the provider advertises NO hand capability and the liveness flow fails
 * closed rather than fabricating gesture evidence.
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { copyIfNeeded, rel } from './incremental';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WASM_SOURCE_DIR = path.join(projectRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const WASM_TARGET_DIR = path.join(projectRoot, 'public', 'mediapipe');
const MODEL_TARGET_DIR = path.join(projectRoot, 'public', 'models');

/** Official Google-hosted MediaPipe model (palm detection + hand landmarks). */
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
const HAND_MODEL_FILE = path.join(MODEL_TARGET_DIR, 'hand_landmarker.task');

const WASM_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'] as const;

if (!existsSync(WASM_SOURCE_DIR)) {
  throw new Error(
    `Missing MediaPipe tasks-vision wasm directory: ${WASM_SOURCE_DIR}. Run "npm install" first.`,
  );
}

mkdirSync(WASM_TARGET_DIR, { recursive: true });
mkdirSync(MODEL_TARGET_DIR, { recursive: true });

let wasmCopied = 0;
let wasmSkipped = 0;
for (const file of WASM_FILES) {
  const src = path.join(WASM_SOURCE_DIR, file);
  if (!existsSync(src)) {
    console.warn(`WARN: missing MediaPipe wasm file ${file}`);
    continue;
  }
  const status = copyIfNeeded(src, path.join(WASM_TARGET_DIR, file));
  if (status === 'copied') wasmCopied += 1;
  else wasmSkipped += 1;
}
console.log(
  `hand models: ${wasmCopied} MediaPipe wasm file(s) copied into ${rel(projectRoot, WASM_TARGET_DIR)}` +
    ` (${wasmSkipped} unchanged, skipped).`,
);

if (existsSync(HAND_MODEL_FILE) && statSync(HAND_MODEL_FILE).size > 1_000_000) {
  console.log(
    `Hand model already present: ${path.relative(projectRoot, HAND_MODEL_FILE)} (${
      (statSync(HAND_MODEL_FILE).size / 1_000_000).toFixed(1)
    } MB).`,
  );
} else {
  console.log(`Downloading HandLandmarker model from the official MediaPipe zoo…`);
  const response = await fetch(HAND_MODEL_URL);
  if (!response.ok || !response.body) {
    throw new Error(
      `Could not download the HandLandmarker model (HTTP ${response.status}). ` +
        'The hand-up / finger-count liveness challenges will fail closed at runtime.',
    );
  }
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(HAND_MODEL_FILE);
    Readable.fromWeb(response.body as never)
      .on('error', reject)
      .pipe(out)
      .on('finish', () => resolve())
      .on('error', reject);
  });
  console.log(
    `Downloaded hand model: ${path.relative(projectRoot, HAND_MODEL_FILE)} (${
      (statSync(HAND_MODEL_FILE).size / 1_000_000).toFixed(1)
    } MB).`,
  );
}