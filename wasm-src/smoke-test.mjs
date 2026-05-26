// Smoke-test the tinyexr WASM module against a real multilayer + Cryptomatte
// EXR. Run with:
//   node wasm-src/smoke-test.mjs
//
// Loads the .mjs that build.sh dropped in public/, parses the test EXR, and
// prints the diagnostics the spike needs to call go/no-go.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const wasmMjsPath = resolve(repoRoot, 'public/tinyexr.mjs');
const exrPath = '/Users/agam/Downloads/passes testing/Scene-barn/exr render/frame_0001.exr';

console.log(`Loading WASM module from: ${wasmMjsPath}`);
console.log(`Loading EXR from:         ${exrPath}`);

const factoryUrl = pathToFileURL(wasmMjsPath).href;
const mod = await import(factoryUrl);
const tinyExrModule = await mod.default({
  // Point Emscripten at the sibling .wasm; default behavior in Node also works
  // but being explicit avoids relying on import.meta resolution edge cases.
  locateFile: (path) => resolve(repoRoot, 'public', path),
});

const exrBytes = readFileSync(exrPath);
console.log(`EXR file size: ${exrBytes.length} bytes`);

const reader = new tinyExrModule.TinyExr();
reader.loadFromBuffer(exrBytes);

const dims = reader.getDimensions();
console.log(`dimensions: ${dims.width} x ${dims.height}`);

const channels = reader.getChannels();
console.log(`total channels: ${channels.length}`);
console.log(`first 10 channel names:`);
for (const ch of channels.slice(0, 10)) {
  console.log(`  ${ch.name}  (pixelType=${ch.pixelType}, partIndex=${ch.partIndex})`);
}

const attrs = reader.getAttributes();
const cryptoAttrs = attrs.filter((a) => a.name.startsWith('cryptomatte/'));
console.log(`total custom attributes: ${attrs.length}`);
console.log(`cryptomatte/* attribute count: ${cryptoAttrs.length}`);
console.log(`cryptomatte/* attribute names:`);
for (const a of cryptoAttrs) {
  console.log(`  ${a.name}  (type=${a.type}, bytes=${a.bytes.length})`);
}

// Spot-check: pull one channel's data and verify length matches dims.
if (channels.length > 0) {
  const target =
    channels.find((c) => c.name.toLowerCase().endsWith('.r')) ?? channels[0];
  const data = reader.getChannelData(target.name);
  const expected = dims.width * dims.height;
  console.log(
    `channel "${target.name}": got ${data.length} floats (expected ${expected}); ` +
      `first 4 samples = [${Array.from(data.slice(0, 4))
        .map((v) => v.toFixed(4))
        .join(', ')}]`,
  );
  if (data.length !== expected) {
    console.error('FAIL: channel data length mismatch');
    reader.free();
    reader.delete();
    process.exit(1);
  }
}

reader.free();
reader.delete();
console.log('smoke-test: OK');
