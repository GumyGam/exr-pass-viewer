import { useEffect, useRef, useState } from 'react';
import { getPassMetadata } from './api/local';
import { ComparePanel } from './components/ComparePanel';
import { PassTabs } from './components/PassTabs';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { fsAccessSupported } from './fs/walker';
import { useMergedPasses, useViewerStore } from './store/viewerStore';

export function App() {
  const setBackendStatus = useViewerStore((s) => s.setBackendStatus);
  const selectedFiles = useViewerStore((s) => s.selectedFiles);
  const setFilePasses = useViewerStore((s) => s.setFilePasses);
  const removeFilePasses = useViewerStore((s) => s.removeFilePasses);
  const backendStatus = useViewerStore((s) => s.backendStatus);
  const activePass = useViewerStore((s) => s.activePass);
  const cryptoPicks = useViewerStore((s) => s.cryptoPicks);
  const clearCryptoPicks = useViewerStore((s) => s.clearCryptoPicks);
  const merged = useMergedPasses();

  // FS Access support is required. There is no fallback to <input
  // webkitdirectory> — we need the FileSystemFileHandle to read bytes lazily
  // per panel, and webkitdirectory pre-loads every File at picker time which
  // OOMs on large EXR libraries.
  const [supported] = useState(() => fsAccessSupported());

  // Boot status reflects FS Access availability rather than HTTP reachability.
  // Calls go through src/api/local.ts; see that file for the decoder bridge.
  useEffect(() => {
    setBackendStatus(supported ? 'ok' : 'down');
  }, [setBackendStatus, supported]);

  // Drop any in-flight Cryptomatte picks when the active pass leaves the CRY
  // family — otherwise picks would leak into the next pass's render request.
  useEffect(() => {
    if (cryptoPicks.length === 0) return;
    const m = merged.find((p) => p.display_name === activePass);
    if (!m || m.family !== 'CRY') clearCryptoPicks();
  }, [activePass, merged, cryptoPicks.length, clearCryptoPicks]);

  // Pull per-file pass metadata as the selection set changes. Files no
  // longer selected are evicted from the store so panels in other modes
  // don't see stale data.
  //
  // `kickedRef` tracks which files have already had a load kicked.
  // Critically, `passesByFile` is NOT in the dep array: previously the
  // effect re-ran after every `setFilePasses`, and under StrictMode
  // double-invoke the initial render queued each file's read twice,
  // OOM-failing all but the first. With kickedRef the load loop is
  // idempotent under both StrictMode double-invoke and selection
  // re-renders.
  const kickedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (backendStatus !== 'ok') return;
    const selectedSet = new Set(selectedFiles);
    // Drop files no longer selected from both the store and the kicked set.
    for (const previouslyKicked of [...kickedRef.current]) {
      if (!selectedSet.has(previouslyKicked)) {
        removeFilePasses(previouslyKicked);
        kickedRef.current.delete(previouslyKicked);
      }
    }
    // Kick a load for every newly-selected file we haven't already kicked.
    for (const file of selectedFiles) {
      if (kickedRef.current.has(file)) continue;
      kickedRef.current.add(file);
      getPassMetadata(file)
        .then((meta) => setFilePasses(file, meta))
        .catch((err: unknown) => {
          console.error('[exr-pass-viewer] getPassMetadata failed for', file, err);
          // Permit a retry next time the selection mutates.
          kickedRef.current.delete(file);
        });
    }
  }, [selectedFiles, setFilePasses, removeFilePasses, backendStatus]);

  if (!supported) {
    return (
      <div className="unsupported">
        <div className="unsupported-card">
          <h1>Unsupported browser</h1>
          <p>
            This viewer needs Chrome or Edge. The File System Access API isn't
            available in your browser.
          </p>
          <p>
            Try Chrome 86+ or Edge 86+ on desktop. Your files never leave your
            machine — the picker just lets the page read EXRs directly.
          </p>
          <p className="hint">window.showDirectoryPicker is undefined</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="menubar">
        <div className="brand">
          <div className="brand-mark" />
          EXR Pass Viewer
        </div>
        <div className="menubar-spacer" />
        <div className="session-pill">
          <span className={`dot ${backendStatus === 'ok' ? '' : backendStatus === 'down' ? 'err' : 'warn'}`} />
          session ·{' '}
          {backendStatus === 'ok'
            ? 'ready'
            : backendStatus === 'down'
              ? 'unsupported'
              : 'starting…'}
        </div>
      </div>

      <Toolbar />
      <PassTabs />

      <div className="body">
        <Sidebar />
        <ComparePanel />
      </div>

      <StatusBar />
    </div>
  );
}
