/**
 * Copies the Compact-generated circuit artifacts into the Vite `public/`
 * directory so the browser's `FetchZkConfigProvider` can serve them.
 *
 * `src/lace.ts` constructs `FetchZkConfigProvider` with `window.location.origin`
 * as its base URL, and the provider fetches these paths at runtime:
 *
 *   /keys/<circuit>.prover
 *   /keys/<circuit>.verifier
 *   /zkir/<circuit>.bzkir
 *
 * Vite serves everything under `public/` from the site root, so the artifacts
 * are mirrored as:
 *
 *   contracts/managed/priestate/keys/*.prover   -> public/keys/
 *   contracts/managed/priestate/keys/*.verifier -> public/keys/
 *   contracts/managed/priestate/zkir/*.bzkir    -> public/zkir/
 *
 * The plain `.zkir` file is not required at runtime (the provider requests the
 * compiled `.bzkir` form) and is therefore not copied.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyIfNeeded, rel } from './incremental';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const managedDir = path.join(projectRoot, 'contracts', 'managed', 'priestate');
const publicDir = path.join(projectRoot, 'public');

const keysSource = path.join(managedDir, 'keys');
const zkirSource = path.join(managedDir, 'zkir');
const keysTarget = path.join(publicDir, 'keys');
const zkirTarget = path.join(publicDir, 'zkir');

const copyMatching = (
  sourceDir: string,
  targetDir: string,
  extensions: readonly string[],
): { copied: number; skipped: number } => {
  if (!existsSync(sourceDir)) {
    throw new Error(`Missing generated artifacts directory: ${sourceDir}. Run "npm run compile" first.`);
  }
  mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  let skipped = 0;
  const files = readdirSync(sourceDir).filter((file) =>
    extensions.some((extension) => file.endsWith(extension)),
  );
  for (const file of files) {
    const status = copyIfNeeded(path.join(sourceDir, file), path.join(targetDir, file));
    if (status === 'copied') copied += 1;
    else skipped += 1;
  }
  return { copied, skipped };
};

const keyFiles = copyMatching(keysSource, keysTarget, ['.prover', '.verifier']);
const zkirFiles = copyMatching(zkirSource, zkirTarget, ['.bzkir']);

console.log(
  `circuits: ${keyFiles.copied + zkirFiles.copied} file(s) copied into ` +
    `${rel(projectRoot, keysTarget)} + ${rel(projectRoot, zkirTarget)}` +
    ` (${keyFiles.skipped + zkirFiles.skipped} unchanged, skipped).`,
);
