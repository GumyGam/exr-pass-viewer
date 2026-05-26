import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import * as local from './api/local';
import { useViewerStore } from './store/viewerStore';
import './theme.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');

// Dev-only hook: expose the app's actual local-API and store on `window` so
// Playwright probes (and DevTools poking) hit the same module instances the
// React tree uses. Production builds strip this branch (Vite tree-shakes
// `import.meta.env.DEV === false`).
if (import.meta.env.DEV) {
  (window as unknown as { __exr?: unknown }).__exr = { local, store: useViewerStore };
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
