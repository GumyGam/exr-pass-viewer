// Zustand chosen over Jotai: viewer state is a single coherent slice
// (selections, active pass, transforms) with mostly bulk reads — no need
// for Jotai's per-atom subscription model. Zustand keeps the store shape
// flat and the actions colocated.
//
// In the pure-browser build, files live behind the FS Access API. The
// `rootHandle` field holds the user's picked directory; component code
// calls `pickFolder()` from `../fs/walker` and then writes the result here.
// All file references are by synthetic display path (e.g.
// "passes-testing/Scene-barn/exr render/frame_0001.exr"), produced by the
// walker. Those same paths are the worker pool's file keys; see
// `src/api/local.ts` for the bridge.
import { useMemo } from 'react';
import { create } from 'zustand';
import type { CryptoCandidate } from '../exr/crypto';
import type { FileMetadata, PassInfo } from '../exr/passes';

export type CompareMode = 'grid' | 'ab' | 'diff';

export type PanZoom = { x: number; y: number; scale: number };

export type PixelValues = { file: string; x: number; y: number; values: Record<string, number> };

// Per-file composite-over-beauty settings. AO / depth / normal passes can be
// composited on top of a beauty base instead of rendered standalone. Kept
// per-file (not global like exposure/gamma) so each panel scrubs the focus
// plane / light independently — matches the per-panel picker UX.
export type CompositeSettings = {
  /** Whether the composite-over-beauty mode is on for this file. */
  enabled: boolean;
  /** Base pass display_name override. null = auto-resolve (Combined > Beauty …). */
  base: string | null;
  // AO
  aoStrength: number; // 0..2 (1 = true multiply, >1 overdrive)
  aoInvert: boolean;
  // depth
  depthFocus: number; // 0..1 normalized focus plane
  depthWidth: number; // 0..1 band half-width / falloff
  depthDim: number; // 0..1 out-of-focus brightness floor
  // normal relight
  normalMode: 'clay' | 'modulate';
  lightAzimuth: number; // degrees 0..360
  lightElevation: number; // degrees -90..90
  ambient: number; // 0..1
};

export const DEFAULT_COMPOSITE: CompositeSettings = {
  enabled: false,
  base: null,
  aoStrength: 1,
  aoInvert: false,
  depthFocus: 0.5,
  depthWidth: 0.1,
  depthDim: 0.15,
  normalMode: 'clay',
  lightAzimuth: 90,
  lightElevation: 45,
  ambient: 0.15,
};

/** Convert azimuth/elevation degrees to a light direction in the normals'
 *  space. Azimuth sweeps in the image plane (x right, y up), elevation lifts
 *  toward +Z (toward viewer for view-space normals). */
export function lightDirFromAngles(
  azimuthDeg: number,
  elevationDeg: number,
): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const c = Math.cos(el);
  return [c * Math.cos(az), c * Math.sin(az), Math.sin(el)];
}

export type ViewerState = {
  /** Root directory picked via the FS Access API. null on first load (or in
   *  unsupported browsers — the App renders the support gate instead). */
  rootHandle: FileSystemDirectoryHandle | null;
  setRootHandle: (h: FileSystemDirectoryHandle | null) => void;

  selectedFiles: string[];
  toggleFile: (path: string, exclusive?: boolean) => void;
  setSelectedFiles: (paths: string[]) => void;
  clearSelection: () => void;

  compareMode: CompareMode;
  setCompareMode: (m: CompareMode) => void;

  exposure: number;
  gamma: number;
  setExposure: (v: number) => void;
  setGamma: (v: number) => void;

  activePass: string | null;
  setActivePass: (name: string | null) => void;

  passesByFile: Record<string, FileMetadata>;
  setFilePasses: (file: string, data: FileMetadata) => void;
  removeFilePasses: (file: string) => void;

  /** Per-file load state for the metadata fetch. Allows panels to show
   *  "Loading…" / "Error: …" badges instead of going blank silently. */
  fileStatus: Record<string, { kind: 'loading' } | { kind: 'error'; message: string }>;
  setFileStatus: (
    file: string,
    s: { kind: 'loading' } | { kind: 'error'; message: string } | null,
  ) => void;

  panZoom: PanZoom;
  setPanZoom: (pz: PanZoom) => void;
  resetPanZoom: () => void;

  focusedFile: string | null;
  setFocusedFile: (path: string | null) => void;

  hoverPixel: { x: number; y: number } | null;
  setHoverPixel: (p: { x: number; y: number } | null) => void;

  pixelInfo: PixelValues | null;
  setPixelInfo: (p: PixelValues | null) => void;

  abSplit: number;
  setAbSplit: (v: number) => void;

  // Cryptomatte picks: global across all selected files (cryptomatte hashes are
  // stable across frames of the same scene, which is what we want for the
  // 3-keyframe QA workflow). Cleared whenever the active pass leaves the CRY
  // family so masks don't leak into HDR/normal/etc views.
  cryptoPicks: CryptoCandidate[];
  toggleCryptoPick: (c: CryptoCandidate) => void;
  clearCryptoPicks: () => void;

  // Per-file composite-over-beauty settings (AO/depth/normal). Read with the
  // DEFAULT_COMPOSITE fallback; setComposite merges a partial patch.
  compositeByFile: Record<string, CompositeSettings>;
  setComposite: (file: string, patch: Partial<CompositeSettings>) => void;

  // Runtime status (formerly backendStatus). Calls go through src/api/local.ts
  // — there is no HTTP backend. 'ok' means FS Access + WASM are available;
  // 'down' surfaces unsupported browsers; 'unknown' is the boot state.
  backendStatus: 'unknown' | 'ok' | 'down';
  backendVersion: string | null;
  setBackendStatus: (s: 'unknown' | 'ok' | 'down', v?: string | null) => void;
};

