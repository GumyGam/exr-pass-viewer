import { useMergedPasses, useViewerStore } from '../store/viewerStore';

export function StatusBar() {
  const backendStatus = useViewerStore((s) => s.backendStatus);
  const backendVersion = useViewerStore((s) => s.backendVersion);
  const selectedCount = useViewerStore((s) => s.selectedFiles.length);
  const passesByFile = useViewerStore((s) => s.passesByFile);
  const activePass = useViewerStore((s) => s.activePass);
  const merged = useMergedPasses();

  const totalFiles = Object.keys(passesByFile).length;
  const activeMeta = merged.find((p) => p.display_name === activePass);

  const statusLabel =
    backendStatus === 'ok'
      ? 'in-browser · ready'
      : backendStatus === 'down'
        ? 'browser unsupported'
        : 'initializing…';

  const dotClass =
    backendStatus === 'ok' ? '' : backendStatus === 'down' ? 'err' : 'warn';

  return (
    <div className="status">
      <div className="status-item">
        <span className={`dot ${dotClass}`} />
        <span className="k">runtime</span>
        {statusLabel}
      </div>
      <div className="status-item">
        <span className="k">files</span>
        {totalFiles} loaded · {selectedCount} selected
      </div>
      <div className="status-item">
        <span className="k">cache</span>
        in-memory (worker pool)
      </div>
      <div className="status-spacer" />
      {activeMeta && (
        <div className="status-item">
          <span className="k">pass</span>
          {activeMeta.display_name} · {activeMeta.family.toLowerCase()}
        </div>
      )}
      <div className="status-item">
        <span className="k">ver</span>
        v0.1.0{backendVersion ? ` · ${backendVersion}` : ''}
      </div>
    </div>
  );
}
