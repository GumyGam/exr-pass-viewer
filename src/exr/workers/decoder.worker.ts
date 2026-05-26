// EXR decoder Web Worker. One instance owns one tinyexr WASM module and a
// dictionary of currently-loaded files keyed by `fileKey`. The main thread
// talks to this worker via a small request/response protocol (see message
// types below); resolution is by `requestId`.
//
// Cached Float32Array decodes are kept per (fileKey, channelName) with a
// total-bytes cap (default 1 GiB), evicted LRU when the cap is exceeded.

import { loadExr, type ExrReader } from '../../wasm/tinyexr';
import { listPasses, type FileMetadata } from '../passes';
import { pickAtPixel, renderMask, type CryptoPickResult } from '../crypto';

interface LoadedFile {
  reader: ExrReader;
  metadata: FileMetadata;
}

// In-worker state.
const files = new Map<string, LoadedFile>();

// Channel decode cache: key = `${fileKey}::${channelName}`. We track total
// bytes and LRU-evict to stay below the cap.
interface CacheEntry {
  bytes: number;
  data: Float32Array;
}
const channelCache = new Map<string, CacheEntry>();
let cacheBytes = 0;
const CACHE_CAP_BYTES = 1024 * 1024 * 1024; // 1 GiB

function cacheGet(fileKey: string, channelName: string): Float32Array | null {
  const key = `${fileKey}::${channelName}`;
  const entry = channelCache.get(key);
  if (!entry) return null;
  // Refresh LRU: re-insert.
  channelCache.delete(key);
  channelCache.set(key, entry);
  return entry.data;
}

function cachePut(fileKey: string, channelName: string, data: Float32Array): void {
  const key = `${fileKey}::${channelName}`;
  const existing = channelCache.get(key);
  if (existing) {
    cacheBytes -= existing.bytes;
    channelCache.delete(key);
  }
  const bytes = data.byteLength;
  channelCache.set(key, { bytes, data });
  cacheBytes += bytes;
  // Evict oldest until under cap.
  while (cacheBytes > CACHE_CAP_BYTES && channelCache.size > 1) {
    const firstKey = channelCache.keys().next().value;
    if (firstKey === undefined) break;
    const evict = channelCache.get(firstKey);
    channelCache.delete(firstKey);
    if (evict) cacheBytes -= evict.bytes;
  }
}

function cacheDropFile(fileKey: string): void {
  const prefix = `${fileKey}::`;
  for (const key of [...channelCache.keys()]) {
    if (key.startsWith(prefix)) {
      const entry = channelCache.get(key);
      channelCache.delete(key);
      if (entry) cacheBytes -= entry.bytes;
    }
  }
}

/**
 * Wrap the raw reader with a caching layer so crypto.ts pickAtPixel /
 * renderMask transparently re-use any channels we've already decoded.
 */
function cachingReader(fileKey: string, base: ExrReader): ExrReader {
  return {
    getDimensions: () => base.getDimensions(),
    getChannels: () => base.getChannels(),
    getAttributes: () => base.getAttributes(),
    getChannelData: (channelName: string) => {
      const hit = cacheGet(fileKey, channelName);
      if (hit) return hit;
      const fresh = base.getChannelData(channelName);
      cachePut(fileKey, channelName, fresh);
      return fresh;
    },
    dispose: () => base.dispose(),
  };
}

// ------- Message protocol -------

type Req =
  | { type: 'load'; requestId: number; payload: { fileKey: string; buf: ArrayBuffer } }
  | { type: 'getChannel'; requestId: number; payload: { fileKey: string; channelName: string } }
  | { type: 'cryptoPick'; requestId: number; payload: { fileKey: string; activePassName: string; x: number; y: number } }
  | { type: 'cryptoMask'; requestId: number; payload: { fileKey: string; activePassName: string; hashesHex: string[] } }
  | { type: 'dispose'; requestId: number; payload: { fileKey: string } };

interface ErrResp {
  type: 'error';
  requestId: number;
  message: string;
}

interface OkResp<T> {
  type: 'ok';
  requestId: number;
  payload: T;
}

function reply<T>(requestId: number, payload: T, transfer?: Transferable[]): void {
  const msg: OkResp<T> = { type: 'ok', requestId, payload };
  if (transfer && transfer.length > 0) {
    (self as unknown as Worker).postMessage(msg, transfer);
  } else {
    (self as unknown as Worker).postMessage(msg);
  }
}

function replyError(requestId: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const msg: ErrResp = { type: 'error', requestId, message };
  (self as unknown as Worker).postMessage(msg);
}

function requireFile(fileKey: string): LoadedFile {
  const f = files.get(fileKey);
  if (!f) throw new Error(`unknown fileKey: ${fileKey}`);
  return f;
}

self.addEventListener('message', (ev: MessageEvent<Req>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'load': {
      void (async () => {
        try {
          const { fileKey, buf } = msg.payload;
          // Dispose any previous reader under this key before replacing it.
          const prior = files.get(fileKey);
          if (prior) {
            prior.reader.dispose();
            cacheDropFile(fileKey);
          }
          const reader = await loadExr(buf);
          const metadata = listPasses(reader);
          files.set(fileKey, { reader, metadata });
          reply(msg.requestId, metadata);
        } catch (err) {
          replyError(msg.requestId, err);
        }
      })();
      break;
    }
    case 'getChannel': {
      try {
        const { fileKey, channelName } = msg.payload;
        const f = requireFile(fileKey);
        const cached = cacheGet(fileKey, channelName);
        if (cached) {
          // Return a copy so the cache is not detached when transferred.
          const copy = new Float32Array(cached);
          reply(msg.requestId, copy, [copy.buffer]);
        } else {
          const data = f.reader.getChannelData(channelName);
          cachePut(fileKey, channelName, data);
          // Same: send a transferable copy, keep the cached original.
          const copy = new Float32Array(data);
          reply(msg.requestId, copy, [copy.buffer]);
        }
      } catch (err) {
        replyError(msg.requestId, err);
      }
      break;
    }
    case 'cryptoPick': {
      try {
        const { fileKey, activePassName, x, y } = msg.payload;
        const f = requireFile(fileKey);
        const result: CryptoPickResult = pickAtPixel(
          cachingReader(fileKey, f.reader),
          activePassName,
          x,
          y,
        );
        reply(msg.requestId, result);
      } catch (err) {
        replyError(msg.requestId, err);
      }
      break;
    }
    case 'cryptoMask': {
      try {
        const { fileKey, activePassName, hashesHex } = msg.payload;
        const f = requireFile(fileKey);
        const mask = renderMask(
          cachingReader(fileKey, f.reader),
          activePassName,
          hashesHex,
        );
        // Transfer the mask buffer so we avoid a copy on the wire.
        reply(msg.requestId, mask, [mask.buffer]);
      } catch (err) {
        replyError(msg.requestId, err);
      }
      break;
    }
    case 'dispose': {
      try {
        const { fileKey } = msg.payload;
        const f = files.get(fileKey);
        if (f) {
          f.reader.dispose();
          files.delete(fileKey);
        }
        cacheDropFile(fileKey);
        reply(msg.requestId, null);
      } catch (err) {
        replyError(msg.requestId, err);
      }
      break;
    }
  }
});

// Make the file a module (required for `?worker` import).
export {};
