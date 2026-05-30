// Top-level render entrypoint. Dispatches a viz mode to the right fragment
// shader and feeds it the right uniforms.
//
// Ports backend/app/exr/viz.py:render() to TS + WebGL. The Renderer instance
// is created lazily and cached per-process so we don't pay for context+VAO
// creation on every frame.
//
// Channel data shape. The brief specifies `channelData: Float32Array[]` —
// one Float32Array per `pass.components` entry, in the same order. The
// `passChannelMapToArray()` helper converts the worker pool's
// `Map<channelName, Float32Array>` shape into that array.

import type { CompositeKind, PassInfo, VizMode } from './passes';
import { Renderer } from '../webgl/renderer';
import type { DrawCall } from '../webgl/renderer';
import {
  colorFrag,
  compositeAoFrag,
  compositeDepthFrag,
  compositeNormalFrag,
  cryptoFrag,
  falsecolorFrag,
  hashidFrag,
  normalFrag,
  normalizeFrag,
  positionFrag,
  rawFrag,
  tonemapFrag,
  uvFrag,
  vectorFrag,
} from '../webgl/shaders';
import {
  computeMagnitude98,
  computePercentileRange,
} from './tonemap';

export interface RenderOptions {
  viz: VizMode;
  /** Exposure in stops. Default 0. */
  exposure?: number;
  /** Gamma. Default 2.2 (sRGB curve). */
  gamma?: number;
  /** Output canvas width. Renderer downsamples if needed. Default = srcWidth. */
  maxWidth?: number;
  /**
   * Stable key for caching percentile results across renders of the same
   * pass + file. Highly recommended for falsecolor / normalize / position /
   * vector modes — without it every render recomputes the percentile.
   */
  cacheKey?: string;
}

export interface RenderInput {
  /** Source EXR width. */
  width: number;
  /** Source EXR height. */
  height: number;
  /** Per-component float32 data, same order as pass.components. */
  channelData: Float32Array[];
  /** The pass being rendered. */
  pass: PassInfo;
}

// Process-singleton renderer. WebGL2 contexts are expensive to create; we
// keep one around and resize its canvas per-render. Worker scope or main
// thread, either works.
let cachedRenderer: Renderer | null = null;

function getRenderer(width: number, height: number): Renderer {
  if (!cachedRenderer) {
    cachedRenderer = new Renderer({ width, height });
  } else {
    cachedRenderer.setSize(width, height);
  }
  return cachedRenderer;
}

/**
 * Render a pass to an OffscreenCanvas. The returned canvas is the renderer's
 * own canvas — callers should immediately `transferToImageBitmap()` it (or
 * copy via drawImage) since the next render call will overwrite it.
 *
 * Returns synchronously. Callers that need an ImageBitmap can transfer
 * directly: `renderPass(input, opts).transferToImageBitmap()`.
 */
export function renderPass(input: RenderInput, opts: RenderOptions): OffscreenCanvas {
  const exposure = opts.exposure ?? 0;
  const gamma = opts.gamma ?? 2.2;
  const srcW = input.width;
  const srcH = input.height;

  // Compute output dimensions. Renderer downsamples by drawing a fullscreen
  // quad into a smaller canvas; nearest filtering on the source texture is
  // good enough for a static-frame viewer.
  let outW = srcW;
  let outH = srcH;
  if (opts.maxWidth && srcW > opts.maxWidth) {
    const scale = opts.maxWidth / srcW;
    outW = opts.maxWidth;
    outH = Math.max(1, Math.round(srcH * scale));
  }

  const r = getRenderer(outW, outH);
  const call = buildDrawCall(input, opts.viz, exposure, gamma, opts.cacheKey);
  r.render(call);
  return r.canvas;
}

/**
 * Render a single-channel float32 mask (in [0, 1]) into an opaque grayscale
 * OffscreenCanvas. Used to composite Cryptomatte selection masks.
 *
 * The mask is treated as a 'raw' single-channel scalar: out = vec3(mask).
 */
export function renderMask(
  width: number,
  height: number,
  mask: Float32Array,
  opts: { maxWidth?: number } = {},
): OffscreenCanvas {
  let outW = width;
  let outH = height;
  if (opts.maxWidth && width > opts.maxWidth) {
    const scale = opts.maxWidth / width;
    outW = opts.maxWidth;
    outH = Math.max(1, Math.round(height * scale));
  }
  const r = getRenderer(outW, outH);
  const call: DrawCall = {
    fragSrc: rawFrag(1),
    channelData: [mask],
    srcWidth: width,
    srcHeight: height,
  };
  r.render(call);
  return r.canvas;
}

