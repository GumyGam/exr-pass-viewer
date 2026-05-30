import { useCallback, useEffect, useRef } from 'react';
import { lightDirFromAngles } from '../store/viewerStore';

const DEG = 180 / Math.PI;

/**
 * A small clay sphere lit by the current relight light, with a draggable dot
 * marking the light direction. Front hemisphere only (elevation 0..90): the
 * dot lives inside the disc, center = light toward viewer, rim = grazing.
 *
 * The shading uses the same lambert + ambient math as the relight shaders, so
 * the ball literally previews what a sphere looks like under your light.
 */
export function LightSphere({
  azimuth,
  elevation,
  ambient,
  size = 88,
  onChange,
}: {
  azimuth: number;
  elevation: number;
  ambient: number;
  size?: number;
  onChange: (azimuthDeg: number, elevationDeg: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);

  // Repaint the shaded sphere + dot whenever the light or ambient changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - 4;
    const [lx, ly, lz] = lightDirFromAngles(azimuth, elevation);

    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const sx = (x - cx) / R;
        const sy = -(y - cy) / R; // screen y is down; flip so +y is up
        const r2 = sx * sx + sy * sy;
        const o = (y * size + x) * 4;
        if (r2 > 1) {
          data[o + 3] = 0; // outside the disc — transparent
          continue;
        }
        const nz = Math.sqrt(1 - r2);
        const lambert = Math.max(sx * lx + sy * ly + nz * lz, 0);
        const shade = ambient + (1 - ambient) * lambert;
        const g = Math.round(Math.min(1, Math.max(0, shade)) * 0.7 * 255);
        data[o] = g;
        data[o + 1] = g;
        data[o + 2] = g;
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Light dot: project the (front-hemisphere) light dir onto the disc.
    const rr = Math.cos((elevation * Math.PI) / 180);
    const dotX = cx + rr * Math.cos((azimuth * Math.PI) / 180) * R;
    const dotY = cy - rr * Math.sin((azimuth * Math.PI) / 180) * R;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd44d';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.stroke();
  }, [azimuth, elevation, ambient, size]);

  const aim = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = size / 2;
      const cy = size / 2;
      const R = size / 2 - 4;
      const nx = (clientX - rect.left - cx) / R;
      const ny = -(clientY - rect.top - cy) / R;
      let rr = Math.hypot(nx, ny);
      if (rr > 1) rr = 1;
      const az = (Math.atan2(ny, nx) * DEG + 360) % 360;
      const el = Math.acos(rr) * DEG; // rr=0 -> 90 (toward viewer), rr=1 -> 0
      onChange(az, el);
    },
    [size, onChange],
  );

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className="light-sphere"
      style={{ width: size, height: size, touchAction: 'none', cursor: 'crosshair' }}
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        draggingRef.current = true;
        aim(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (!draggingRef.current) return;
        aim(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        draggingRef.current = false;
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      }}
    />
  );
}
