import { useEffect, useMemo, useRef, useState } from 'react';
import { renderPassToCanvas } from '../api/local';
import { useMergedPasses, useViewerStore } from '../store/viewerStore';
import { basename, formatScale, sceneName } from '../utils/format';
import { transformStyle, zoomAt } from '../utils/panZoom';

const RENDER_MAX_WIDTH = 1600;

type Stage =
  | { kind: 'idle' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export function DiffView() {
  const selected = useViewerStore((s) => s.selectedFiles);
  const activePass = useViewerStore((s) => s.activePass);
  const exposure = useViewerStore((s) => s.exposure);
  const gamma = useViewerStore((s) => s.gamma);
  const merged = useMergedPasses();
  const passesByFile = useViewerStore((s) => s.passesByFile);
  const panZoom = useViewerStore((s) => s.panZoom);
  const setPanZoom = useViewerStore((s) => s.setPanZoom);

  const passMatch = useMemo(() => {
    if (!activePass) return null;
    const m = merged.find((p) => p.display_name === activePass);
    if (!m) return null;
    if (selected.length !== 2) return null;
    const [a, b] = selected;
    const ra = m.rawNames.get(a!);
    const rb = m.rawNames.get(b!);
    if (!ra || !rb) return null;
    const dataA = passesByFile[a!];
    const dataB = passesByFile[b!];
    const passA = dataA?.passes.find((p) => p.name === ra);
    const passB = dataB?.passes.find((p) => p.name === rb);
    if (!passA || !passB) return null;
    return { a: a!, b: b!, passA, passB };
  }, [merged, activePass, selected, passesByFile]);

  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!passMatch) {
      setStage({ kind: 'idle' });
      return;
    }
    setStage({ kind: 'idle' });
    let cancelled = false;

    (async () => {
      try {
        // Render both panels at the same tonemap. There is no "server-diff"
        // path in the browser build — we always diff on the main thread.
        const [bitmapA, bitmapB] = await Promise.all([
          renderPassToCanvas(passMatch.a, passMatch.passA, {
            viz: 'tonemap',
            exposure,
            gamma,
            maxWidth: RENDER_MAX_WIDTH,
          }),
          renderPassToCanvas(passMatch.b, passMatch.passB, {
            viz: 'tonemap',
            exposure,
            gamma,
            maxWidth: RENDER_MAX_WIDTH,
          }),
        ]);
        if (cancelled) {
          bitmapA.close?.();
          bitmapB.close?.();
          return;
        }
        const w = Math.min(bitmapA.width, bitmapB.width);
        const h = Math.min(bitmapA.height, bitmapB.height);
        const canvas = canvasRef.current;
        if (!canvas) {
          bitmapA.close?.();
          bitmapB.close?.();
          return;
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setStage({ kind: 'error', message: 'canvas 2d unavailable' });
          return;
        }
        ctx.drawImage(bitmapA, 0, 0, w, h);
        const a = ctx.getImageData(0, 0, w, h);
        ctx.drawImage(bitmapB, 0, 0, w, h);
        const b = ctx.getImageData(0, 0, w, h);
        bitmapA.close?.();
        bitmapB.close?.();
        const out = ctx.createImageData(w, h);
        for (let i = 0; i < a.data.length; i += 4) {
          const dr = Math.abs(a.data[i]! - b.data[i]!);
          const dg = Math.abs(a.data[i + 1]! - b.data[i + 1]!);
          const db = Math.abs(a.data[i + 2]! - b.data[i + 2]!);
          const mag = Math.min(255, dr + dg + db);
          out.data[i] = mag;
          out.data[i + 1] = Math.floor(mag * 0.3);
          out.data[i + 2] = Math.max(0, 80 - mag);
          out.data[i + 3] = 255;
        }
        ctx.putImageData(out, 0, 0);
        if (!cancelled) setStage({ kind: 'ready' });
      } catch (e) {
        if (!cancelled) setStage({ kind: 'error', message: (e as Error).message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [passMatch, exposure, gamma]);

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setPanZoom(zoomAt(panZoom, cx, cy, factor));
  };

  if (selected.length !== 2) {
    return (
      <div className="ab-wrap">
        <div className="panel-missing">Diff requires exactly 2 selected files</div>
      </div>
    );
  }

  return (
    <div className="grid cols-1">
      <div className="panel">
        <div className="panel-head">
          <div className="panel-label">
            <span className="scene">
              {sceneName(passMatch?.a ?? selected[0]!)} / {basename(passMatch?.a ?? selected[0]!)}
            </span>{' '}
            ⇔{' '}
            <span className="scene">
              {sceneName(passMatch?.b ?? selected[1]!)} / {basename(passMatch?.b ?? selected[1]!)}
            </span>
          </div>
          <div className="panel-corner" style={{ position: 'static' }}>
            {stage.kind === 'ready' ? 'client diff' : stage.kind === 'error' ? 'error' : '—'}
          </div>
        </div>
        <div className="panel-body" ref={bodyRef} onWheel={onWheel}>
          {!passMatch && <div className="panel-missing">pass not present in both files</div>}
          {stage.kind === 'error' && <div className="panel-error">{stage.message}</div>}
          <canvas
            ref={canvasRef}
            className="panel-img"
            style={{
              transform: `translate(-50%, -50%) ${transformStyle(panZoom)}`,
              display: stage.kind === 'ready' ? 'block' : 'none',
              imageRendering: 'pixelated',
            }}
          />
          <div className="panel-corner">{formatScale(panZoom.scale)} · fit</div>
        </div>
      </div>
    </div>
  );
}
