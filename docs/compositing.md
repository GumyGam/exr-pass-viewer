# Compositing over beauty — AO, depth, and normal relight

This viewer can composite an **AO**, **Depth/Mist**, or **Normal** pass on top of a
beauty/HDR base, instead of rendering that pass standalone. Select the effect
pass as the active pass; a per-panel **"… · over beauty"** overlay then exposes a
toggle + controls. Everything below is per-panel state.

## Which passes each mode needs

| Mode (active pass)        | Maps consumed                                                            |
| ------------------------- | ------------------------------------------------------------------------ |
| **AO · over beauty**      | AO / "ambient occlusion" pass **+** an HDR base                          |
| **Depth focus**           | Depth or Mist pass **+** an HDR base                                     |
| **Relight — directional** | Normal pass **+** an HDR base                                            |
| **Relight — point (3D)**  | Normal **+** HDR base **+** **Position** (exact) *or* **Depth** (w/ FOV) |

**Base resolution.** The base is auto-picked from the file's HDR passes in the
order `Combined > Beauty > other HDR`, with a clean (non-`*_Noisy`) pass
preferred. Override it in the `base` dropdown. If the file has no HDR pass, the
composite toggle is disabled.

**Detection.** AO matches an `occlusion` substring or a standalone `AO` token;
depth matches `depth` or `mist`; normal is the NRM family. The aux pass for
point relight is the first Position-family pass, else a depth pass.

## Blend space

Blends are **display-space** (comp-style): the beauty base is tonemapped first
(exposure → sRGB / `pow(1/gamma)`), then the effect is applied. This matches a
Photoshop/After Effects "multiply layer" mental model and keeps exposure/gamma
sliders live.

```
beauty = tonemap(base_rgb, exposure, gamma)
```

## AO multiply

```
aoVal = invert ? (1 - ao) : ao
out   = beauty * mix(1.0, aoVal, strength)        // strength 0..2
```

`strength` 1 = a true multiply (`beauty * ao`); 0 = beauty untouched; >1
overdrives the darkening to make contact/occlusion pop for QA.

## Depth focus band

Depth is percentile-normalized to `[0,1]` (2nd–98th, inf ignored).

```
d   = clamp((depth - lo) / (hi - lo), 0, 1)
m   = 1 - smoothstep(0, width, |d - focus|)       // 1 in focus -> 0 outside
out = beauty * mix(dim, 1.0, m)
```

`focus` is the depth plane to keep sharp, `width` the band thickness/falloff,
`dim` how dark out-of-focus pixels go (0 = black isolation, ~0.15 = faint
context).

## Normal relight

`N` is taken from the normal pass (raw, normalized). `shade` modulates either a
neutral clay grey (`clay`, for geometry QA) or the beauty (`modulate`).

```
shade = ambient + (1 - ambient) * lambert
out   = mode == modulate ? beauty * shade : vec3(0.7) * shade
```

### Directional

A single global light direction (same `L` everywhere):

```
L       = dir(azimuth, elevation)
lambert = max(dot(N, L), 0)
```

Aim it with the clay-sphere widget (front hemisphere) or by dragging the image
(full sphere, incl. behind for rim light).

### Point (3D)

A point light at a 3D position, so `L` and distance vary per pixel and forms
wrap. Per-pixel surface position `P` is either read from a **Position pass**
(exact) or reconstructed from **depth + FOV**:

```
// depth reconstruction (view space, camera at origin, -Z forward)
ndc = (uv * 2 - 1)                                // y flipped to +up
P   = vec3(ndc.x * tanHalfFovX, ndc.y * tanHalfFovY, -1) * depth
```

The light is anchored to a clicked surface point and offset along that pixel's
normal — space-agnostic, no camera matrix needed:

```
P_light = P_anchor + N_anchor * height
toL     = P_light - P;  d = |toL|;  L = toL / d
lambert = max(dot(N, L), 0)
atten   = (clamp(1 - d / range, 0, 1))^2
shade   = ambient + (1 - ambient) * lambert * atten * intensity
```

`height` and `range` are auto-scaled to the scene's depth/position extent so the
sliders read sensibly regardless of scene units. The CPU anchor reconstruction
uses the exact same pinhole math as the shader (texel-center NDC), so the light
sits where the shader reconstructs that pixel.

## Position vs depth for 3D relight

**Position is exact; depth is an approximation.** Position gives the real 3D
point per pixel — correct distance, wrap, and falloff with no assumptions. Depth
must reconstruct position from a single distance value plus an assumed camera
FOV (a guess if it's not in the file), so a wrong FOV warps the lighting. This
mirrors the standard postproduction approach: comp relighting is done
deferred-shading style from a **Position (P) + Normal (N)** AOV pair (Nuke
Relight / pPointLight, etc.); depth-only relight is the fallback when there's no
Position pass.

## Gestures

- **Pan** — left-drag (image), **wheel** — zoom.
- **Relight directional** — left-drag aims the light; pan moves to **space-drag
  or middle-drag**.
- **Relight point** — left-drag moves the light anchor; pan moves to
  **space-drag or middle-drag**.
- The on-image ring marks the point-light anchor.