export const useViewerStore = create<ViewerState>((set, get) => ({
  // No default root — the user clicks the picker to grant access.
  rootHandle: null,
  setRootHandle: (h) => set({ rootHandle: h }),

  selectedFiles: [],
  toggleFile: (path, exclusive) => {
    const cur = get().selectedFiles;
    if (exclusive) {
      set({ selectedFiles: [path], focusedFile: path });
      return;
    }
    if (cur.includes(path)) {
      const next = cur.filter((p) => p !== path);
      set({
        selectedFiles: next,
        focusedFile: get().focusedFile === path ? (next[0] ?? null) : get().focusedFile,
      });
    } else {
      set({
        selectedFiles: [...cur, path],
        focusedFile: get().focusedFile ?? path,
      });
    }
  },
  setSelectedFiles: (paths) =>
    set({
      selectedFiles: paths,
      focusedFile: paths.includes(get().focusedFile ?? '') ? get().focusedFile : (paths[0] ?? null),
    }),
  clearSelection: () => set({ selectedFiles: [], focusedFile: null }),

  compareMode: 'grid',
  setCompareMode: (m) => set({ compareMode: m }),

  exposure: 0,
  gamma: 2.2,
  setExposure: (v) => set({ exposure: v }),
  setGamma: (v) => set({ gamma: v }),

  activePass: null,
  setActivePass: (name) => set({ activePass: name }),

  passesByFile: {},
  setFilePasses: (file, data) =>
    set((s) => ({ passesByFile: { ...s.passesByFile, [file]: data } })),
  removeFilePasses: (file) =>
    set((s) => {
      const next = { ...s.passesByFile };
      delete next[file];
      const nextStatus = { ...s.fileStatus };
      delete nextStatus[file];
      return { passesByFile: next, fileStatus: nextStatus };
    }),

  fileStatus: {},
  setFileStatus: (file, s) =>
    set((state) => {
      const next = { ...state.fileStatus };
      if (s === null) delete next[file];
      else next[file] = s;
      return { fileStatus: next };
    }),

  panZoom: { x: 0, y: 0, scale: 1 },
  setPanZoom: (pz) => set({ panZoom: pz }),
  resetPanZoom: () => set({ panZoom: { x: 0, y: 0, scale: 1 } }),

  focusedFile: null,
  setFocusedFile: (path) => set({ focusedFile: path }),

  hoverPixel: null,
  setHoverPixel: (p) => set({ hoverPixel: p }),

  pixelInfo: null,
  setPixelInfo: (p) => set({ pixelInfo: p }),

  abSplit: 50,
  setAbSplit: (v) => set({ abSplit: Math.max(0, Math.min(100, v)) }),

  cryptoPicks: [],
  toggleCryptoPick: (c) => {
    const cur = get().cryptoPicks;
    if (cur.some((p) => p.hash_hex === c.hash_hex)) {
      set({ cryptoPicks: cur.filter((p) => p.hash_hex !== c.hash_hex) });
    } else {
      set({ cryptoPicks: [...cur, c] });
    }
  },
  clearCryptoPicks: () => set({ cryptoPicks: [] }),

  compositeByFile: {},
  setComposite: (file, patch) =>
    set((s) => ({
      compositeByFile: {
        ...s.compositeByFile,
        [file]: { ...DEFAULT_COMPOSITE, ...s.compositeByFile[file], ...patch },
      },
    })),

  backendStatus: 'unknown',
  backendVersion: null,
  setBackendStatus: (s, v) => set({ backendStatus: s, backendVersion: v ?? null }),
}));

export type MergedPass = {
  display_name: string;
  family: PassInfo['family'];
  viz_default: PassInfo['viz_default'];
  rawNames: Map<string, string>;
};

// useMergedPasses derives the union of passes across selected files. It memoizes
// on the two primitive store fields it depends on; passing the raw merge function
// to useViewerStore as a selector triggered Maximum update depth because each call
// minted a new array reference.
export function useMergedPasses(): MergedPass[] {
  const selectedFiles = useViewerStore((s) => s.selectedFiles);
  const passesByFile = useViewerStore((s) => s.passesByFile);
  return useMemo(() => {
    const merged = new Map<string, MergedPass>();
    for (const file of selectedFiles) {
      const data = passesByFile[file];
      if (!data) continue;
      for (const p of data.passes) {
        const existing = merged.get(p.display_name);
        if (existing) {
          existing.rawNames.set(file, p.name);
        } else {
          merged.set(p.display_name, {
            display_name: p.display_name,
            family: p.family,
            viz_default: p.viz_default,
            rawNames: new Map([[file, p.name]]),
          });
        }
      }
    }
    return Array.from(merged.values());
  }, [selectedFiles, passesByFile]);
}
