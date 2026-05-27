// Cryptomatte support: parse manifests, pick at a pixel, render binary masks.
// Ports backend/app/exr/crypto.py to TS.
//
// Cryptomatte spec: https://github.com/Psyop/Cryptomatte. Each "type" (e.g.
// CryptoMaterial, CryptoObject) writes 5 sub-passes (Type00..Type04) of 4
// channels each, carrying up to 10 ranked (id, coverage) pairs per pixel.
// The id is a uint32 MurmurHash3 of the object name, reinterpreted as
// float32 with a small NaN/Inf-avoiding bit flip. The manifest is a JSON
// dict stored in EXR header attributes mapping object_name -> hex(uint32).

import type { ExrAttribute, ExrReader } from '../wasm/tinyexr';

export interface CryptoCandidate {
  /** 8-char lowercase hex with no 0x prefix, e.g. "542cafa1". */
  hash_hex: string;
  /** Resolved from manifest. null if the id is not in the manifest. */
  name: string | null;
  /** Aggregated coverage across all sub-passes for this id. Clamped to [0,1]. */
  coverage: number;
}

export interface CryptoPickResult {
  /** E.g. "ViewLayer.CryptoMaterial" (no two-digit sub-pass suffix). */
  type_name: string;
  x: number;
  y: number;
  /** Sorted by coverage descending. */
  candidates: CryptoCandidate[];
}

interface CryptoType {
  /** E.g. "ViewLayer.CryptoMaterial". */
  type_name: string;
  /** Adjusted uint32 id -> object name. */
  manifest: Map<number, string>;
  /** Existing sub-pass names like "ViewLayer.CryptoMaterial00". Sorted. */
  sub_passes: string[];
}

/** Strip "<base>NN" -> "<base>" if NN is exactly two digits, else null. */
function stripSubPassSuffix(passName: string): string | null {
  if (passName.length < 3) return null;
  const tail = passName.slice(-2);
  if (!/^\d{2}$/.test(tail)) return null;
  return passName.slice(0, -2);
}

/** Flip bit 23 when the float32 exponent is 0 or 255 (NaN/Inf-avoiding). */
function adjustUint32ForFloat(u: number): number {
  const exp = (u >>> 23) & 0xff;
  let out = u >>> 0;
  if (exp === 0 || exp === 255) {
    out = (out ^ (1 << 23)) >>> 0;
  }
  return out >>> 0;
}

/** Lowercase 8-char hex with no 0x prefix. */
function uint32ToHex(u: number): string {
  return (u >>> 0).toString(16).padStart(8, '0');
}

