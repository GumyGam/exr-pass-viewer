// Pass discovery + grouping. Ports backend/app/exr/io.py to TS.
//
// Channels in an EXR are flat strings like "ViewLayer.Combined.R". We group
// them by stripping the trailing component token (R/G/B/A/X/Y/Z/U/V/value)
// into "passes", then classify each pass into one of nine families that the
// renderer knows how to visualize.

import type { ExrChannel, ExrReader } from '../wasm/tinyexr';

/** Visual family. The renderer picks a fragment shader per family. */
export type PassFamily =
  | 'HDR'
  | 'NRM'
  | 'POS'
  | 'VEC'
  | 'UV'
  | 'CRY'
  | 'ID'
  | 'SCALAR'
  | 'RAW';

/** Visualization mode. Multiple modes can map to the same family. */
export type VizMode =
  | 'tonemap'
  | 'color'
  | 'falsecolor'
  | 'normal'
  | 'position'
  | 'vector'
  | 'uv'
  | 'hashid'
  | 'crypto'
  | 'normalize'
  | 'raw';

export interface PassInfo {
  /** Full hierarchical pass name, e.g. "ViewLayer.CryptoMaterial02". */
  name: string;
  /** Without the leading "<layer>." prefix, e.g. "CryptoMaterial02". */
  display_name: string;
  /** Sorted components: R, G, B, A, X, Y, Z, U, V, value, then anything else
   *  alphabetically. Lowercase r/g/b/a (Cryptomatte writers) sort after. */
  components: string[];
  family: PassFamily;
  viz_default: VizMode;
}

export interface FileMetadata {
  width: number;
  height: number;
  passes: PassInfo[];
}

// Channel suffix tokens recognized as the component of a pass. Cryptomatte
// writers use lowercase r/g/b/a, so we accept both cases.
const COMPONENT_TOKENS = new Set<string>([
  'R', 'G', 'B', 'A',
  'X', 'Y', 'Z',
  'U', 'V',
  'value', 'Value',
  'r', 'g', 'b', 'a',
]);

const COMPONENT_PREFERRED_ORDER: readonly string[] = [
  'R', 'G', 'B', 'A',
  'X', 'Y', 'Z',
  'U', 'V',
  'value', 'Value',
  'r', 'g', 'b', 'a',
];

/** Split "ViewLayer.Combined.R" -> ["ViewLayer.Combined", "R"]. Channels
 *  whose tail is not a recognized component get the synthetic "value". */
function splitChannel(channelName: string): [string, string] {
  const dot = channelName.lastIndexOf('.');
  if (dot < 0) {
    return [channelName, 'value'];
  }
  const head = channelName.slice(0, dot);
  const tail = channelName.slice(dot + 1);
  if (COMPONENT_TOKENS.has(tail)) {
    return [head, tail];
  }
  return [channelName, 'value'];
}

/** Sort comparator for component names: known tokens first in fixed order,
 *  everything else alphabetically at the end. */
