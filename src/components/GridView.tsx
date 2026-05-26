import { useViewerStore } from '../store/viewerStore';
import { PanelTile } from './PanelTile';

function colsFor(n: number): string {
  if (n <= 1) return 'cols-1';
  if (n === 2) return 'cols-2';
  if (n <= 4) return 'cols-2';
  if (n <= 9) return 'cols-3';
  return 'cols-4';
}

export function GridView() {
  const selected = useViewerStore((s) => s.selectedFiles);
  if (selected.length === 0) {
    return (
      <div className="grid cols-1">
        <div className="panel">
          <div className="panel-body">
            <div className="panel-missing">select files to compare</div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={`grid ${colsFor(selected.length)}`}>
      {selected.map((f) => (
        <PanelTile key={f} file={f} />
      ))}
    </div>
  );
}
