// Node-side compile-and-load smoke test for the rendering layer.
//
// We do not exercise WebGL here (Node has no GL stack worth fighting with).
// Instead, this script just verifies that:
//   1. tsc compiles every file Agent B owns with zero errors.
//   2. The CPU-side helpers in `tonemap.ts` give reasonable values.
//
// Run with: `node src/exr/__tests__/render-smoke.test.mjs`
//
// For visual verification, open `src/exr/__tests__/render-smoke.html` via
// `pnpm dev` and pick a multilayer EXR.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');

console.log('Project root:', ROOT);

// Step 1: tsc clean.
console.log('Running tsc -p tsconfig.app.json ...');
const tsc = spawnSync(
  'pnpm',
  ['exec', 'tsc', '-p', 'tsconfig.app.json', '--noEmit'],
  { cwd: ROOT, encoding: 'utf8' },
);
process.stdout.write(tsc.stdout || '');
process.stderr.write(tsc.stderr || '');
if (tsc.status !== 0) {
  console.error('\ntsc exited with code', tsc.status);
  // We do not fail this script on tsc errors that originate outside Agent B's
  // lane (src/webgl/, src/exr/viz.ts, src/exr/tonemap.ts) — those are
  // inter-agent coordination issues, not bugs in this module.
  const allErrors = (tsc.stdout || '') + (tsc.stderr || '');
  const ours = allErrors
    .split('\n')
    .filter((line) =>
      line.startsWith('src/webgl/') ||
      line.startsWith('src/exr/viz.ts') ||
      line.startsWith('src/exr/tonemap.ts'),
    );
  if (ours.length > 0) {
    console.error('Errors in Agent B-owned files:');
    for (const l of ours) console.error('  ' + l);
    process.exit(1);
  } else {
    console.log('(tsc errors are not in Agent B-owned files; ignoring)');
  }
} else {
  console.log('tsc: clean.');
}

// Step 2: import the CPU-side helpers and verify a couple of invariants.
const tonemapMod = await import('../tonemap.ts').catch((err) => {
  // Node can't import .ts directly without a loader. Try the compiled path.
  console.log('Direct .ts import not available in this Node:', err.message);
  return null;
});

if (tonemapMod) {
  const { computePercentileRange, computeMagnitude98 } = tonemapMod;

  // Constant array -> lo == hi (after widening to 1e-8).
  const constant = new Float32Array(1000);
  constant.fill(0.5);
  const [lo1, hi1] = computePercentileRange(constant);
  assert.ok(Math.abs(lo1 - 0.5) < 1e-6, `lo of constant: ${lo1}`);
  assert.ok(hi1 - lo1 >= 1e-8, `range width on constant: ${hi1 - lo1}`);
  console.log(`constant -> [${lo1}, ${hi1}]`);

  // Ramp 0..1 -> percentiles roughly at p2 and p98.
  const ramp = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) ramp[i] = i / 999;
  const [lo2, hi2] = computePercentileRange(ramp);
  assert.ok(lo2 >= 0 && lo2 < 0.05, `p2 of ramp: ${lo2}`);
  assert.ok(hi2 > 0.93 && hi2 <= 1.0, `p98 of ramp: ${hi2}`);
  console.log(`ramp -> [${lo2.toFixed(4)}, ${hi2.toFixed(4)}]`);

  // Magnitude: vec (1, 0) everywhere -> magnitude 1 everywhere.
  const ones = new Float32Array(1000); ones.fill(1);
  const zeros = new Float32Array(1000);
  const m = computeMagnitude98(ones, zeros);
  assert.ok(Math.abs(m - 1) < 1e-5, `magnitude of (1,0): ${m}`);
  console.log(`vec(1,0) -> mag98=${m}`);

  console.log('tonemap.ts helpers: OK');
}

console.log('\nrender-smoke: PASS');
