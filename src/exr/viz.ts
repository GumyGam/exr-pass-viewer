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
  compositeRelightPointFrag,
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
  /** Auxiliary pass for point-light relight: a Position pass (xyz) or a depth
   *  scalar (single channel). Only read when params.lightMode === 'point'. */
  auxChannels?: Float32Array[];
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
  // normal — directional
  lightDir?: [number, number, number];
  ambient?: number;
  normalMode?: 'clay' | 'modulate';
  // normal — point-light 3D
  lightMode?: 'directional' | 'point';
  /** true: auxChannels is a Position pass (xyz used directly). false: depth
   *  scalar, reconstructed with fov. */
  auxIsPosition?: boolean;
  anchorU?: number;
  anchorV?: number;
  pointHeight?: number;
  pointRange?: number;
  pointIntensity?: number;
  /** Vertical FOV in degrees for depth reconstruction. */
  fov?: number;
  /** Stable cache key for the aux percentile range(s). */
  auxCacheKey?: string;
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

    if (params.lightMode === 'point' && input.auxChannels && input.auxChannels.length > 0) {
      const aux = input.auxChannels;
      const auxIsPos = !!params.auxIsPosition;
      const ax = aux[0] ?? new Float32Array(total);
      const ay = auxIsPos ? (aux[1] ?? new Float32Array(total)) : ax;
      const az = auxIsPos ? (aux[2] ?? new Float32Array(total)) : ax;

      const aspect = width / height;
      const fovRad = ((params.fov ?? 50) * Math.PI) / 180;
      const tanY = Math.tan(fovRad / 2);
      const tanX = tanY * aspect;

      // Anchor pixel (clamped). floor(au*width) matches the shader's NEAREST
      // texel pick floor(vUv*srcW), so the CPU reads the same texel the GPU
      // reconstructs.
      const au = Math.min(1, Math.max(0, params.anchorU ?? 0.5));
      const av = Math.min(1, Math.max(0, params.anchorV ?? 0.5));
      const px = Math.min(width - 1, Math.max(0, Math.floor(au * width)));
      const py = Math.min(height - 1, Math.max(0, Math.floor(av * height)));
      const aidx = py * width + px;

      // Anchor surface normal (normalized). Matches the shader's +Z fallback
      // for a degenerate (zero) normal so clicking a background pixel behaves
      // the same CPU- and GPU-side.
      let nXa = nx[aidx] ?? 0;
      let nYa = ny[aidx] ?? 0;
      let nZa = nz[aidx] ?? 0;
      const nl = Math.hypot(nXa, nYa, nZa);
      if (nl > 1e-6) {
        nXa /= nl;
        nYa /= nl;
        nZa /= nl;
      } else {
        nXa = 0;
        nYa = 0;
        nZa = 1;
      }

      // Anchor surface position + a characteristic scene scale (a single-axis
      // extent) so the height / range sliders read the same whether the aux is
      // a Position pass or a reconstructed depth pass.
      let pax: number;
      let pay: number;
      let paz: number;
      let sceneScale: number;
      const auxKey = params.auxCacheKey;
      if (auxIsPos) {
        pax = ax[aidx] ?? 0;
        pay = ay[aidx] ?? 0;
        paz = az[aidx] ?? 0;
        const [loX, hiX] = computePercentileRange(ax, auxKey ? `${auxKey}::0` : undefined);
        const [loY, hiY] = computePercentileRange(ay, auxKey ? `${auxKey}::1` : undefined);
        const [loZ, hiZ] = computePercentileRange(az, auxKey ? `${auxKey}::2` : undefined);
        // Largest per-axis span — comparable in magnitude to the depth branch's
        // single-axis span (the diagonal would over-scale by ~sqrt(3)).
        sceneScale = Math.max(hiX - loX, hiY - loY, hiZ - loZ) || 1;
      } else {
        const depthA = ax[aidx] ?? 0;
        // ndc from the texel CENTER so CPU P matches the shader's P exactly.
        const ucx = (px + 0.5) / width;
        const ucy = (py + 0.5) / height;
        const ndcX = ucx * 2 - 1;
        const ndcY = (1 - ucy) * 2 - 1;
        pax = ndcX * tanX * depthA;
        pay = ndcY * tanY * depthA;
        paz = -depthA;
        const [lo, hi] = computePercentileRange(ax, auxKey);
        sceneScale = hi - lo || 1;
      }

      const heightWorld = (params.pointHeight ?? 0.3) * 2 * sceneScale;
      const rangeWorld = (params.pointRange ?? 0.5) * 4 * sceneScale + 1e-4;
      const lightPos: [number, number, number] = [
        pax + nXa * heightWorld,
        pay + nYa * heightWorld,
        paz + nZa * heightWorld,
      ];

      call = {
        fragSrc: compositeRelightPointFrag(),
        // Depth-only aux is replicated into 3 slots; only uCh6 is read.
        channelData: [br, bg, bb, nx, ny, nz, ax, ay, az],
        srcWidth: width,
        srcHeight: height,
        uniformsFloat: {
          uExposure: exposure,
          uGamma: gamma,
          uAmbient: params.ambient ?? 0.15,
          uMode: params.normalMode === 'modulate' ? 1 : 0,
          uRange: rangeWorld,
          uIntensity: params.pointIntensity ?? 1,
          uReconstruct: auxIsPos ? 0 : 1,
        },
        uniformsVec2: { uTanHalfFov: [tanX, tanY] },
        uniformsVec3: { uLightPos: lightPos },
      };
    } else {
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