// One Uint8Array -> UTF-8 string. EXR string attribute payloads are the raw
// bytes (tinyexr already consumed the per-attribute size header when it
// filled the bytes buffer), so no internal length prefix to strip.
const TEXT_DECODER = new TextDecoder('utf-8');
function bytesToString(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

/** Walk attributes and return one CryptoType per declared crypto id. */
function parseManifests(reader: ExrReader): CryptoType[] {
  const attrs: ExrAttribute[] = reader.getAttributes();

  // Pair up `cryptomatte/<id>/<key>` attributes by `<id>`. Key set per id
  // typically includes `name`, `hash`, `conversion`, `manifest`.
  const byId = new Map<string, Map<string, string>>();
  for (const attr of attrs) {
    if (!attr.name.startsWith('cryptomatte/')) continue;
    const parts = attr.name.split('/');
    if (parts.length < 3) continue;
    const typeId = parts[1];
    // Re-join in case the key itself contained a slash (defensive).
    const key = parts.slice(2).join('/');
    let bucket = byId.get(typeId);
    if (!bucket) {
      bucket = new Map<string, string>();
      byId.set(typeId, bucket);
    }
    bucket.set(key, bytesToString(attr.bytes));
  }

  if (byId.size === 0) return [];

  // Pre-compute the set of pass-prefix candidates from channel names so we
  // can detect which "<type_name>NN" sub-passes actually exist.
  const channels = reader.getChannels();
  const passPrefixes = new Set<string>();
  for (const ch of channels) {
    const dot = ch.name.lastIndexOf('.');
    if (dot < 0) continue;
    passPrefixes.add(ch.name.slice(0, dot));
  }

  const types: CryptoType[] = [];
  for (const [, kv] of byId) {
    const typeName = kv.get('name');
    const manifestJson = kv.get('manifest');
    if (!typeName || !manifestJson) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(manifestJson);
    } catch {
      // Skip silently — matches Python's `log.warning(...); continue`.
      continue;
    }
    if (typeof raw !== 'object' || raw === null) continue;

    const manifest = new Map<number, string>();
    for (const [objName, hexHash] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof hexHash !== 'string') continue;
      const u = parseInt(hexHash, 16);
      if (!Number.isFinite(u)) continue;
      manifest.set(adjustUint32ForFloat(u >>> 0), objName);
    }

    // Find which sub-passes exist as channels. We look for pass-name prefixes
    // that match "<typeName>NN" exactly (NN = two digits).
    const subPasses: string[] = [];
    const seen = new Set<string>();
    for (const passPart of passPrefixes) {
      if (!passPart.startsWith(typeName)) continue;
      const tail = passPart.slice(typeName.length);
      if (tail.length === 2 && /^\d{2}$/.test(tail) && !seen.has(passPart)) {
        subPasses.push(passPart);
        seen.add(passPart);
      }
    }
    subPasses.sort();
    types.push({ type_name: typeName, manifest, sub_passes: subPasses });
  }
  return types;
}

/** Find the CryptoType that owns the given active sub-pass name. */
function typeForPass(reader: ExrReader, activePassName: string): CryptoType {
  const typeName = stripSubPassSuffix(activePassName);
  if (!typeName) {
    throw new Error(`${activePassName} is not a Crypto sub-pass name`);
  }
  const types = parseManifests(reader);
  for (const t of types) {
    if (t.type_name === typeName) return t;
  }
  throw new Error(`no Cryptomatte type ${typeName} in file`);
}

/** True if the active pass is a real Cryptomatte sub-pass (name ends in two
 *  digits AND a matching `cryptomatte/<id>/manifest` lives on the file). When
 *  false, callers should use the RGB color-match fallback (pickColorAtPixel /
 *  renderColorMask) — that's what AE's Cryptomatte plugin does for ObjectID
 *  passes whose data is pre-baked RGB-per-object rather than hashed ids. */
export function isCryptomatteSubPass(reader: ExrReader, activePassName: string): boolean {
  const typeName = stripSubPassSuffix(activePassName);
  if (!typeName) return false;
  const types = parseManifests(reader);
  return types.some((t) => t.type_name === typeName);
}

// ---------------------------------------------------------------------------
// RGB color-match fallback for non-Cryptomatte ID passes.
// ---------------------------------------------------------------------------
//
// Many renderers emit an "ObjectID" or "MaterialID" pass that's just a
// pre-baked RGB color per object — no Cryptomatte manifest, no ranked sub-
// passes. AE's Cryptomatte plugin picks on these by exact float-tuple match
// at the clicked pixel; we do the same.
//
// The pick is keyed by an 8-bit-quantized RGB hex string ("ff80c0") so it
// fits the existing CryptoCandidate.hash_hex slot. Mask render compares the
// 8-bit-quantized tuple per pixel against the selected set.

function find3Channels(
  reader: ExrReader,
  passName: string,
): { r: Float32Array; g: Float32Array; b: Float32Array } {
  const channelNames = reader.getChannels().map((c) => c.name);
  const findOne = (comp: string): string => {
    const upper = `${passName}.${comp.toUpperCase()}`;
    if (channelNames.includes(upper)) return upper;
    const lower = `${passName}.${comp.toLowerCase()}`;
    if (channelNames.includes(lower)) return lower;
    throw new Error(`channel ${upper} (or .${comp.toLowerCase()}) not found`);
  };
  return {
    r: reader.getChannelData(findOne('R')),
    g: reader.getChannelData(findOne('G')),
    b: reader.getChannelData(findOne('B')),
  };
}

