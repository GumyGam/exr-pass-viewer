import { useEffect, useState } from 'react';
import { registerFile, resetRegistry } from '../api/local';
import type { TreeNode } from '../fs/types';
import { collectFiles, pickFolder, walkDirectory } from '../fs/walker';
import { useViewerStore } from '../store/viewerStore';
import { FolderTree } from './FolderTree';

export function Sidebar() {
  const rootHandle = useViewerStore((s) => s.rootHandle);
  const setRootHandle = useViewerStore((s) => s.setRootHandle);
  const clearSelection = useViewerStore((s) => s.clearSelection);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Walk the directory whenever the root handle changes. The walker traverses
  // the FS Access tree, prunes to .exr-bearing branches, and resolves a File
  // for each leaf — we register those File objects with the local-API bridge
  // so panels can later read bytes by synthetic path.
  useEffect(() => {
    let cancelled = false;
    if (!rootHandle) {
      setTree(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    walkDirectory(rootHandle)
      .then((t) => {
        if (cancelled) return;
        // Wipe the registry from any prior root before populating the new one.
        resetRegistry();
        for (const f of collectFiles(t)) {
          registerFile(f.path, f.file);
        }
        setTree(t);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError((e as Error).message);
        setTree(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rootHandle]);

  const pick = async () => {
    setError(null);
    try {
      const h = await pickFolder();
      if (!h) return; // user cancelled
      clearSelection();
      setRootHandle(h);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-label">Folder</div>
        <div className="path-row">
          <input
            className="path-input"
            spellCheck={false}
            readOnly
            value={rootHandle?.name ?? ''}
            placeholder="No folder picked"
          />
          <button
            className="path-pick"
            title="Pick folder…"
            onClick={pick}
            type="button"
          >
            …
          </button>
        </div>
      </div>
      <div
        className="sidebar-section"
        style={{ borderBottom: 'none', paddingBottom: 4, flex: 1, overflowY: 'auto' }}
      >
        {loading && <div className="tree-empty">Scanning…</div>}
        {!loading && error && <div className="tree-empty">{error}</div>}
        {!loading && !error && !rootHandle && (
          <div className="tree-empty">Click the picker above to open a folder.</div>
        )}
        {!loading && !error && rootHandle && <FolderTree tree={tree} />}
      </div>
    </aside>
  );
}
