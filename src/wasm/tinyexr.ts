// TS loader for the tinyexr WASM module.
//
// The module is built into `public/tinyexr.mjs` + `public/tinyexr.wasm` by
// `wasm-src/build.sh`. Vite serves anything under `public/` at the configured
// base path (`/exr-pass-viewer/`), so at runtime we load from
// `${import.meta.env.BASE_URL}tinyexr.mjs`. The .mjs is an Emscripten-emitted
// ES module that knows how to fetch its sibling .wasm.

/** tinyexr pixel-type enum (mirrors TINYEXR_PIXELTYPE_*). */
export const PixelType = {
  UINT: 0,
  HALF: 1,
  FLOAT: 2,
} as const;

export type PixelTypeValue = (typeof PixelType)[keyof typeof PixelType];

export interface ExrDimensions {
  width: number;
  height: number;
}

export interface ExrChannel {
  /** Full hierarchical name, e.g. "ViewLayer.CryptoMaterial02.r". */
  name: string;
  /** tinyexr pixel type. After load we promote HALF -> FLOAT, so this is
   *  effectively UINT or FLOAT in practice. */
  pixelType: PixelTypeValue;
  /** 0 for single-part files. */
  partIndex: number;
}

export interface ExrAttribute {
  name: string;
  type: string;
  /** Raw attribute payload as the file stored it. JS parses it. */
  bytes: Uint8Array;
  partIndex: number;
}

export interface ExrReader {
  getDimensions(): ExrDimensions;
  getChannels(): ExrChannel[];
  getChannelData(channelName: string): Float32Array;
  getAttributes(): ExrAttribute[];
  dispose(): void;
}

// Minimal shape of the JS object Embind hands back. We re-wrap it so callers
// never see raw Embind handles.
interface EmbindTinyExrInstance {
  loadFromBuffer(uint8: Uint8Array): boolean;
  getDimensions(): ExrDimensions;
  getChannels(): ExrChannel[];
  getChannelData(channelName: string): Float32Array;
  getAttributes(): ExrAttribute[];
  free(): void;
  delete(): void;
}

interface TinyExrModule {
  TinyExr: new () => EmbindTinyExrInstance;
}

type TinyExrFactory = (overrides?: {
  locateFile?: (path: string, prefix: string) => string;
}) => Promise<TinyExrModule>;

let modulePromise: Promise<TinyExrModule> | null = null;

/**
 * Load and cache the tinyexr WASM module. Subsequent calls return the same
 * instance.
 */
async function getModule(): Promise<TinyExrModule> {
  if (modulePromise) return modulePromise;

  const baseUrl =
    typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
      ? import.meta.env.BASE_URL
      : '/';
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const moduleUrl = `${origin}${baseUrl}tinyexr.mjs`;

  // Vite v8 refuses dynamic imports of paths that resolve into public/,
  // even with /* @vite-ignore */. Workaround: fetch the JS as text, wrap
  // it in a Blob, and dynamic-import the blob: URL. Vite cannot statically
  // analyze a blob: URL constructed at runtime, so the import slips past
  // its plugin pipeline cleanly. The blob URL is revoked after use; the
  // module instance survives because it's already been imported.
  modulePromise = (async () => {
    const response = await fetch(moduleUrl);
    if (!response.ok) {
      throw new Error(`fetch ${moduleUrl} → HTTP ${response.status}`);
    }
    const source = await response.text();
    const blob = new Blob([source], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      const mod = (await import(/* @vite-ignore */ blobUrl)) as {
        default: TinyExrFactory;
      };
      const factory = mod.default;
      if (typeof factory !== 'function') {
        throw new Error('tinyexr.mjs: default export is not a factory');
      }
      return factory({
        // emscripten asks for tinyexr.wasm here; route it back to the
        // public/ URL so the WASM binary loads from its real location.
        locateFile: (path: string) => `${origin}${baseUrl}${path}`,
      });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  })();

  return modulePromise;
}

/**
 * Parse an in-memory EXR. Returns a reader object scoped to that file;
 * call `dispose()` when done to release the underlying C++ memory.
 */
export async function loadExr(buf: ArrayBuffer): Promise<ExrReader> {
  const mod = await getModule();
  const instance = new mod.TinyExr();
  try {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    instance.loadFromBuffer(bytes);
  } catch (err) {
    // Embind throws as `unknown`; normalize to Error.
    instance.delete();
    if (err instanceof Error) throw err;
    throw new Error(String(err));
  }

  let disposed = false;
  return {
    getDimensions: () => instance.getDimensions(),
    getChannels: () => instance.getChannels(),
    getChannelData: (channelName: string) => instance.getChannelData(channelName),
    getAttributes: () => instance.getAttributes(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        instance.free();
      } finally {
        instance.delete();
      }
    },
  };
}

/**
 * For Node-side smoke tests where there is no Vite base URL. Resolves the
 * module from an explicit filesystem-style URL passed by the caller.
 */
export async function loadExrFromExplicitModuleUrl(
  buf: ArrayBuffer,
  moduleImportUrl: string,
  wasmLocateFile: (path: string) => string,
): Promise<ExrReader> {
  const mod = (await import(/* @vite-ignore */ moduleImportUrl)) as {
    default: TinyExrFactory;
  };
  const tinyExrModule = await mod.default({ locateFile: wasmLocateFile });
  const instance = new tinyExrModule.TinyExr();
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  try {
    instance.loadFromBuffer(bytes);
  } catch (err) {
    instance.delete();
    if (err instanceof Error) throw err;
    throw new Error(String(err));
  }

  let disposed = false;
  return {
    getDimensions: () => instance.getDimensions(),
    getChannels: () => instance.getChannels(),
    getChannelData: (channelName: string) => instance.getChannelData(channelName),
    getAttributes: () => instance.getAttributes(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        instance.free();
      } finally {
        instance.delete();
      }
    },
  };
}
