import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Base path matches the GitHub Pages URL: gumygam.github.io/exr-pass-viewer/
export default defineConfig({
  base: '/exr-pass-viewer/',
  plugins: [react()],
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      // SharedArrayBuffer needs cross-origin isolation; tinyexr WASM may use threads later.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
