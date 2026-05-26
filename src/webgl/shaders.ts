// Fragment shader sources for every viz mode.
//
// Ports backend/app/exr/viz.py + tonemap.py + turbo.py to GLSL ES 3.00.
// Each shader takes 1..4 R32F sampler2D textures (one per source component)
// and writes RGBA8 to the default framebuffer. The vertex shader is shared.
//
// Conventions:
//   uniform sampler2D uCh0, uCh1, uCh2, uCh3;  -- per-component R32F textures
//   uniform float uExposure;                   -- exposure stops (tonemap only)
//   uniform float uGamma;                      -- gamma (color/tonemap)
//   uniform vec2  uRange;                      -- (lo, hi) for percentile-normalized modes
//   uniform vec2  uRangeR, uRangeG, uRangeB;   -- per-channel range (position)
//   uniform float uMagMax;                     -- 98th-percentile magnitude (vector)
//
// All shaders use the same fullscreen-triangle-pair vertex shader and the
// same varying vUv that gives the [0,1] sample coordinate.

/** Vertex shader: a fullscreen quad driven by gl_VertexID. */
export const VERT_SHADER = /* glsl */ `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  // Two triangles covering NDC [-1,1]^2.
  // gl_VertexID 0..5 -> (-1,-1), (1,-1), (-1,1), (-1,1), (1,-1), (1,1)
  vec2 pos;
  if (gl_VertexID == 0) pos = vec2(-1.0, -1.0);
  else if (gl_VertexID == 1) pos = vec2( 1.0, -1.0);
  else if (gl_VertexID == 2) pos = vec2(-1.0,  1.0);
  else if (gl_VertexID == 3) pos = vec2(-1.0,  1.0);
  else if (gl_VertexID == 4) pos = vec2( 1.0, -1.0);
  else                       pos = vec2( 1.0,  1.0);

  // Flip V so texture row 0 ends up at the TOP of the canvas.
  // EXR data is stored top-down; WebGL's default texture origin is bottom-left,
  // so we flip the UV here rather than passing UNPACK_FLIP_Y to texImage2D
  // (which doesn't work for non-DOM sources in WebGL2).
  vUv = vec2((pos.x + 1.0) * 0.5, 1.0 - (pos.y + 1.0) * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

// Shared GLSL helper functions (sRGB, HSV).
const HELPERS = /* glsl */ `
// Standard sRGB EOTF (linear -> sRGB encoded), piecewise function.
float linearToSrgbScalar(float x) {
  x = max(x, 0.0);
  float low = x * 12.92;
  float high = 1.055 * pow(x, 1.0 / 2.4) - 0.055;
  return mix(high, low, step(x, 0.0031308));
}

vec3 linearToSrgb(vec3 x) {
  return vec3(
    linearToSrgbScalar(x.r),
    linearToSrgbScalar(x.g),
    linearToSrgbScalar(x.b)
  );
}

// HSV -> RGB. Matches numpy implementation in viz.py (_hsv_to_rgb).
vec3 hsvToRgb(float h, float s, float v) {
  float h6 = mod(h, 1.0) * 6.0;
  float i = floor(h6);
  float f = h6 - i;
  float p = v * (1.0 - s);
  float q = v * (1.0 - s * f);
  float t = v * (1.0 - s * (1.0 - f));
  int ii = int(mod(i, 6.0));
  if (ii == 0) return vec3(v, t, p);
  if (ii == 1) return vec3(q, v, p);
  if (ii == 2) return vec3(p, v, t);
  if (ii == 3) return vec3(p, q, v);
  if (ii == 4) return vec3(t, p, v);
  return vec3(v, p, q);
}

// Google Turbo colormap polynomial (Anton Mikhailov approximation).
// Constants verbatim from turbo.py.
vec3 turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  float x2 = x * x;
  float x3 = x2 * x;
  float x4 = x3 * x;
  float x5 = x4 * x;
  float r = 0.13572138 +   4.61539260*x  + -42.66032258*x2 + 132.13108234*x3 + -152.94239396*x4 +  59.28637943*x5;
  float g = 0.09140261 +   2.19418839*x  +   4.84296658*x2 + -14.18503333*x3 +    4.27729857*x4 +   2.82956604*x5;
  float b = 0.10667330 +  12.64194608*x  + -60.58204836*x2 + 110.36276771*x3 +  -89.90310912*x4 +  27.34824973*x5;
  return clamp(vec3(r, g, b), 0.0, 1.0);
}

// Read one channel value at the current UV.
float sampleCh(sampler2D tex) {
  return texture(tex, vUv).r;
}
`;

/** Prefix every fragment shader gets: version, precision, declarations, helpers. */
function fragHead(channelCount: number, extraUniforms: string = ''): string {
  const samplerDecls = [];
  for (let i = 0; i < channelCount; i++) {
    samplerDecls.push(`uniform sampler2D uCh${i};`);
  }
  return /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 vUv;
out vec4 outColor;

${samplerDecls.join('\n')}
${extraUniforms}

${HELPERS}
`;
}