function rgbToHex8(r: number, g: number, b: number): string {
  const q = (v: number) => {
    const c = Math.max(0, Math.min(1, v));
    return Math.round(c * 255);
  };
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `${hex(q(r))}${hex(q(g))}${hex(q(b))}`;
}

function parseHex8(hex: string): { r: number; g: number; b: number } | null {
  if (hex.length !== 6) return null;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return { r, g, b };
}

/** RGB color-match pick. Reads R/G/B at (x, y), 8-bit-quantizes, returns
 *  a single candidate keyed by the hex tuple. */
export function pickColorAtPixel(
  reader: ExrReader,
  activePassName: string,
  x: number,
  y: number,
): CryptoPickResult {
  const { width, height } = reader.getDimensions();
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error(`(${x},${y}) out of bounds`);
  }
  const { r, g, b } = find3Channels(reader, activePassName);
  const idx = y * width + x;
  const hex = rgbToHex8(r[idx], g[idx], b[idx]);
  return {
    type_name: activePassName,
    x,
    y,
    candidates: [{ hash_hex: hex, name: null, coverage: 1.0 }],
  };
}

/** RGB color-match mask. Pixel is 1 iff its 8-bit-quantized RGB matches any
 *  selected hex tuple. */
export function renderColorMask(
  reader: ExrReader,
  activePassName: string,
  hashesHex: string[],
): Float32Array {
  const { width, height } = reader.getDimensions();
  const total = width * height;

  const selected = new Set<number>();
  for (const h of hashesHex) {
    const parsed = parseHex8(h);
    if (!parsed) continue;
    // Pack r/g/b into a single 24-bit int for cheap Set lookup.
    selected.add((parsed.r << 16) | (parsed.g << 8) | parsed.b);
  }

  const mask = new Float32Array(total);
  if (selected.size === 0) return mask;

  const { r, g, b } = find3Channels(reader, activePassName);
  if (r.length !== total) {
    throw new Error(`color-mask: channel length ${r.length} != ${total}`);
  }

  for (let i = 0; i < total; i++) {
    const rq = Math.max(0, Math.min(255, Math.round(r[i] * 255)));
    const gq = Math.max(0, Math.min(255, Math.round(g[i] * 255)));
    const bq = Math.max(0, Math.min(255, Math.round(b[i] * 255)));
    const key = (rq << 16) | (gq << 8) | bq;
    if (selected.has(key)) mask[i] = 1.0;
  }
  return mask;
}

/** Resolve the float32 channel data for a sub-pass, returning aligned
 *  per-component arrays. Each sub-pass has channels suffixed .R .G .B .A
 *  (or lowercase). Throws if any expected channel is missing. */
function loadRGBAChannels(
  reader: ExrReader,
  passName: string,
): { r: Float32Array; g: Float32Array; b: Float32Array; a: Float32Array } {
  const channelNames = reader.getChannels().map((c) => c.name);
  // Cryptomatte sub-passes commonly use lowercase r/g/b/a but some writers
  // use uppercase. Try uppercase first, then lowercase per component.
  function find(comp: string): string {
    const upper = `${passName}.${comp.toUpperCase()}`;
    if (channelNames.includes(upper)) return upper;
    const lower = `${passName}.${comp.toLowerCase()}`;
    if (channelNames.includes(lower)) return lower;
    throw new Error(`channel ${upper} (or .${comp.toLowerCase()}) not found`);
  }
  const r = reader.getChannelData(find('R'));
  const g = reader.getChannelData(find('G'));
  const b = reader.getChannelData(find('B'));
  const a = reader.getChannelData(find('A'));
  return { r, g, b, a };
}

/**
 * Return ranked (id, name, coverage) candidates at (x, y) for the active
 * type. Reads all rank pairs across every existing Type00..N sub-pass and
 * aggregates coverage per unique id.
 */
