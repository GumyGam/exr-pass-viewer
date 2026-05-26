// Pure-browser bridge that REPLACES the old HTTP `api/client.ts`.
//
// Component code calls into this module instead of fetch'ing the localhost
// backend. Under the hood it composes Agent A's worker pool (EXR decode +
// pass discovery + cryptomatte logic, all in worker threads) with Agent B's
// WebGL viz pipeline on the main thread.
//
// File identity. The store keys files by their synthetic path (e.g.
//   "passes-testing/Scene-barn/exr render/frame_0001.exr"). That same string
// is used as the file key for the worker pool. We register File handles
// against the path here so call sites can keep passing strings.

import type { CryptoPickResult } from '../exr/crypto';
import type { FileMetadata, PassInfo, VizMode } from '../exr/passes';
import { renderMask, renderPass } from '../exr/viz';
import { createWorkerPool } from '../exr/workerPool';

// Singleton pool. Agent A's createWorkerPool() owns the worker fleet.
const pool = createWorkerPool();

// path -> handle. Storing the FileSystemFileHandle (instead of a File snapshot
// captured during the directory walk) means we always read bytes against a
// fresh File. Browser File objects derived from FS Access handles can go stale
// or fail under memory pressure if held for a long time; getting a new one at
// load time avoids that.
const fileRegistry = new Map<string, FileSystemFileHandle>();

// path -> cached FileMetadata. The arrayBuffer read + worker transfer cost
// dominates each render, so we hold metadata once loaded.
const metaCache = new Map<string, FileMetadata>();

// path -> in-flight load promise. Coalesces concurrent loadFromPath() calls
// from multiple panels so we never read+transfer the same file twice.
const loadInFlight = new Map<string, Promise<FileMetadata>>();

/** Register a path -> FileSystemFileHandle mapping. Call this when the folder
 *  walker resolves a FileTreeNode. Re-registration with the same handle is a
 *  no-op; with a different handle it evicts caches. */
export function registerFile(path: string, handle: FileSystemFileHandle): void {
  const prior = fileRegistry.get(path);
  if (prior !== handle) {
    metaCache.delete(path);
    pool.dispose(path);
  }
  fileRegistry.set(path, handle);
}

/** Drop a previously-registered file from the in-memory caches. */
export function unregisterFile(path: string): void {
  fileRegistry.delete(path);
  metaCache.delete(path);
  pool.dispose(path);
}

/** Evict a file's loaded state (WASM reader + decoded channel cache + metadata
 *  cache) without forgetting its handle. Use when a file is deselected: the
 *  user can re-select to reload, but in the meantime we release the worker's
 *  ~300 MB WASM heap and decoded channel arrays so memory doesn't pile up.
 *
 *  Critically: drop `loadInFlight[path]` too. Otherwise a deselect-during-load
 *  followed by re-select returns the stale in-flight promise whose worker-side
 *  state has already been disposed, and the next channel fetch errors out
 *  with "unknown fileKey". */
export function evictFile(path: string): void {
  metaCache.delete(path);
  loadInFlight.delete(path);
  pool.dispose(path);
}

function requireHandle(path: string): FileSystemFileHandle {
  const h = fileRegistry.get(path);
  if (!h) {
    throw new Error(`local.ts: no file handle registered for path "${path}"`);
  }
  return h;
}

async function loadFromPath(path: string): Promise<FileMetadata> {
  const cached = metaCache.get(path);
  if (cached) return cached;
  const inFlight = loadInFlight.get(path);
  if (inFlight) return inFlight;
  const handle = requireHandle(path);
  // Capture the in-flight slot up front. If evictFile fires while we're in
  // flight, `loadInFlight.get(path)` will no longer match this promise — the
  // resolve path checks that and reports a stale result instead of polluting
  // metaCache for a file the user no longer wants.
  let myPromise!: Promise<FileMetadata>;
  const p = (async () => {
    const file = await handle.getFile();
    const buf = await file.arrayBuffer();
    const meta = await pool.loadFile(path, buf);
    if (loadInFlight.get(path) !== myPromise) {
      // We were evicted mid-flight. The worker just installed a now-orphan
      // reader; tell it to drop it again.
      pool.dispose(path);
      throw new Error(`load stale: ${path}`);
    }
    metaCache.set(path, meta);
    return meta;
  })();
  myPromise = p;
  loadInFlight.set(path, p);
  try {
    return await p;
  } finally {
    if (loadInFlight.get(path) === p) loadInFlight.delete(path);
  }
}

