import { useMergedPasses, useViewerStore } from '../store/viewerStore';
import { ABView } from './ABView';
import { DiffView } from './DiffView';
import { GridView } from './GridView';

export function ComparePanel() {
  const mode = useViewerStore((s) => s.compareMode);
  const activePass = useViewerStore((s) => s.activePass);
  const merged = useMergedPasses();

  const activeMeta = merged.find((p) => p.display_name === activePass);

  return (
    <main className="main">
      <div className="grid-header">
        <span>Active pass</span>
        <span className="active-pass">{activePass ?? '—'}</span>
        <span className="pass-meta">
          {activeMeta
            ? `${activeMeta.family.toLowerCase()} · default viz: ${activeMeta.viz_default}`
            : 'no pass selected'}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-3)' }} className="mono">
          mode: {mode}
        </span>
      </div>
      {mode === 'grid' && <GridView />}
      {mode === 'ab' && <ABView />}
      {mode === 'diff' && <DiffView />}
    </main>
  );
}