/** Per-component channel data for a composite render. `beautyChannels` is the
 *  base HDR pass's components (in pass order); `effectChannels` is the AO /
 *  depth / normal pass's components. */
export interface CompositeInput {
  width: number;
  height: number;
  beautyChannels: Float32Array[];
  effectChannels: Float32Array[];
}

export interface CompositeParams {
  kind: CompositeKind;
  /** Exposure stops applied to the beauty base (display-space blend). */
  exposure: number;
  /** Gamma applied to the beauty base. */
  gamma: number;
  maxWidth?: number;
  // AO
  aoStrength?: number;
  aoInvert?: boolean;
  // depth
  depthFocus?: number;
  depthWidth?: number;
  depthDim?: number;
  /** Stable cache key for the depth percentile range. */
  depthCacheKey?: string;
  // normal
  lightDir?: [number, number, number];
  ambient?: number;
  normalMode?: 'clay' | 'modulate';
}

/** Expand a beauty pass's channels into exactly three (r,g,b) arrays, matching
 *  the replicate/pad convention the standalone tonemap shader uses. */
function beautyTriple(
  ch: Float32Array[],
  total: number,
): [Float32Array, Float32Array, Float32Array] {
  if (ch.length >= 3) return [ch[0]!, ch[1]!, ch[2]!];
  if (ch.length === 2) return [ch[0]!, ch[1]!, new Float32Array(total)];
  const v = ch[0] ?? new Float32Array(total);
  return [v, v, v];
}

/**
 * Composite an AO / depth / normal pass on top of a beauty base in display
 * space. Returns the renderer's canvas (transfer immediately, like renderPass).
 */
export function renderComposite(input: CompositeInput, params: CompositeParams): OffscreenCanvas {
  const { width, height, beautyChannels, effectChannels } = input;
  const total = width * height;
  const exposure = params.exposure;
  const gamma = params.gamma;

  let outW = width;
  let outH = height;
  if (params.maxWidth && width > params.maxWidth) {
    const scale = params.maxWidth / width;
    outW = params.maxWidth;
    outH = Math.max(1, Math.round(height * scale));
  }

  const [br, bg, bb] = beautyTriple(beautyChannels, total);

  let call: DrawCall;
  if (params.kind === 'ao') {
    const ao = effectChannels[0] ?? new Float32Array(total);
    call = {
      fragSrc: compositeAoFrag(),
      channelData: [br, bg, bb, ao],
      srcWidth: width,
      srcHeight: height,
      uniformsFloat: {
        uExposure: exposure,
        uGamma: gamma,
        uStrength: params.aoStrength ?? 1,
        uInvert: params.aoInvert ? 1 : 0,
      },
    };
  } else if (params.kind === 'depth') {
    const depth = effectChannels[0] ?? new Float32Array(total);
    const [lo, hi] = computePercentileRange(depth, params.depthCacheKey);
    call = {
      fragSrc: compositeDepthFrag(),
      channelData: [br, bg, bb, depth],
      srcWidth: width,
      srcHeight: height,
      uniformsFloat: {
        uExposure: exposure,
        uGamma: gamma,
        uFocus: params.depthFocus ?? 0.5,
        uWidth: params.depthWidth ?? 0.1,
        uDim: params.depthDim ?? 0.15,
      },
      uniformsVec2: { uRange: [lo, hi] },
    };
  } else {
    const nx = effectChannels[0] ?? new Float32Array(total);
    const ny = effectChannels[1] ?? new Float32Array(total);
    const nz = effectChannels[2] ?? new Float32Array(total);
    call = {
      fragSrc: compositeNormalFrag(),
      channelData: [br, bg, bb, nx, ny, nz],
      srcWidth: width,
      srcHeight: height,
      uniformsFloat: {
        uExposure: exposure,
        uGamma: gamma,
        uAmbient: params.ambient ?? 0.15,
        uMode: params.normalMode === 'modulate' ? 1 : 0,
      },
      uniformsVec3: { uLightDir: params.lightDir ?? [0, 0.7, 0.7] },
    };
  }

  const r = getRenderer(outW, outH);
  r.render(call);
  return r.canvas;
}