/** Get the (cached) header metadata for a file. */
export function getPassMetadata(path: string): Promise<FileMetadata> {
  return loadFromPath(path);
}

export interface RenderOpts {
  viz?: VizMode;
  exposure?: number;
  gamma?: number;
  maxWidth?: number;
}

/** Fan-out the per-component channel fetches for a pass. Returns a Map
 *  (keyed by full channel name) for callers that need to look up by component,
 *  and the parallel Float32Array[] in pass.components order for the viz layer
 *  (which consumes a positional array). */
async function getPassChannels(
  path: string,
  pass: PassInfo,
): Promise<{ map: Map<string, Float32Array>; array: Float32Array[] }> {
  const arrs = await Promise.all(
    pass.components.map((c) => pool.getChannelData(path, `${pass.name}.${c}`)),
  );
  const map = new Map<string, Float32Array>();
  for (let i = 0; i < pass.components.length; i++) {
    map.set(`${pass.name}.${pass.components[i]!}`, arrs[i]!);
  }
  return { map, array: arrs };
}

/** Render a pass to an ImageBitmap. PanelTile drops the bitmap into a <canvas>
 *  via bitmaprenderer (zero-copy) or 2d.drawImage (copy fallback). */
export async function renderPassToCanvas(
  path: string,
  pass: PassInfo,
  opts: RenderOpts,
): Promise<ImageBitmap> {
  const meta = await loadFromPath(path);
  const { array } = await getPassChannels(path, pass);
  const canvas = renderPass(
    {
      width: meta.width,
      height: meta.height,
      channelData: array,
      pass,
    },
    {
      viz: opts.viz ?? pass.viz_default,
      exposure: opts.exposure ?? 0,
      gamma: opts.gamma ?? 2.2,
      maxWidth: opts.maxWidth,
      // Stable cacheKey so percentile-based viz modes (falsecolor / normalize /
      // position / vector) don't recompute percentiles on every render.
      cacheKey: `${path}::${pass.name}`,
    },
  );
  return canvas.transferToImageBitmap();
}

/** Resolve a Cryptomatte pick at (x, y) into hash candidates. */
export async function pickAtPixel(
  path: string,
  pass: PassInfo,
  x: number,
  y: number,
): Promise<CryptoPickResult> {
  await loadFromPath(path);
  return pool.cryptoPick(path, pass.name, x, y);
}

/** Composite a Cryptomatte mask for the given set of hashes. */
export async function renderCryptoMask(
  path: string,
  pass: PassInfo,
  hashesHex: string[],
  opts: { maxWidth?: number },
): Promise<ImageBitmap> {
  const meta = await loadFromPath(path);
  const mask = await pool.cryptoMask(path, pass.name, hashesHex);
  const canvas = renderMask(meta.width, meta.height, mask, opts);
  return canvas.transferToImageBitmap();
}

/** Sample raw float values across every channel of a pass at one pixel. Used
 *  by the hover chip overlay. Returns `<pass.name>.<component>` -> value to
 *  match the key shape the old `/api/pixel` endpoint produced. */
export async function pixelValues(
  path: string,
  pass: PassInfo,
  x: number,
  y: number,
): Promise<Record<string, number>> {
  const meta = await loadFromPath(path);
  if (x < 0 || y < 0 || x >= meta.width || y >= meta.height) return {};
  const { map } = await getPassChannels(path, pass);
  const out: Record<string, number> = {};
  const idx = y * meta.width + x;
  for (const c of pass.components) {
    const key = `${pass.name}.${c}`;
    const arr = map.get(key);
    if (!arr) continue;
    out[key] = arr[idx] ?? 0;
  }
  return out;
}

/** Drop every entry in the in-memory registries. Useful when the user picks a
 *  new root folder and the previous tree is no longer reachable. */
export function resetRegistry(): void {
  for (const path of fileRegistry.keys()) {
    pool.dispose(path);
  }
  fileRegistry.clear();
  metaCache.clear();
  loadInFlight.clear();
}
