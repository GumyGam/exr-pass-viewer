# exr-pass-viewer

A browser-only viewer for multilayer OpenEXR renders. Inspect passes, compare keyframes, isolate Cryptomatte segments — all in your browser, no install, no upload. Files never leave your machine.

**Live:** https://gumygam.github.io/exr-pass-viewer/

## Quick start

1. Open the link in **Chrome or Edge**.
2. Click **Open folder** and pick a folder containing `.exr` files.
3. Select one or more files in the tree to view them side by side.
4. Click a pass tab to switch the visualization. Use the search box to filter passes.

For Cryptomatte: click any pass whose name contains "crypto" — the panel turns into a picker. Click a region of the image and the matching object becomes a mask. Multiple clicks compose.

## Compositing over beauty (AO · depth · normal)

When you select an **AO**, **Depth/Mist**, or **Normal** pass, a per-panel **"… · over beauty"** overlay lets you composite that pass on top of a beauty/HDR base (auto-picked `Combined > Beauty > other HDR`, overridable in the `base` dropdown). All blends happen in display space, so your exposure/gamma stay live on the base. Settings are per-panel.

- **AO** — multiply over beauty. `strength` 0–2 (values >1 overdrive past a true multiply to make contact pop) + `invert` for occlusion-style passes.
- **Depth / Mist** — focus band: pick a `focus` depth (0–1, percentile-normalized), a `width`, and a `dim` floor. In-focus pixels stay sharp; everything else fades toward the dim floor.
- **Normal — relight** — `clay` (neutral grey, for geometry/normal QA) or `modulate` (relight the actual beauty), with a movable light:
  - **directional** — drag the **clay sphere widget** (or the image) to aim the light. The sphere previews the lighting and covers the front hemisphere; image-drag can push the light behind for rim/back light.
  - **point (3D)** — a true point light placed in 3D. **Click/drag the image to anchor** the light to a surface; `height` lifts it off along that surface's normal; `range` + `intensity` shape the falloff. Per-pixel position comes from a **Position pass** (exact) or is reconstructed from a **Depth pass + an FOV slider** (approximate) — the overlay tells you which it's using.

Pan = left-drag, zoom = wheel. In relight, left-drag aims/places the light, so panning moves to **space-drag or middle-drag**.

See [docs/compositing.md](docs/compositing.md) for the blend math and which passes each mode needs.

## Why Chrome / Edge only

The viewer uses the File System Access API to read your folder directly without uploading anything. Firefox and Safari don't support it yet.

## Building locally

```
pnpm install
pnpm dev
```

Open http://localhost:5173/exr-pass-viewer/.

## License

MIT.
