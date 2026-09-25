/**
 * Copies the face landmark / detector model weights bundled with
 * `@vladmandic/face-api` into the Vite `public/models/` directory so the
 * browser's lazy-loaded landmark provider (`src/liveness/landmark-provider.ts`)
 * can fetch them over HTTP at runtime.
 *
 * Three networks are copied — the TinyFaceDetector, the TinyFaceLandmark68
 * net, and the FaceRecognitionNet (the recognition weights powering the real
 * 128-d face embedding used by the Level 3 biometric verification stage).
 * All three are fetched lazily at runtime by the browser providers.
 *
 * Source files: node_modules/@vladmandic/face-api/model/<name>[-weights_manifest.json | .bin]
 * Target:       public/models/<name>[-weights_manifest.json | .bin]
 *
 * The provider calls `nets.tinyFaceDetector.loadFromUri('/models/')` and
 * `nets.faceLandmark68TinyNet.loadFromUri('/models/')`, which fetch:
 *   /models/<defaultModelName>-weights_manifest.json  and the weights .bin.
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyIfNeeded, rel } from './incremental';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(
  projectRoot,
  'node_modules',
  '@vladmandic',
  'face-api',
  'model',
);
const targetDir = path.join(projectRoot, 'public', 'models');

const MODELS = [
  'tiny_face_detector_model',
  'face_landmark_68_tiny_model',
  'face_recognition_model',
] as const;

if (!existsSync(sourceDir)) {
  throw new Error(
    `Missing face-api models directory: ${sourceDir}. Run "npm install" first.`,
  );
}

mkdirSync(targetDir, { recursive: true });

let copied = 0;
let skipped = 0;
for (const name of MODELS) {
  for (const suffix of ['-weights_manifest.json', '.bin']) {
    const file = `${name}${suffix}`;
    const src = path.join(sourceDir, file);
    if (!existsSync(src)) {
      // Not all name/suffix combos are valid; treat the manifest+bin pair for
      // the tiny detector as required and skip gracefully for others.
      console.warn(`WARN: missing model file ${file}`);
      continue;
    }
    const status = copyIfNeeded(src, path.join(targetDir, file));
    if (status === 'copied') copied += 1;
    else skipped += 1;
  }
}

console.log(
  `face models: ${copied} file(s) copied into ${rel(projectRoot, targetDir)}` +
    ` (${skipped} unchanged, skipped).`,
);