/** Build the per-draw-call payload for a given viz mode. */
function buildDrawCall(
  input: RenderInput,
  viz: VizMode,
  exposure: number,
  gamma: number,
  cacheKey: string | undefined,
): DrawCall {
  const { width, height, channelData, pass } = input;
  const componentCount = channelData.length;

  switch (viz) {
    case 'tonemap': {
      return {
        fragSrc: tonemapFrag(componentCount),
        channelData,
        srcWidth: width,
        srcHeight: height,
        uniformsFloat: { uExposure: exposure, uGamma: gamma },
      };
    }
    case 'color': {
      return {
        fragSrc: colorFrag(componentCount),
        channelData,
        srcWidth: width,
        srcHeight: height,
        uniformsFloat: { uGamma: gamma },
      };
    }
    case 'falsecolor': {
      const [lo, hi] = computePercentileRange(
        channelData[0],
        cacheKey ? `${cacheKey}::p2_p98::0` : undefined,
      );
      return {
        fragSrc: falsecolorFrag(componentCount),
        channelData: [channelData[0]],
        srcWidth: width,
        srcHeight: height,
        uniformsVec2: { uRange: [lo, hi] },
      };
    }
    case 'normal': {
      return {
        fragSrc: normalFrag(componentCount),
        channelData,
        srcWidth: width,
        srcHeight: height,
      };
    }
    case 'position': {
      // Per-channel ranges. If the pass only has 1 or 2 components we fill
      // the missing slots with (0, 1) ranges; the visual is undefined for
      // malformed position passes but at least it doesn't crash.
      const r0 = channelData[0]
        ? computePercentileRange(channelData[0], cacheKey ? `${cacheKey}::p2_p98::0` : undefined)
        : ([0, 1] as [number, number]);
      const r1 = channelData[1]
        ? computePercentileRange(channelData[1], cacheKey ? `${cacheKey}::p2_p98::1` : undefined)
        : ([0, 1] as [number, number]);
      const r2 = channelData[2]
        ? computePercentileRange(channelData[2], cacheKey ? `${cacheKey}::p2_p98::2` : undefined)
        : ([0, 1] as [number, number]);
      return {
        fragSrc: positionFrag(componentCount),
        channelData: channelData.slice(0, 3),
        srcWidth: width,
        srcHeight: height,
        uniformsVec2: { uRangeR: r0, uRangeG: r1, uRangeB: r2 },
      };
    }
    case 'vector': {
      if (componentCount < 2) {
        throw new Error(`vector viz requires >=2 channels, got ${componentCount} for ${pass.name}`);
      }
      const magMax = computeMagnitude98(
        channelData[0],
        channelData[1],
        cacheKey ? `${cacheKey}::mag98` : undefined,
      );
      return {
        fragSrc: vectorFrag(componentCount),
        channelData: [channelData[0], channelData[1]],
        srcWidth: width,
        srcHeight: height,
        uniformsFloat: { uMagMax: magMax },
      };
    }
    case 'uv': {
      if (componentCount < 2) {
        throw new Error(`uv viz requires >=2 channels, got ${componentCount} for ${pass.name}`);
      }
      return {
        fragSrc: uvFrag(componentCount),
        channelData: [channelData[0], channelData[1]],
        srcWidth: width,
        srcHeight: height,
      };
    }
    case 'hashid': {
      return {
        fragSrc: hashidFrag(componentCount),
        channelData: [channelData[0]],
        srcWidth: width,
        srcHeight: height,
      };
    }
    case 'crypto': {
      if (componentCount < 2) {
        throw new Error(`crypto viz requires >=2 channels, got ${componentCount} for ${pass.name}`);
      }
      return {
        fragSrc: cryptoFrag(componentCount),
        channelData: [channelData[0], channelData[1]],
        srcWidth: width,
        srcHeight: height,
      };
    }
    case 'normalize': {
      const [lo, hi] = computePercentileRange(
        channelData[0],
        cacheKey ? `${cacheKey}::p2_p98::0` : undefined,
      );
      return {
        fragSrc: normalizeFrag(componentCount),
        channelData: [channelData[0]],
        srcWidth: width,
        srcHeight: height,
        uniformsVec2: { uRange: [lo, hi] },
      };
    }
    case 'raw': {
      return {
        fragSrc: rawFrag(componentCount),
        channelData,
        srcWidth: width,
        srcHeight: height,
      };
    }
  }
}