export function pickAtPixel(
  reader: ExrReader,
  activePassName: string,
  x: number,
  y: number,
): CryptoPickResult {
  const ct = typeForPass(reader, activePassName);
  const { width, height } = reader.getDimensions();
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error(`(${x},${y}) out of bounds`);
  }

  const scratch = new Float32Array(1);
  const scratchU = new Uint32Array(scratch.buffer);

  // id -> accumulated coverage. We key by adjusted uint32 (matches manifest).
  const candidates = new Map<number, number>();
  for (const sp of ct.sub_passes) {
    const { r, g, b, a } = loadRGBAChannels(reader, sp);
    const idx = y * width + x;
    const id1Float = r[idx];
    const cov1 = g[idx];
    const id2Float = b[idx];
    const cov2 = a[idx];
    if (cov1 > 0) {
      scratch[0] = id1Float;
      const key = scratchU[0] >>> 0;
      candidates.set(key, (candidates.get(key) ?? 0) + cov1);
    }
    if (cov2 > 0) {
      scratch[0] = id2Float;
      const key = scratchU[0] >>> 0;
      candidates.set(key, (candidates.get(key) ?? 0) + cov2);
    }
  }

  const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
  const out: CryptoCandidate[] = ranked.map(([key, cov]) => ({
    hash_hex: uint32ToHex(key),
    name: ct.manifest.get(key) ?? null,
    coverage: Math.min(1.0, cov),
  }));

  return {
    type_name: ct.type_name,
    x,
    y,
    candidates: out,
  };
}

/**
 * Render a B&W float32 mask in [0, 1] for the given selected hashes. For
 * each pixel, mask = clamp01(sum over all rank pairs of coverage where the
 * pair's id matches any selected hash).
 */
export function renderMask(
  reader: ExrReader,
  activePassName: string,
  hashesHex: string[],
): Float32Array {
  const ct = typeForPass(reader, activePassName);
  const { width, height } = reader.getDimensions();
  const total = width * height;

  // Build set of adjusted uint32 keys to match against pixel id slots.
  const selected = new Set<number>();
  for (const h of hashesHex) {
    const u = parseInt(h, 16);
    if (!Number.isFinite(u)) continue;
    selected.add(adjustUint32ForFloat(u >>> 0));
  }

  const mask = new Float32Array(total);
  if (selected.size === 0 || ct.sub_passes.length === 0) {
    return mask;
  }

  for (const sp of ct.sub_passes) {
    const { r, g, b, a } = loadRGBAChannels(reader, sp);
    if (r.length !== total) {
      throw new Error(`sub-pass ${sp} channel length ${r.length} != ${total}`);
    }
    // Reinterpret r and b (the id slots) as uint32 by aliasing the underlying
    // ArrayBuffer. Falls back to per-pixel copy if alignment is bad (unusual).
    let idR: Uint32Array | null = null;
    let idB: Uint32Array | null = null;
    if (r.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
      idR = new Uint32Array(r.buffer, r.byteOffset, r.length);
      idB = new Uint32Array(b.buffer, b.byteOffset, b.length);
    }
    if (idR && idB) {
      for (let i = 0; i < total; i++) {
        if (selected.has(idR[i])) mask[i] += g[i];
        if (selected.has(idB[i])) mask[i] += a[i];
      }
    } else {
      const scratch = new Float32Array(1);
      const scratchU = new Uint32Array(scratch.buffer);
      for (let i = 0; i < total; i++) {
        scratch[0] = r[i];
        if (selected.has(scratchU[0] >>> 0)) mask[i] += g[i];
        scratch[0] = b[i];
        if (selected.has(scratchU[0] >>> 0)) mask[i] += a[i];
      }
    }
  }

  // Clamp to [0, 1].
  for (let i = 0; i < total; i++) {
    if (mask[i] > 1.0) mask[i] = 1.0;
    else if (mask[i] < 0.0) mask[i] = 0.0;
  }
  return mask;
}
