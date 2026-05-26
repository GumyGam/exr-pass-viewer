// Node smoke test for the EXR foundation layer.
//
// Runs the full passes / crypto pipeline against the real Scene-barn test
// frame, bypassing the worker (we'd need Web Worker setup that's not worth
// it for a CLI smoke). Run with:
//   node src/exr/__tests__/smoke.test.mjs
//
// Node 25+ strips TypeScript types natively, so we import .ts modules
// directly without a build step.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../..');

// Import the foundation layer + WASM loader from TS source. Node strips types.
const { loadExrFromExplicitModuleUrl } = await import(
  pathToFileURL(resolve(repoRoot, 'src/wasm/tinyexr.ts')).href
);
const { listPasses } = await import(
  pathToFileURL(resolve(repoRoot, 'src/exr/passes.ts')).href
);
const { pickAtPixel, renderMask } = await import(
  pathToFileURL(resolve(repoRoot, 'src/exr/crypto.ts')).href
);

const EXR_PATH =
  '/Users/agam/Downloads/passes testing/Scene-barn/exr render/frame_0001.exr';
const WASM_MJS = resolve(repoRoot, 'public/tinyexr.mjs');
const PUBLIC_DIR = resolve(repoRoot, 'public');

// --- assertion helpers ---
let failures = 0;
function assert(cond, label, detail) {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `  -- ${detail}` : ''}`);
  }
}

// --- step 1: load the file ---
console.log(`loading ${EXR_PATH}`);
const fileBytes = readFileSync(EXR_PATH);
console.log(`  file size: ${fileBytes.length} bytes`);

const factoryUrl = pathToFileURL(WASM_MJS).href;
const reader = await loadExrFromExplicitModuleUrl(
  fileBytes.buffer.slice(
    fileBytes.byteOffset,
    fileBytes.byteOffset + fileBytes.byteLength,
  ),
  factoryUrl,
  (path) => resolve(PUBLIC_DIR, path),
);

// --- step 2: listPasses ---
console.log('listPasses:');
const meta = listPasses(reader);
assert(meta.width === 1920, `width=1920 (got ${meta.width})`);
assert(meta.height === 1088, `height=1088 (got ${meta.height})`);
assert(meta.passes.length > 50, `pass count > 50 (got ${meta.passes.length})`);

// Show a small sample of what we discovered.
console.log(`  total passes: ${meta.passes.length}`);
const cryptoPasses = meta.passes.filter((p) =>
  p.display_name.toLowerCase().includes('crypto'),
);
console.log(`  crypto* passes: ${cryptoPasses.length}`);
for (const p of cryptoPasses.slice(0, 5)) {
  console.log(
    `    ${p.name}  display=${p.display_name}  family=${p.family}  viz=${p.viz_default}  components=[${p.components.join(',')}]`,
  );
}

// Every Crypto* pass must be classified as family=CRY + viz_default=crypto.
const allCryptoCorrect = cryptoPasses.every(
  (p) => p.family === 'CRY' && p.viz_default === 'crypto',
);
assert(
  allCryptoCorrect,
  `every Crypto* pass has family=CRY + viz_default=crypto`,
  `mismatches: ${cryptoPasses.filter((p) => p.family !== 'CRY' || p.viz_default !== 'crypto').map((p) => p.name).join(', ')}`,
);

// --- step 3: pickAtPixel on first CryptoMaterial sub-pass ---
console.log('pickAtPixel:');
const firstCryptoMaterial = meta.passes.find((p) =>
  p.display_name.toLowerCase().startsWith('cryptomaterial'),
);
if (!firstCryptoMaterial) {
  console.log('  FAIL  no CryptoMaterial pass found');
  failures++;
  process.exit(failures > 0 ? 1 : 0);
}
console.log(`  using active pass: ${firstCryptoMaterial.name}`);
// Spec asked for (600, 400), but in the Scene-barn frame_0001 that lands in
// the empty sky region. Probe the spec pixel first; if it's background,
// fall back to a center pixel that we know has subject coverage.
const PROBE_X = 600;
const PROBE_Y = 400;
let pickX = PROBE_X;
let pickY = PROBE_Y;
{
  const cm00g = reader.getChannelData(`${firstCryptoMaterial.name}.g`);
  const cm00a = reader.getChannelData(`${firstCryptoMaterial.name}.a`);
  const probeIdx = PROBE_Y * meta.width + PROBE_X;
  if (cm00g[probeIdx] <= 0 && cm00a[probeIdx] <= 0) {
    pickX = Math.floor(meta.width / 2);
    pickY = Math.floor(meta.height / 2);
    console.log(
      `  note: (${PROBE_X},${PROBE_Y}) is background sky; picking center (${pickX},${pickY}) instead`,
    );
  }
}
const pickResult = pickAtPixel(reader, firstCryptoMaterial.name, pickX, pickY);
console.log(`  type_name: ${pickResult.type_name}`);
console.log(`  candidates: ${pickResult.candidates.length}`);
for (const c of pickResult.candidates.slice(0, 5)) {
  console.log(
    `    hash=${c.hash_hex}  name=${c.name === null ? 'null' : JSON.stringify(c.name)}  coverage=${c.coverage.toFixed(4)}`,
  );
}
assert(
  pickResult.type_name.toLowerCase().includes('cryptomaterial'),
  `type_name contains 'CryptoMaterial' (got ${pickResult.type_name})`,
);
assert(pickResult.candidates.length > 0, `candidates.length > 0`);
const topCandidate = pickResult.candidates[0];
assert(
  topCandidate && topCandidate.name !== null,
  `top candidate has a resolved name (not null)`,
  topCandidate ? `name=${JSON.stringify(topCandidate.name)}` : 'no candidate',
);

// --- step 4: renderMask ---
console.log('renderMask:');
const mask = renderMask(reader, firstCryptoMaterial.name, [topCandidate.hash_hex]);
const expectedLen = meta.width * meta.height;
assert(
  mask.length === expectedLen,
  `mask length === width*height (${expectedLen}) -- got ${mask.length}`,
);
let minVal = Infinity;
let maxVal = -Infinity;
let nGtHalf = 0;
let nGtZero = 0;
for (let i = 0; i < mask.length; i++) {
  const v = mask[i];
  if (v < minVal) minVal = v;
  if (v > maxVal) maxVal = v;
  if (v > 0.5) nGtHalf++;
  if (v > 0) nGtZero++;
}
console.log(
  `  min=${minVal.toFixed(4)} max=${maxVal.toFixed(4)} >0=${nGtZero} >0.5=${nGtHalf}`,
);
assert(minVal >= 0 && maxVal <= 1, `values in [0, 1] (got [${minVal}, ${maxVal}])`);
assert(nGtHalf > 0, `at least one pixel > 0.5`);

// --- done ---
reader.dispose();
console.log('');
console.log(failures === 0 ? 'smoke test: OK' : `smoke test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
