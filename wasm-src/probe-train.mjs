// Probe a specific EXR file via the tinyexr WASM. Pass path as argv.
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, '..', 'public');
const MODULE_URL = `file://${PUBLIC}/tinyexr.mjs`;

const path = process.argv[2];
if (!path) {
  console.error('usage: node probe-train.mjs <path-to-exr>');
  process.exit(1);
}

const bytes = await readFile(path);
console.log(`file: ${path}`);
console.log(`size: ${(bytes.length / 1e6).toFixed(1)} MB`);

const { default: createTinyExrModule } = await import(MODULE_URL);
const mod = await createTinyExrModule({
  locateFile: (p) => `${PUBLIC}/${p}`,
});

const instance = new mod.TinyExr();
const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const u8 = new Uint8Array(buf);

try {
  instance.loadFromBuffer(u8);
  const dims = instance.getDimensions();
  const channels = instance.getChannels();
  const attrs = instance.getAttributes();
  console.log(`dimensions: ${dims.width} × ${dims.height}`);
  console.log(`channel count: ${channels.length}`);
  console.log(`first 5 channels:`);
  for (const c of channels.slice(0, 5)) console.log(`  ${c.name} (pixelType=${c.pixelType})`);
  console.log(`custom attributes: ${attrs.length}`);
  const cryptoAttrs = attrs.filter((a) => a.name.startsWith('cryptomatte/'));
  console.log(`cryptomatte attrs: ${cryptoAttrs.length}`);
  for (const a of cryptoAttrs.slice(0, 4)) console.log(`  ${a.name}`);
  instance.free();
  instance.delete();
  console.log('OK');
} catch (e) {
  console.error('FAILED:');
  console.error(e);
  if (e && typeof e === 'object' && 'excPtr' in e && mod.getExceptionMessage) {
    try {
      const msg = mod.getExceptionMessage(e.excPtr);
      console.error('decoded:', msg);
    } catch (err) {
      console.error('could not decode exception:', err);
    }
  }
  process.exit(1);
}
