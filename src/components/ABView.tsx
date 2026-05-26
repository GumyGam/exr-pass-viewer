import { useRef } from 'react';
import { useViewerStore } from '../store/viewerStore';
import { PanelTile } from './PanelTile';

export function ABView() {
  const selected = useViewerStore((s) => s.selectedFiles);
  const split = useViewerStore((s) => s.abSplit);
  const setSplit = useViewerStore((s) => s.setAbSplit);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef(false);

  if (selected.length !== 2) {
    return (
      <div className="ab-wrap">
        <div className="panel-missing">A-B requires exactly 2 selected files</div>
      </div>
    );
  }

  const [a, b] = selected;

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = true;
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setSplit(pct);
  };
  const onUp = () => {
    dragRef.current = false;
  };

  return (
    <div
      className="ab-wrap"
      ref={wrapRef}
      style={{ ['--ab-split' as string]: `${split}%` } as React.CSSProperties}
    >
      <div className="ab-side a">
        <PanelTile file={a!} />
      </div>
      <div className="ab-side b">
        <PanelTile file={b!} />
      </div>
      <div
        className="ab-divider"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      />
    </div>
  );
}
