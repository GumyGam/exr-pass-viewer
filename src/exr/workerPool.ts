// Main-thread pool of decoder Web Workers. Each worker owns its own tinyexr
// WASM module and its own loaded files; the pool assigns each `fileKey` to
// one worker sticky-by-key (first call's round-robin slot) so the WASM
// instance and decode cache stay hot for repeat reads of the same file.

import type { FileMetadata } from './passes';
import type { CryptoPickResult } from './crypto';

// `?worker` is Vite's syntax for ES-module workers: this import resolves to a
// constructor that returns a Worker pre-wired with the worker module.
import DecodeWorker from './workers/decoder.worker.ts?worker';

export interface DecodeWorkerPool {
  /** Load a file. Worker owns the file. Returns metadata. */
  loadFile(fileKey: string, buf: ArrayBuffer): Promise<FileMetadata>;
  /** Decode one channel's float32 data. */
  getChannelData(fileKey: string, channelName: string): Promise<Float32Array>;
  /** Cryptomatte pick. */
  cryptoPick(
    fileKey: string,
    activePassName: string,
    x: number,
    y: number,
  ): Promise<CryptoPickResult>;
  /** Cryptomatte mask. */
  cryptoMask(
    fileKey: string,
    activePassName: string,
    hashesHex: string[],
  ): Promise<Float32Array>;
  /** Release the file in the worker. */
  dispose(fileKey: string): void;
  /** Shut everything down. */
  terminate(): void;
}

interface PendingResolver {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface OkResp {
  type: 'ok';
  requestId: number;
  payload: unknown;
}
interface ErrResp {
  type: 'error';
  requestId: number;
  message: string;
}
type WorkerResp = OkResp | ErrResp;

interface WorkerSlot {
  worker: Worker;
  /** requestId -> resolver registered while a request is in flight. */
  pending: Map<number, PendingResolver>;
}

function createSlot(): WorkerSlot {
  const worker = new DecodeWorker();
  const slot: WorkerSlot = { worker, pending: new Map() };
  worker.addEventListener('message', (ev: MessageEvent<WorkerResp>) => {
    const msg = ev.data;
    const pending = slot.pending.get(msg.requestId);
    if (!pending) return; // late reply; ignore
    slot.pending.delete(msg.requestId);
    if (msg.type === 'ok') {
      pending.resolve(msg.payload);
    } else {
      pending.reject(new Error(msg.message));
    }
  });
  worker.addEventListener('error', (ev: ErrorEvent) => {
    // Fail any in-flight requests on hard worker error.
    const message = ev.message || 'worker error';
    for (const [, p] of slot.pending) p.reject(new Error(message));
    slot.pending.clear();
  });
  return slot;
}

function defaultPoolSize(): number {
  // Cap at 4 — EXR decode is memory-heavy and going wider rarely pays off.
  const hw =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(1, Math.min(4, hw));
}

export function createWorkerPool(size?: number): DecodeWorkerPool {
  const n = Math.max(1, size ?? defaultPoolSize());
  const slots: WorkerSlot[] = Array.from({ length: n }, () => createSlot());

  // Round-robin index for new fileKeys.
  let rrIndex = 0;
  // fileKey -> owning slot index (sticky after first assignment).
  const ownership = new Map<string, number>();

  let nextRequestId = 1;

  function ownerOf(fileKey: string): number {
    let idx = ownership.get(fileKey);
    if (idx === undefined) {
      idx = rrIndex % slots.length;
      rrIndex = (rrIndex + 1) % slots.length;
      ownership.set(fileKey, idx);
    }
    return idx;
  }

  function send<T>(
    slotIdx: number,
    type: string,
    payload: unknown,
    transfer?: Transferable[],
  ): Promise<T> {
    const slot = slots[slotIdx];
    const requestId = nextRequestId++;
    const message = { type, requestId, payload };
    return new Promise<T>((resolve, reject) => {
      slot.pending.set(requestId, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      if (transfer && transfer.length > 0) {
        slot.worker.postMessage(message, transfer);
      } else {
        slot.worker.postMessage(message);
      }
    });
  }

  return {
    loadFile(fileKey: string, buf: ArrayBuffer): Promise<FileMetadata> {
      const slotIdx = ownerOf(fileKey);
      // Transfer the ArrayBuffer to detach it from the main thread.
      return send<FileMetadata>(slotIdx, 'load', { fileKey, buf }, [buf]);
    },
    getChannelData(fileKey: string, channelName: string): Promise<Float32Array> {
      const slotIdx = ownerOf(fileKey);
      return send<Float32Array>(slotIdx, 'getChannel', { fileKey, channelName });
    },
    cryptoPick(
      fileKey: string,
      activePassName: string,
      x: number,
      y: number,
    ): Promise<CryptoPickResult> {
      const slotIdx = ownerOf(fileKey);
      return send<CryptoPickResult>(slotIdx, 'cryptoPick', {
        fileKey,
        activePassName,
        x,
        y,
      });
    },
    cryptoMask(
      fileKey: string,
      activePassName: string,
      hashesHex: string[],
    ): Promise<Float32Array> {
      const slotIdx = ownerOf(fileKey);
      return send<Float32Array>(slotIdx, 'cryptoMask', {
        fileKey,
        activePassName,
        hashesHex,
      });
    },
    dispose(fileKey: string): void {
      const slotIdx = ownership.get(fileKey);
      if (slotIdx === undefined) return;
      ownership.delete(fileKey);
      // Fire-and-forget; ignore failures during dispose.
      send(slotIdx, 'dispose', { fileKey }).catch(() => undefined);
    },
    terminate(): void {
      for (const slot of slots) {
        // Reject anything in flight so callers don't hang.
        for (const [, p] of slot.pending) {
          p.reject(new Error('worker pool terminated'));
        }
        slot.pending.clear();
        slot.worker.terminate();
      }
      slots.length = 0;
      ownership.clear();
    },
  };
}
