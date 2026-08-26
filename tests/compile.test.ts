import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractSource = path.join(root, 'contracts', 'priestate.compact');
const managedDir = path.join(root, 'contracts', 'managed', 'priestate');

test('compact toolchain is available on PATH', () => {
  const res = spawnSync('compact', ['--version'], { encoding: 'utf-8' });
  assert.equal(res.status, 0, `compact --version failed: ${res.stderr}`);
  assert.match(res.stdout, /\d+\.\d+\.\d+/);
});

test('contract compiles via `compact compile` and lists circuits', () => {
  const res = spawnSync('compact', ['compile', contractSource, managedDir], { encoding: 'utf-8' });
  assert.equal(res.status, 0, `compile failed:\n${res.stderr}`);
  const output = `${res.stdout}\n${res.stderr}`;
  assert.match(output, /Compiling 1 circuit/i, `expected circuits listed, got:\n${output}`);
});

test('compile output produces circuits, keys, and API in managed/', () => {
  const zkir = path.join(managedDir, 'zkir', 'checkEligibility.zkir');
  const bzkir = path.join(managedDir, 'zkir', 'checkEligibility.bzkir');
  const prover = path.join(managedDir, 'keys', 'checkEligibility.prover');
  const verifier = path.join(managedDir, 'keys', 'checkEligibility.verifier');
  const contractInfo = path.join(managedDir, 'compiler', 'contract-info.json');
  const contractJs = path.join(managedDir, 'contract', 'index.js');
  const contractDts = path.join(managedDir, 'contract', 'index.d.ts');

  for (const file of [zkir, bzkir, prover, verifier, contractInfo, contractJs, contractDts]) {
    assert.ok(fs.existsSync(file), `missing generated artifact: ${file}`);
  }

  for (const file of [prover, zkir]) {
    assert.ok(fs.statSync(file).size > 0, `generated artifact is empty: ${file}`);
  }
});

test('contract-info.json describes the PRIESTATE contract surface', () => {
  const info = JSON.parse(fs.readFileSync(path.join(managedDir, 'compiler', 'contract-info.json'), 'utf-8'));

  assert.ok(Array.isArray(info.circuits));
  assert.equal(info.circuits.length, 1);
  assert.equal(info.circuits[0].name, 'checkEligibility');
  assert.equal(info.circuits[0].pure, false);
  assert.ok(info.circuits[0].proof, 'checkEligibility should require a proof');

  const witnessNames = info.witnesses.map((w: { name: string }) => w.name);
  assert.ok(witnessNames.includes('propertyValue'), `expected propertyValue witness, got ${witnessNames}`);

  const ledgerNames = info.ledger.map((l: { name: string }) => l.name);
  assert.deepEqual(ledgerNames, ['eligibilityThreshold', 'eligibilityResult']);
});