// ----- TONEMAP -----------------------------------------------------------------
// out.rgb = sRGB(input.rgb * 2^exposure); alpha pass-through if present.
// When gamma != 2.2 we apply pow(x, 1/gamma) instead of the sRGB curve.
export function tonemapFrag(channelCount: number): string {
  const hasAlpha = channelCount >= 4;
  // Build the source vec3. Single-channel: replicate. Two: pad with 0.
  // Three or more: use first three.
  let pickRgb;
  if (channelCount === 1) {
    pickRgb = 'float v = sampleCh(uCh0); vec3 src = vec3(v);';
  } else if (channelCount === 2) {
    pickRgb = 'vec3 src = vec3(sampleCh(uCh0), sampleCh(uCh1), 0.0);';
  } else {
    pickRgb = 'vec3 src = vec3(sampleCh(uCh0), sampleCh(uCh1), sampleCh(uCh2));';
  }
  return fragHead(channelCount, 'uniform float uExposure;\nuniform float uGamma;') + /* glsl */ `

void main() {
  ${pickRgb}
  vec3 x = src * exp2(uExposure);
  vec3 y;
  if (abs(uGamma - 2.2) < 1e-6) {
    y = linearToSrgb(x);
  } else {
    y = pow(max(x, vec3(0.0)), vec3(1.0 / uGamma));
  }
  y = clamp(y, 0.0, 1.0);
  float a = ${hasAlpha ? 'clamp(sampleCh(uCh3), 0.0, 1.0)' : '1.0'};
  outColor = vec4(y, a);
}
`;
}

// ----- COLOR -------------------------------------------------------------------
// Gamma-only correction. No exposure. Used for albedo / basecolor-style passes.
export function colorFrag(channelCount: number): string {
  let pickRgb;
  if (channelCount === 1) {
    pickRgb = 'float v = sampleCh(uCh0); vec3 src = vec3(v);';
  } else if (channelCount === 2) {
    pickRgb = 'vec3 src = vec3(sampleCh(uCh0), sampleCh(uCh1), 0.0);';
  } else {
    pickRgb = 'vec3 src = vec3(sampleCh(uCh0), sampleCh(uCh1), sampleCh(uCh2));';
  }
  return fragHead(channelCount, 'uniform float uGamma;') + /* glsl */ `

void main() {
  ${pickRgb}
  vec3 y;
  if (abs(uGamma - 1.0) < 1e-6) {
    y = src;
  } else {
    y = pow(max(src, vec3(0.0)), vec3(1.0 / uGamma));
  }
  y = clamp(y, 0.0, 1.0);
  outColor = vec4(y, 1.0);
}
`;
}

// ----- FALSECOLOR --------------------------------------------------------------
// Single-channel input (or first of multiple) -> Turbo colormap after
// percentile normalization. uRange = (lo, hi) is computed on CPU.
export function falsecolorFrag(channelCount: number): string {
  const _ = channelCount;
  void _;
  return fragHead(1, 'uniform vec2 uRange;') + /* glsl */ `

void main() {
  float scalar = sampleCh(uCh0);
  float lo = uRange.x;
  float hi = uRange.y;
  float x = (scalar - lo) / max(hi - lo, 1e-8);
  vec3 rgb = turbo(x);
  outColor = vec4(rgb, 1.0);
}
`;
}

// ----- NORMAL ------------------------------------------------------------------
// Input in [-1, 1] -> rgb = (input + 1) * 0.5.
export function normalFrag(channelCount: number): string {
  let pickRgb;
  if (channelCount === 1) {
    pickRgb = 'float v = sampleCh(uCh0); vec3 src = vec3(v);';
  } else if (channelCount === 2) {
    pickRgb = 'vec3 src = vec3(sampleCh(uCh0), sampleCh(uCh1), 0.0);';
  } else {
    pickRgb = 'vec3 src = vec3(sampleCh(uCh0), sampleCh(uCh1), sampleCh(uCh2));';
  }
  return fragHead(channelCount) + /* glsl */ `

void main() {
  ${pickRgb}
  vec3 y = clamp((src + 1.0) * 0.5, 0.0, 1.0);
  outColor = vec4(y, 1.0);
}
`;
}

// ----- POSITION ----------------------------------------------------------------
// Per-channel percentile normalize. Ranges computed CPU-side.
export function positionFrag(channelCount: number): string {
  let pickRgb;
  if (channelCount === 1) {
    pickRgb = 'float v = sampleCh(uCh0); vec3 src = vec3(v);';
  } else if (channelCount === 2) {
    pickRgb = 'vec3 src = vec3(sampleCh(uCh0), sampleCh(uCh1), 0.0);';
  } else {
    pickRgb = 'vec3 src = vec3(sampleCh(uCh0), sampleCh(uCh1), sampleCh(uCh2));';
  }
  const extras = 'uniform vec2 uRangeR;\nuniform vec2 uRangeG;\nuniform vec2 uRangeB;';
  return fragHead(channelCount, extras) + /* glsl */ `

void main() {
  ${pickRgb}
  float r = (src.r - uRangeR.x) / max(uRangeR.y - uRangeR.x, 1e-8);
  float g = (src.g - uRangeG.x) / max(uRangeG.y - uRangeG.x, 1e-8);
  float b = (src.b - uRangeB.x) / max(uRangeB.y - uRangeB.x, 1e-8);
  vec3 y = clamp(vec3(r, g, b), 0.0, 1.0);
  outColor = vec4(y, 1.0);
}
`;
}

