import { useEffect, useMemo, useRef, useState } from 'react';
import {
  pickAtPixel,
  pixelValues,
  renderCompositeToCanvas,
  renderCryptoMask,
  renderPassToCanvas,
} from '../api/local';
import { compositeKindFor, resolveBeautyBase } from '../exr/passes';
import {
  DEFAULT_COMPOSITE,
  lightDirFromAngles,
  useMergedPasses,
  useViewerStore,
} from '../store/viewerStore';
import { basename, formatFloat, formatScale, sceneName } from '../utils/format';
import { transformStyle, zoomAt } from '../utils/panZoom';

const RENDER_MAX_WIDTH = 1600;
const DEBOUNCE_MS = 150;
const PIXEL_DEBOUNCE_MS = 100;
const CHIP_OFFSET = 14;

type ImgState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; w: number; h: number }
  | { kind: 'error'; message: string };

export function PanelTile({ file }: { file: string }) {
  const merged = useMergedPasses();
  const activePass = useViewerStore((s) => s.activePass);
  const exposure = useViewerStore((s) => s.exposure);
  const gamma = useViewerStore((s) => s.gamma);
  const passesData = useViewerStore((s) => s.passesByFile[file]);
  const fileStatus = useViewerStore((s) => s.fileStatus[file]);
  const focusedFile = useViewerStore((s) => s.focusedFile);
  const setFocusedFile = useViewerStore((s) => s.setFocusedFile);
  const setHoverPixel = useViewerStore((s) => s.setHoverPixel);
  const hoverPixel = useViewerStore((s) => s.hoverPixel);
  const setPixelInfo = useViewerStore((s) => s.setPixelInfo);
  const pixelInfo = useViewerStore((s) => s.pixelInfo);
  const panZoom = useViewerStore((s) => s.panZoom);
  const setPanZoom = useViewerStore((s) => s.setPanZoom);
  const resetPanZoom = useViewerStore((s) => s.resetPanZoom);

  const cryptoPicks = useViewerStore((s) => s.cryptoPicks);
  const toggleCryptoPick = useViewerStore((s) => s.toggleCryptoPick);
  const clearCryptoPicks = useViewerStore((s) => s.clearCryptoPicks);

  const composite = useViewerStore((s) => s.compositeByFile[file]) ?? DEFAULT_COMPOSITE;
  const setComposite = useViewerStore((s) => s.setComposite);

  const passInfo = useMemo(() => {
    if (!activePass) return null;
    const m = merged.find((p) => p.display_name === activePass);
    if (!m) return null;
    const rawName = m.rawNames.get(file);
    if (!rawName) return null;
    return { rawName, family: m.family, vizDefault: m.viz_default };
  }, [merged, activePass, file]);

  const isCrypto = passInfo?.family === 'CRY';
  const cryptoMaskActive = isCrypto && cryptoPicks.length > 0;

  // The full PassInfo for this file's view of the active pass.
  const localPass = useMemo(() => {
    if (!passInfo || !passesData) return null;
    return passesData.passes.find((p) => p.name === passInfo.rawName) ?? null;
  }, [passInfo, passesData]);

  const passComponents = localPass?.components ?? [];
  const viz = passInfo?.vizDefault ?? 'tonemap';

  // Composite-over-beauty: which kind (if any) the active pass supports, the
  // auto-resolved beauty base, and the file-local PassInfo for the chosen base.
  const compositeKind =
    activePass && passInfo
      ? compositeKindFor({ display_name: activePass, family: passInfo.family })
      : null;
  // Base candidates are this file's own HDR passes (compositing is per-file),
  // so the dropdown can never offer a base that isn't present here.
  const hdrPasses = useMemo(
    () => (passesData?.passes ?? []).filter((p) => p.family === 'HDR'),
    [passesData],
  );
  const autoBase = useMemo(() => resolveBeautyBase(passesData?.passes ?? []), [passesData]);
  const baseName = composite.base ?? autoBase;
  const basePass = useMemo(() => {
    if (!baseName || !passesData) return null;
    return passesData.passes.find((p) => p.display_name === baseName) ?? null;
  }, [baseName, passesData]);
  const compositeActive = !!compositeKind && composite.enabled && !!basePass && !!localPass;
  const relightActive = compositeKind === 'normal' && composite.enabled;

  const [img, setImg] = useState<ImgState>({ kind: 'idle' });
  const [chipPos, setChipPos] = useState<{ x: number; y: number } | null>(null);
  const debounceRef = useRef<number | null>(null);
  const pixelDebounceRef = useRef<number | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; px: number; py: number; moved: boolean } | null>(null);
  // Active relight light-aim drag (normal composite mode). Holds the gesture
  // start + the azimuth/elevation at grab time.
  const lightDragRef = useRef<{ startX: number; startY: number; az: number; el: number } | null>(null);
  // Spacebar-held flag — lets space+drag pan while left-drag aims the light.
  const spaceRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgNaturalRef = useRef<{ w: number; h: number } | null>(null);
  // Keep latest panZoom in a ref so the native wheel listener doesn't get a stale closure.
  const panZoomRef = useRef(panZoom);
  useEffect(() => {
    panZoomRef.current = panZoom;
  }, [panZoom]);

  // Track spacebar so space+drag pans while left-drag aims the relight light.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Render the active pass / mask / composite into the panel's <canvas>.
  // Standalone renders are debounced (150ms) so slider drags don't queue a
  // dozen WebGL jobs; composite renders coalesce on requestAnimationFrame
  // instead so the relight light-drag and depth-focus scrub feel live (channel
  // arrays are already worker-cached, so each frame just re-uploads + draws).
  // Cancellation is by `cancelled` flag — an outdated job's bitmap is dropped.
  useEffect(() => {
    if (!passInfo || !activePass || !localPass) {
      setImg({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    // Composite re-renders coalesce on rAF during light-drag / focus-scrub —
    // don't flip to the 'loading' state each frame (it would blank the canvas).
    // Keep the prior frame visible and let the next bitmap swap in.
    if (!compositeActive) setImg({ kind: 'loading' });

    const run = () => {
      let job: Promise<ImageBitmap>;
      if (compositeActive && basePass && compositeKind) {
        job = renderCompositeToCanvas(file, basePass, localPass, {
          kind: compositeKind,
          exposure,
          gamma,
          maxWidth: RENDER_MAX_WIDTH,
          aoStrength: composite.aoStrength,
          aoInvert: composite.aoInvert,
          depthFocus: composite.depthFocus,
          depthWidth: composite.depthWidth,
          depthDim: composite.depthDim,
          lightDir: lightDirFromAngles(composite.lightAzimuth, composite.lightElevation),
          ambient: composite.ambient,
          normalMode: composite.normalMode,
        });
      } else if (cryptoMaskActive) {
        job = renderCryptoMask(file, localPass, cryptoPicks.map((p) => p.hash_hex), {
          maxWidth: RENDER_MAX_WIDTH,
        });
      } else {
        job = renderPassToCanvas(file, localPass, { viz, exposure, gamma, maxWidth: RENDER_MAX_WIDTH });
      }
      job
        .then((bitmap) => {
          if (cancelled) {
            bitmap.close?.();
            return;
          }
          const canvas = canvasRef.current;
          if (!canvas) {
            bitmap.close?.();
            return;
          }
          const w = bitmap.width;
          const h = bitmap.height;
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('bitmaprenderer');
          if (ctx) {
            ctx.transferFromImageBitmap(bitmap);
          } else {
            const ctx2d = canvas.getContext('2d');
            if (!ctx2d) {
              setImg({ kind: 'error', message: 'canvas 2d unavailable' });
              return;
            }
            ctx2d.drawImage(bitmap, 0, 0);
            bitmap.close?.();
          }
          imgNaturalRef.current = { w, h };
          setImg({ kind: 'ready', w, h });
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setImg({ kind: 'error', message: (e as Error).message || 'render failed' });
        });
    };

    if (compositeActive) {
      const raf = requestAnimationFrame(run);
      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
      };
    }
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(run, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [
    file,
    activePass,
    localPass,
    passInfo,
    viz,
    exposure,
    gamma,
    cryptoMaskActive,
    cryptoPicks,
    compositeActive,
    compositeKind,
    basePass,
    composite,
  ]);

  // Native wheel listener (passive: false) — React's synthetic wheel handler is
  // passive in React 17+, so e.preventDefault() inside onWheel silently fails
  // and the parent surface can intercept the scroll. Attaching at the DOM level
  // lets us pin the wheel to zoom-only.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setPanZoom(zoomAt(panZoomRef.current, cx, cy, factor));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [setPanZoom]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Middle button or space-held always pans. In relight mode, plain left-drag
    // aims the light instead.
    if (e.button !== 0 && e.button !== 1) return;
    // Ignore presses that land on the floating controls (composite panel /
    // crypto picker) — otherwise dragging a slider would also aim the light or
    // start a pan, and could strand the gesture ref.
    if ((e.target as HTMLElement).closest('.composite-panel, .crypto-picker')) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const wantPan = e.button === 1 || spaceRef.current || !relightActive;
    if (!wantPan && e.button === 0) {
      lightDragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        az: composite.lightAzimuth,
        el: composite.lightElevation,
      };
      return;
    }
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      px: panZoom.x,
      py: panZoom.y,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (lightDragRef.current) {
      const d = lightDragRef.current;
      // Drag right -> sweep azimuth; drag up -> raise elevation. ~0.5°/px.
      const az = d.az + (e.clientX - d.startX) * 0.5;
      const el = Math.max(-90, Math.min(90, d.el - (e.clientY - d.startY) * 0.5));
      setComposite(file, { lightAzimuth: az, lightElevation: el });
      return;
    }
    if (dragRef.current) {
      const d = dragRef.current;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      setPanZoom({
        scale: panZoomRef.current.scale,
        x: d.px + dx,
        y: d.py + dy,
      });
      return;
    }
    const body = bodyRef.current;
    const nat = imgNaturalRef.current;
    if (!body || !nat || img.kind !== 'ready') return;
    const rect = body.getBoundingClientRect();
    setChipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (focusedFile !== file) return;
    // The hover chip is suppressed on Crypto passes — picking takes over there.
    if (isCrypto) return;
    if (!localPass) return;
    const localX = e.clientX - rect.left - rect.width / 2 - panZoom.x;
    const localY = e.clientY - rect.top - rect.height / 2 - panZoom.y;
    const fitScale = Math.min(rect.width / nat.w, rect.height / nat.h);
    const effectiveScale = fitScale * panZoom.scale;
    const px = Math.round(localX / effectiveScale + nat.w / 2);
    const py = Math.round(localY / effectiveScale + nat.h / 2);
    if (px < 0 || py < 0 || px >= nat.w || py >= nat.h) {
      setHoverPixel(null);
      return;
    }
    // The rendered bitmap is scaled to RENDER_MAX_WIDTH; the EXR is native res.
    // Map image-pixel coords up to the EXR coordinate system before sampling.
    const exrW = passesData?.width ?? nat.w;
    const exrH = passesData?.height ?? nat.h;
    const exrX = Math.min(exrW - 1, Math.round((px / nat.w) * exrW));
    const exrY = Math.min(exrH - 1, Math.round((py / nat.h) * exrH));
    setHoverPixel({ x: exrX, y: exrY });
    if (pixelDebounceRef.current !== null) window.clearTimeout(pixelDebounceRef.current);
    pixelDebounceRef.current = window.setTimeout(() => {
      pixelValues(file, localPass, exrX, exrY)
        .then((values) => setPixelInfo({ file, x: exrX, y: exrY, values }))
        .catch(() => {
          /* swallow pixel-fetch failures — non-fatal for the UI */
        });
    }, PIXEL_DEBOUNCE_MS);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (lightDragRef.current) {
      lightDragRef.current = null;
      return;
    }
    const d = dragRef.current;
    dragRef.current = null;
    // Treat a near-zero-movement press-release as a click. On Crypto passes,
    // resolve the click to the underlying image pixel and ask local.ts what's
    // there; toggle the top candidate into the global pick set.
    if (!d || d.moved || !isCrypto || !localPass) return;
    const body = bodyRef.current;
    const nat = imgNaturalRef.current;
    if (!body || !nat) return;
    const rect = body.getBoundingClientRect();
    const localX = e.clientX - rect.left - rect.width / 2 - panZoomRef.current.x;
    const localY = e.clientY - rect.top - rect.height / 2 - panZoomRef.current.y;
    const fitScale = Math.min(rect.width / nat.w, rect.height / nat.h);
    const effectiveScale = fitScale * panZoomRef.current.scale;
    const px = Math.round(localX / effectiveScale + nat.w / 2);
    const py = Math.round(localY / effectiveScale + nat.h / 2);
    if (px < 0 || py < 0 || px >= nat.w || py >= nat.h) return;
    // Scale rendered coords up to native EXR coords.
    const exrW = passesData?.width ?? nat.w;
    const exrH = passesData?.height ?? nat.h;
    const exrX = Math.min(exrW - 1, Math.round((px / nat.w) * exrW));
    const exrY = Math.min(exrH - 1, Math.round((py / nat.h) * exrH));
    pickAtPixel(file, localPass, exrX, exrY)
      .then((res) => {
        const top = res.candidates[0];
        if (top) toggleCryptoPick(top);
      })
      .catch(() => {
        /* pick failed — leave selection as-is */
      });
  };

  const onMouseEnter = () => {
    setFocusedFile(file);
  };

  const onMouseLeave = () => {
    setHoverPixel(null);
    setChipPos(null);
  };

  const passMissing = passesData && activePass && !passInfo;

  const showChip =
    !isCrypto &&
    focusedFile === file &&
    chipPos &&
    hoverPixel &&
    pixelInfo &&
    pixelInfo.file === file &&
    passInfo &&
    passComponents.length > 0;

  // Place the chip; flip across the cursor when it would overflow the panel.
  const chipStyle = (() => {
    if (!showChip || !bodyRef.current) return undefined;
    const rect = bodyRef.current.getBoundingClientRect();
    const W_GUESS = 200;
    const H_GUESS = 30 + passComponents.length * 16;
    let left = chipPos!.x + CHIP_OFFSET;
    let top = chipPos!.y + CHIP_OFFSET;
    if (left + W_GUESS > rect.width) left = chipPos!.x - CHIP_OFFSET - W_GUESS;
    if (top + H_GUESS > rect.height) top = chipPos!.y - CHIP_OFFSET - H_GUESS;
    return { left: Math.max(4, left), top: Math.max(4, top) } as const;
  })();

  return (
    <div
      className="panel"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={focusedFile === file ? { borderColor: 'var(--border-strong)' } : undefined}
    >
      <div className="panel-head">
        <div className="panel-label">
          <span className="scene">{sceneName(file) || '…'} /</span> {basename(file)}
        </div>
        <div className="panel-icons">
          <button className="panel-ico" title="Reset zoom" onClick={() => resetPanZoom()}>
            ⊙
          </button>
        </div>
      </div>
      <div
        ref={bodyRef}
        className={`panel-body ${dragRef.current ? 'dragging' : ''} ${isCrypto ? 'crypto-mode' : ''} ${relightActive ? 'relight-mode' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {!passesData && fileStatus?.kind === 'loading' && (
          <div className="panel-loading">loading file…</div>
        )}
        {!passesData && fileStatus?.kind === 'error' && (
          <div className="panel-error">load failed — {fileStatus.message}</div>
        )}
        {passMissing && <div className="panel-missing">pass not present</div>}
        {!passMissing && passesData && img.kind === 'loading' && (
          <div className="panel-loading">decoding…</div>
        )}
        {!passMissing && passesData && img.kind === 'error' && (
          <div className="panel-error">render failed — {img.message}</div>
        )}
        {!passMissing && (
          <canvas
            ref={canvasRef}
            className="panel-img"
            style={{
              transform: `translate(-50%, -50%) ${transformStyle(panZoom)}`,
              opacity: img.kind === 'ready' ? 1 : 0,
            }}
          />
        )}
        {passInfo && (
          <div className="panel-overlay">
            {passesData && (
              <div>
                <span className="lbl">RES</span> {passesData.width}×{passesData.height}
              </div>
            )}
            <div>
              <span className="lbl">VIZ</span> {viz}
            </div>
          </div>
        )}
        <div className="panel-corner">{formatScale(panZoom.scale)}</div>
        {isCrypto && (
          <div className="crypto-picker mono">
            <div className="crypto-picker-head">
              <span className="lbl">CRYPTO PICKS</span>
              {cryptoPicks.length > 0 && (
                <button className="crypto-clear" onClick={clearCryptoPicks}>
                  clear
                </button>
              )}
            </div>
            {cryptoPicks.length === 0 ? (
              <div className="crypto-hint">click the image to pick a segment</div>
            ) : (
              cryptoPicks.map((p) => (
                <div key={p.hash_hex} className="crypto-row">
                  <span className="crypto-name" title={`hash ${p.hash_hex}`}>
                    {p.name ?? `0x${p.hash_hex}`}
                  </span>
                  <button
                    className="crypto-x"
                    onClick={() => toggleCryptoPick(p)}
                    aria-label="remove pick"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        )}
        {compositeKind && (
          <div className="composite-panel mono">
            <label className="composite-toggle">
              <input
                type="checkbox"
                checked={composite.enabled}
                onChange={(e) => setComposite(file, { enabled: e.target.checked })}
              />
              <span className="lbl">
                {compositeKind === 'ao'
                  ? 'AO · OVER BEAUTY'
                  : compositeKind === 'depth'
                    ? 'DEPTH FOCUS · OVER BEAUTY'
                    : 'RELIGHT · OVER BEAUTY'}
              </span>
            </label>
            {composite.enabled &&
              (!basePass ? (
                <div className="composite-hint">no beauty / HDR pass to composite over</div>
              ) : (
                <>
                  <div className="composite-row">
                    <span className="composite-k">base</span>
                    <select
                      className="composite-sel"
                      value={baseName ?? ''}
                      onChange={(e) => setComposite(file, { base: e.target.value })}
                    >
                      {hdrPasses.map((p) => (
                        <option key={p.display_name} value={p.display_name}>
                          {p.display_name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {compositeKind === 'ao' && (
                    <>
                      <div className="composite-row">
                        <span className="composite-k">strength</span>
                        <input
                          type="range"
                          min={0}
                          max={2}
                          step={0.01}
                          value={composite.aoStrength}
                          onChange={(e) =>
                            setComposite(file, { aoStrength: e.target.valueAsNumber })
                          }
                        />
                        <span className="composite-v">{composite.aoStrength.toFixed(2)}</span>
                      </div>
                      <label className="composite-row composite-check">
                        <input
                          type="checkbox"
                          checked={composite.aoInvert}
                          onChange={(e) => setComposite(file, { aoInvert: e.target.checked })}
                        />
                        <span className="composite-k">invert</span>
                      </label>
                    </>
                  )}

                  {compositeKind === 'depth' && (
                    <>
                      <div className="composite-row">
                        <span className="composite-k">focus</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.005}
                          value={composite.depthFocus}
                          onChange={(e) =>
                            setComposite(file, { depthFocus: e.target.valueAsNumber })
                          }
                        />
                        <span className="composite-v">{composite.depthFocus.toFixed(2)}</span>
                      </div>
                      <div className="composite-row">
                        <span className="composite-k">width</span>
                        <input
                          type="range"
                          min={0.005}
                          max={0.5}
                          step={0.005}
                          value={composite.depthWidth}
                          onChange={(e) =>
                            setComposite(file, { depthWidth: e.target.valueAsNumber })
                          }
                        />
                        <span className="composite-v">{composite.depthWidth.toFixed(2)}</span>
                      </div>
                      <div className="composite-row">
                        <span className="composite-k">dim</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={composite.depthDim}
                          onChange={(e) =>
                            setComposite(file, { depthDim: e.target.valueAsNumber })
                          }
                        />
                        <span className="composite-v">{composite.depthDim.toFixed(2)}</span>
                      </div>
                    </>
                  )}

                  {compositeKind === 'normal' && (
                    <>
                      <div className="composite-row composite-modes">
                        <button
                          className={`composite-mode ${composite.normalMode === 'clay' ? 'on' : ''}`}
                          onClick={() => setComposite(file, { normalMode: 'clay' })}
                        >
                          clay
                        </button>
                        <button
                          className={`composite-mode ${composite.normalMode === 'modulate' ? 'on' : ''}`}
                          onClick={() => setComposite(file, { normalMode: 'modulate' })}
                        >
                          modulate
                        </button>
                      </div>
                      <div className="composite-row">
                        <span className="composite-k">ambient</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={composite.ambient}
                          onChange={(e) =>
                            setComposite(file, { ambient: e.target.valueAsNumber })
                          }
                        />
                        <span className="composite-v">{composite.ambient.toFixed(2)}</span>
                      </div>
                      <div className="composite-hint">
                        drag image to aim light · space/middle-drag pans
                      </div>
                    </>
                  )}
                </>
              ))}
          </div>
        )}
        {showChip && (
          <div className="hover-chip mono" style={chipStyle}>
            <div className="hover-chip-head">
              <span className="hover-chip-pass">{activePass}</span>
              <span className="hover-chip-xy">
                {hoverPixel!.x}, {hoverPixel!.y}
              </span>
            </div>
            {passComponents.map((c) => {
              const key = `${passInfo!.rawName}.${c}`;
              const v = pixelInfo!.values[key];
              return (
                <div key={c} className="hover-chip-row">
                  <span className="ch">{c}</span>
                  <span className="val">{v === undefined ? '—' : formatFloat(v)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
