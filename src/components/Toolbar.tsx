import { useViewerStore, type CompareMode } from '../store/viewerStore';

const MODES: { id: CompareMode; label: string }[] = [
  { id: 'grid', label: 'Grid' },
  { id: 'ab', label: 'A-B' },
  { id: 'diff', label: 'Diff' },
];

export function Toolbar() {
  const compareMode = useViewerStore((s) => s.compareMode);
  const setCompareMode = useViewerStore((s) => s.setCompareMode);
  const selectedCount = useViewerStore((s) => s.selectedFiles.length);

  const dualLocked = selectedCount !== 2;

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        {MODES.map((m) => {
          const disabled = (m.id === 'ab' || m.id === 'diff') && dualLocked;
          return (
            <button
              key={m.id}
              className={`seg ${compareMode === m.id ? 'active' : ''}`}
              onClick={() => !disabled && setCompareMode(m.id)}
              disabled={disabled}
              title={disabled ? 'Requires exactly 2 selected files' : ''}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      <div className="toolbar-spacer" />

      <div className="chip">
        <span className="chip-num mono">{selectedCount}</span> selected
      </div>
    </div>
  );
}
