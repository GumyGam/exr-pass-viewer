# exr-pass-viewer

A browser-only viewer for multilayer OpenEXR renders. Inspect passes, compare keyframes, isolate Cryptomatte segments — all in your browser, no install, no upload. Files never leave your machine.

**Live:** https://gumygam.github.io/exr-pass-viewer/

## Quick start

1. Open the link in **Chrome or Edge**.
2. Click **Open folder** and pick a folder containing `.exr` files.
3. Select one or more files in the tree to view them side by side.
4. Click a pass tab to switch the visualization. Use the search box to filter passes.

For Cryptomatte: click any pass whose name contains "crypto" — the panel turns into a picker. Click a region of the image and the matching object becomes a mask. Multiple clicks compose.

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