function compareComponents(a: string, b: string): number {
  const ai = COMPONENT_PREFERRED_ORDER.indexOf(a);
  const bi = COMPONENT_PREFERRED_ORDER.indexOf(b);
  const ax = ai < 0 ? COMPONENT_PREFERRED_ORDER.length : ai;
  const bx = bi < 0 ? COMPONENT_PREFERRED_ORDER.length : bi;
  if (ax !== bx) return ax - bx;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Strip the leading "<layer>." prefix so the UI shows "Combined" instead of
 *  "ViewLayer.Combined". The full machine name is preserved in PassInfo.name. */
function displayName(passName: string): string {
  const dot = passName.indexOf('.');
  if (dot < 0) return passName;
  return passName.slice(dot + 1);
}

/** Does `name` look like an object-id pass (e.g. "ObjectID", "MaterialID",
 *  "object_id")? Designed to NOT match "indirect", "guide", "wide", "Hide". */
function looksLikeIdPass(name: string): boolean {
  // "ID" as a standalone word — start/end or non-letter boundaries.
  if (/(^|[^A-Za-z])ID($|[^A-Za-z])/.test(name)) return true;
  // CamelCase suffix: "ObjectID", "MaterialID", "passID".
  if (/[a-z]ID($|[^a-z])/.test(name)) return true;
  // snake_case: "object_id", "asset_id_2".
  if (/(^|_)id(_|$)/i.test(name)) return true;
  return false;
}

/**
 * Classify a pass into one of the viz modes.
 *
 * This is a near-verbatim port of `_classify_viz` from io.py, with TWO
 * spec changes:
 *   1. Cryptomatte detection uses `.includes('crypto')` instead of
 *      `.startsWith('crypto')`. That makes CryptoMaterial / CryptoObject /
 *      CryptoAsset / CryptoLight / future Crypto* all activate the picker.
 *   2. ID-shaped pass names (ObjectID, MaterialID, object_id, …) map to
 *      `raw` — most renderers that emit `ObjectID` write a pre-baked RGB
 *      color-per-object into R/G/B (A=1). That's what AE's Cryptomatte
 *      plugin shows in its preview. Routing to `crypto` viz here was
 *      wrong: that shader treats channel 0 as bit-cast hash + channel 1
 *      as coverage, which produces black for any pixel where R==0
 *      (dirt, floor, …) because of the NaN-avoidance branch.
 *
 * Ordering matters: e.g. a hypothetical "DenoisingNormal" pass should fall
 * into `normal`, not into the HDR catch-all that contains "denoising albedo".
 */
function classifyViz(displayNameStr: string): VizMode {
  const nl = displayNameStr.toLowerCase();

  // SPEC CHANGE vs Python: substring, not prefix.
  if (nl.includes('crypto')) return 'crypto';

  // SPEC CHANGE vs Python: ObjectID/MaterialID/etc are pre-baked RGB color
  // streams in most renderers — pass them through raw.
  if (looksLikeIdPass(displayNameStr)) return 'raw';

  if (nl.includes('denoising normal') || nl.startsWith('normal') || nl.includes('normalcamera')) {
    return 'normal';
  }
  if (nl === 'position') return 'position';
  if (nl === 'vector') return 'vector';
  if (nl === 'uv') return 'uv';

  if (nl === 'depth' || nl === 'mist' || nl === 'denoising depth') {
    return 'falsecolor';
  }

  if (nl.includes('index') || nl.includes('debug sample count')) {
    return 'hashid';
  }

  const colorTerms = [
    'basecolor', 'base color',
    'diffuse color', 'glossy color', 'transmission color',
    'denoising albedo',
  ];
  if (
    colorTerms.some((term) => nl.includes(term)) ||
    nl.endsWith('_color') ||
    nl.endsWith('_tint')
  ) {
    return 'color';
  }

  const hdrTerms = [
    'combined', 'noisy image', 'beauty',
    'diffuse direct', 'diffuse indirect',
    'glossy direct', 'glossy indirect',
    'transmission direct', 'transmission indirect',
    'volume direct', 'volume indirect',
    'emission', 'environment',
  ];
  if (hdrTerms.some((term) => nl.includes(term))) {
    return 'tonemap';
  }

  return 'normalize';
}

/** Map a viz mode to its family. The renderer picks a shader per family. */
function vizToFamily(viz: VizMode): PassFamily {
  switch (viz) {
    case 'tonemap':
    case 'color':
      return 'HDR';
    case 'falsecolor':
      // No dedicated depth family in the TS taxonomy; falsecolor passes are
      // single-channel scalars rendered with a colormap. Group with SCALAR.
      return 'SCALAR';
    case 'normal':
      return 'NRM';
    case 'position':
      return 'POS';
    case 'vector':
      return 'VEC';
    case 'uv':
      return 'UV';
    case 'hashid':
      return 'ID';
    case 'crypto':
      return 'CRY';
    case 'normalize':
      return 'SCALAR';
    case 'raw':
      return 'RAW';
  }
}

/**
 * Group an EXR's channels into passes and classify each one. Header-only:
 * no pixel data is read.
 */
export function listPasses(reader: ExrReader): FileMetadata {
  const { width, height } = reader.getDimensions();
  const channels: ExrChannel[] = reader.getChannels();

  // pass_name -> set of components seen
  const groups = new Map<string, Set<string>>();
  for (const ch of channels) {
    const [passName, component] = splitChannel(ch.name);
    let bucket = groups.get(passName);
    if (!bucket) {
      bucket = new Set<string>();
      groups.set(passName, bucket);
    }
    bucket.add(component);
  }

  // Stable sort: pass names alphabetically.
  const passNames = [...groups.keys()].sort();
  const passes: PassInfo[] = passNames.map((passName) => {
    const components = [...(groups.get(passName) as Set<string>)].sort(compareComponents);
    const display = displayName(passName);
    const viz = classifyViz(display);
    return {
      name: passName,
      display_name: display,
      components,
      family: vizToFamily(viz),
      viz_default: viz,
    };
  });

  return { width, height, passes };
}
