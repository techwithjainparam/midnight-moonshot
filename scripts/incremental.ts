/**
 * Shared helpers for incremental (content-aware) dev prep.
 *
 * `copyIfNeeded` copies a file only when the destination is missing or its
 * bytes differ from the source (size + SHA-256). Identical, already-vendored
 * artifacts are left untouched so repeated `predev` / `prebuild` runs do not
 * rewrite public/ contents on every server start.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const sameContent = (src: string, dst: string): boolean => {
  if (!existsSync(dst)) return false;
  const srcStat = statSync(src);
  const dstStat = statSync(dst);
  if (srcStat.size !== dstStat.size) return false;
  const srcHash = createHash('sha256').update(readFileSync(src)).digest();
  const dstHash = createHash('sha256').update(readFileSync(dst)).digest();
  return srcHash.equals(dstHash);
};

export const copyIfNeeded = (src: string, dst: string): 'copied' | 'skipped' => {
  if (sameContent(src, dst)) return 'skipped';
  mkdirSync(path.dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return 'copied';
};

export const rel = (projectRoot: string, p: string): string =>
  path.relative(projectRoot, p);