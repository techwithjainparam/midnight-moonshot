/**
 * Copies the face landmark / detector model weights bundled with
 * `@vladmandic/face-api` into the Vite `public/models/` directory so the
 * browser's lazy-loaded landmark provider (`src/liveness/landmark-provider.ts`)
 * can fetch them over HTTP at runtime.
 *
 * Only the two networks PRIVESTATE uses are copied — the TinyFaceDetector and
 * the TinyFaceLandmark68 net — which together are ~270KB. The larger
 * recognition / full landmark / expression models are intentionally NOT copied.
 *
 * Source files: node_modules/@vladmandic/face-api/model/<name>[-weights_manifest.json | .bin]
 * Target:       public/models/<name>[-weights_manifest.json | .bin]
 *
 * The provider calls `nets.tinyFaceDetector.loadFromUri('/models/')` and
 * `nets.faceLandmark68TinyNet.loadFromUri('/models/')`, which fetch:
 *   /models/<defaultModelName>-weights_manifest.json  and the weights .bin.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(
  projectRoot,
  'node_modules',
  '@vladmandic',
  'face-api',
  'model',
);
const targetDir = path.join(projectRoot, 'public', 'models');

const MODELS = ['tiny_face_detector_model', 'face_landmark_68_tiny_model'] as const;

if (!existsSync(sourceDir)) {
  throw new Error(
    `Missing face-api models directory: ${sourceDir}. Run "npm install" first.`,
  );
}

mkdirSync(targetDir, { recursive: true });

let copied = 0;
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
    copyFileSync(src, path.join(targetDir, file));
    copied += 1;
  }
}

console.log(
  `Copied ${copied} face model file(s) into ${path.relative(projectRoot, targetDir)}.`,
);