// ----- VECTOR ------------------------------------------------------------------
// 2D motion vector. hue = atan2(y,x)/TAU + 0.5; mag = length, normalized; val=mag.
export function vectorFrag(channelCount: number): string {
  const _ = channelCount;
  void _;
  return fragHead(2, 'uniform float uMagMax;') + /* glsl */ `

void main() {
  float x = sampleCh(uCh0);
  float y = sampleCh(uCh1);
  float angle = atan(y, x);                     // [-pi, pi]
  float hue = angle / 6.28318530717958647692;   // [-0.5, 0.5]
  hue = mod(hue + 1.0, 1.0);                    // wrap to [0, 1)
  float mag = sqrt(x * x + y * y);
  float val = clamp(mag / max(uMagMax, 1e-8), 0.0, 1.0);
  vec3 rgb = hsvToRgb(hue, 1.0, val);
  outColor = vec4(rgb, 1.0);
}
`;
}

// ----- UV ----------------------------------------------------------------------
// First two channels -> R=u, G=v, B=0.
export function uvFrag(channelCount: number): string {
  const _ = channelCount;
  void _;
  return fragHead(2) + /* glsl */ `

void main() {
  float u = clamp(sampleCh(uCh0), 0.0, 1.0);
  float v = clamp(sampleCh(uCh1), 0.0, 1.0);
  outColor = vec4(u, v, 0.0, 1.0);
}
`;
}

// ----- HASHID ------------------------------------------------------------------
// Single channel = integer ID stored as float. Knuth LCG -> hue. Sat 0.65.
// Python rounds the float first, then masks to 32 bits and multiplies by
// 2654435761 modulo 2^32.
export function hashidFrag(channelCount: number): string {
  const _ = channelCount;
  void _;
  return fragHead(1) + /* glsl */ `

void main() {
  float scalar = sampleCh(uCh0);
  int rounded = int(floor(scalar + 0.5));         // matches np.round
  uint id = uint(rounded);                         // wraps negatives to large uints (matches numpy & 0xFFFFFFFF cast)
  uint mixed = id * 2654435761u;                   // implicit mod 2^32 in uint mul
  float hue = float(mixed) / 4294967295.0;
  float sat = 0.65;
  float val = (scalar == 0.0) ? 0.0 : 1.0;
  vec3 rgb = hsvToRgb(hue, sat, val);
  outColor = vec4(rgb, 1.0);
}
`;
}

// ----- CRYPTO ------------------------------------------------------------------
// First channel: hash float — reinterpret bits as uint32 -> Knuth -> hue.
// Second channel: coverage in [0,1] -> value. Sat 0.7.
export function cryptoFrag(channelCount: number): string {
  const _ = channelCount;
  void _;
  return fragHead(2) + /* glsl */ `

void main() {
  float hashFloat = sampleCh(uCh0);
  float coverage = sampleCh(uCh1);
  uint asUint = floatBitsToUint(hashFloat);
  uint mixed = asUint * 2654435761u;
  float hue = float(mixed) / 4294967295.0;
  float sat = 0.7;
  float val = clamp(coverage, 0.0, 1.0);
  if (hashFloat == 0.0) val = 0.0;
  vec3 rgb = hsvToRgb(hue, sat, val);
  outColor = vec4(rgb, 1.0);
}
`;
}

// ----- NORMALIZE ---------------------------------------------------------------
// Like falsecolor but grayscale output.
export function normalizeFrag(channelCount: number): string {
  const _ = channelCount;
  void _;
  return fragHead(1, 'uniform vec2 uRange;') + /* glsl */ `

void main() {
  float scalar = sampleCh(uCh0);
  float lo = uRange.x;
  float hi = uRange.y;
  float x = clamp((scalar - lo) / max(hi - lo, 1e-8), 0.0, 1.0);
  outColor = vec4(x, x, x, 1.0);
}
`;
}

// ----- RAW ---------------------------------------------------------------------
// out.rgb = clamp(src, 0, 1). Pass-through visualization for debugging.
export function rawFrag(channelCount: number): string {
  let pickRgb;
  if (channelCount === 1) {
    pickRgb = 'float v = sampleCh(uCh0); vec3 src = vec3(v);';
  } else if (channelCount === 2) {
    pickRgb = 'vec3 src = vec3(sampleCh(uCh0), sampleCh(uCh1), 0.0);';
  } else {
    pickRgb = 'vec3 src = vec3(sampleCh(uCh0), sampleCh(uCh1), sampleCh(uCh2));';
  }
  return fragHead(channelCount) + /* glsl */ `

void main() {
  ${pickRgb}
  vec3 y = clamp(src, 0.0, 1.0);
  outColor = vec4(y, 1.0);
}
`;
}
