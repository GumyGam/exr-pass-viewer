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

  // Use @vite-ignore so Vite does not try to resolve the URL at build time;
  // the .mjs lives in `public/` and is fetched at runtime by the browser.
  const moduleUrl = `${baseUrl}tinyexr.mjs`;

  modulePromise = (async () => {
    const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
      default: TinyExrFactory;
    };
    const factory = mod.default;
    return factory({
      locateFile: (path: string) => `${baseUrl}${path}`,
    });
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
