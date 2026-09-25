/**
 * `compact compile` wrapper that only recompiles when the output is stale.
 *
 * The PRIESTATE Compact contract compiles four circuits (≈50s on this
 * machine). `predev` and `prebuild` both invoke `npm run compile`, so every
 * dev-server restart was paying the full compile cost. This script checks
 * whether the generated artifacts under `contracts/managed/priestate` are
 * already up to date with:
 *
 *   - `contracts/priestate.compact` (the only local contract source; the rest
 *     of the inputs come from the installed Compact standard library), and
 *   - the `compact` binary itself (an upgraded compiler invalidates outputs).
 *
 * If every required marker output exists AND the source/binary are not newer
 * than the oldest marker, compilation is skipped. On a fresh clone (no
 * `contracts/managed/`) or after a source edit, it compiles exactly as before.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(projectRoot, 'contracts', 'priestate.compact');
const outputDir = path.join(projectRoot, 'contracts', 'managed', 'priestate');

// Representative outputs produced by `compact compile`. `contract/index.js`
// is imported by the app; `compiler/contract-info.json` backs the contract
// wiring; `keys`/`zkir` back the runtime proving artifacts.
const markers = [
  path.join(outputDir, 'contract', 'index.js'),
  path.join(outputDir, 'compiler', 'contract-info.json'),
  path.join(outputDir, 'keys', 'submitRegistration.prover'),
  path.join(outputDir, 'zkir', 'submitRegistration.bzkir'),
];

const oldestOutputMs = (): number =>
  Math.min(...markers.map((marker) => statSync(marker).mtimeMs));

const needsCompile = (): boolean => {
  if (!existsSync(source)) {
    throw new Error(`Missing contract source: ${source}`);
  }
  if (markers.some((marker) => !existsSync(marker))) return true;
  if (readdirSync(path.join(outputDir, 'keys')).length === 0) return true;
  if (readdirSync(path.join(outputDir, 'zkir')).length === 0) return true;

  const oldestOutput = oldestOutputMs();
  if (statSync(source).mtimeMs > oldestOutput) return true;

  // Recompile if the `compact` binary itself was installed/upgraded since the
  // last compile (a newer compiler can emit different artifacts).
  try {
    const compactPath = execFileSync('which', ['compact'], {
      encoding: 'utf8',
    }).trim();
    if (compactPath && existsSync(compactPath) && statSync(compactPath).mtimeMs > oldestOutput) {
      return true;
    }
  } catch {
    // `compact` not resolvable here; the spawn below will surface a real
    // launch error instead of silently skipping.
  }
  return false;
};

if (!needsCompile()) {
  console.log(
    `compact: ${path.relative(projectRoot, outputDir)} is up to date — skipping compile.`,
  );
  process.exit(0);
}

console.log('compact: compiling contracts/priestate.compact → contracts/managed/priestate …');
const result = spawnSync('compact', ['compile', source, outputDir], {
  cwd: projectRoot,
  stdio: 'inherit',
});
if (result.error) {
  console.error(`compact: could not launch binary: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);