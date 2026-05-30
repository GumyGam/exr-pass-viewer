// Node smoke test for the composite-over-beauty layer (AO / depth / normal).
//
// Covers the pure CPU logic only — pass-kind detection, beauty-base
// resolution, and that the three composite fragment-shader builders emit the
// expected sampler counts + uniform declarations. No WebGL (Node has no GL
// stack worth fighting). Run with:
//   node src/exr/__tests__/composite-smoke.test.mjs
//
// Node 25+ strips TypeScript types natively, so we import .ts modules directly.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const { compositeKindFor, resolveBeautyBase } = await import(
  pathToFileURL(resolve(repoRoot, 'src/exr/passes.ts')).href
);
const { compositeAoFrag, compositeDepthFrag, compositeNormalFrag, compositeRelightPointFrag } =
  await import(pathToFileURL(resolve(repoRoot, 'src/webgl/shaders.ts')).href);

let failures = 0;
function assert(cond, label, detail) {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `  -- ${detail}` : ''}`);
  }
}

// --- pass-kind detection ---
console.log('compositeKindFor:');
assert(compositeKindFor({ display_name: 'AO', family: 'SCALAR' }) === 'ao', 'AO -> ao');
assert(
  compositeKindFor({ display_name: 'ambient occlusion', family: 'SCALAR' }) === 'ao',
  'ambient occlusion -> ao',
);
assert(compositeKindFor({ display_name: 'AO_pass', family: 'SCALAR' }) === 'ao', 'AO_pass -> ao');
assert(compositeKindFor({ display_name: 'Depth', family: 'SCALAR' }) === 'depth', 'Depth -> depth');
assert(compositeKindFor({ display_name: 'mist', family: 'SCALAR' }) === 'depth', 'mist -> depth');
assert(
  compositeKindFor({ display_name: 'Normal', family: 'NRM' }) === 'normal',
  'Normal/NRM -> normal',
);
assert(
  compositeKindFor({ display_name: 'shadow', family: 'SCALAR' }) === null,
  'shadow -> null (no false AO match)',
);
assert(
  compositeKindFor({ display_name: 'Beauty', family: 'HDR' }) === null,
  'Beauty/HDR -> null',
);

// --- beauty-base resolution ---
console.log('resolveBeautyBase:');
const hdr = (n) => ({ display_name: n, family: 'HDR' });
const scalar = (n) => ({ display_name: n, family: 'SCALAR' });
assert(
  resolveBeautyBase([hdr('Combined'), hdr('Beauty'), scalar('AO')]) === 'Combined',
  'prefers Combined',
);
assert(
  resolveBeautyBase([hdr('Beauty'), hdr('Beauty_Noisy')]) === 'Beauty',
  'prefers Beauty over Beauty_Noisy',
);
assert(
  resolveBeautyBase([hdr('Beauty_Noisy')]) === 'Beauty_Noisy',
  'falls back to only (noisy) HDR',
);
assert(resolveBeautyBase([scalar('AO'), scalar('Depth')]) === null, 'no HDR -> null');

// --- shader generation: sampler counts + uniforms ---
console.log('shader builders:');
const ao = compositeAoFrag();
assert(ao.includes('uniform sampler2D uCh3;'), 'AO frag declares uCh3 (beauty + ao = 4)');
assert(!ao.includes('uCh4'), 'AO frag has no uCh4');
assert(ao.includes('toneBeauty(') && ao.includes('uStrength') && ao.includes('uInvert'), 'AO frag uniforms');

const depth = compositeDepthFrag();
assert(depth.includes('uniform sampler2D uCh3;'), 'depth frag declares uCh3');
assert(
  depth.includes('uRange') && depth.includes('uFocus') && depth.includes('uWidth') && depth.includes('uDim'),
  'depth frag uniforms',
);

const nrm = compositeNormalFrag();
assert(nrm.includes('uniform sampler2D uCh5;'), 'normal frag declares uCh5 (beauty + normal = 6)');
assert(
  nrm.includes('uLightDir') && nrm.includes('uAmbient') && nrm.includes('uMode'),
  'normal frag uniforms',
);

const pt = compositeRelightPointFrag();
assert(
  pt.includes('uniform sampler2D uCh8;'),
  'point frag declares uCh8 (beauty + normal + aux = 9)',
);
assert(!pt.includes('uCh9'), 'point frag has no uCh9');
assert(
  pt.includes('uLightPos') &&
    pt.includes('uRange') &&
    pt.includes('uIntensity') &&
    pt.includes('uReconstruct') &&
    pt.includes('uTanHalfFov'),
  'point frag uniforms',
);

console.log(failures === 0 ? '\ncomposite-smoke: PASS' : `\ncomposite-smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
