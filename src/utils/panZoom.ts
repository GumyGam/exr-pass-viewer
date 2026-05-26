import type { PanZoom } from '../store/viewerStore';

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 32;

export function clampZoom(scale: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
}

export function zoomAt(pz: PanZoom, cx: number, cy: number, factor: number): PanZoom {
  const nextScale = clampZoom(pz.scale * factor);
  const k = nextScale / pz.scale;
  return {
    scale: nextScale,
    x: cx - (cx - pz.x) * k,
    y: cy - (cy - pz.y) * k,
  };
}

export function transformStyle(pz: PanZoom): string {
  return `translate3d(${pz.x}px, ${pz.y}px, 0) scale(${pz.scale})`;
}
