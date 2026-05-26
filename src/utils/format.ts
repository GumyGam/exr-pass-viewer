export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)}K`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)}M`;
  return `${(bytes / 1024 ** 3).toFixed(2)}G`;
}

export function formatBytesLong(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatExposure(stops: number): string {
  const sign = stops >= 0 ? '+' : '';
  return `${sign}${stops.toFixed(1)}`;
}

export function formatGamma(g: number): string {
  return g.toFixed(2);
}

export function formatScale(scale: number): string {
  if (scale >= 1) return `${scale.toFixed(2)}×`;
  return `${scale.toFixed(2)}×`;
}

export function formatFloat(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(3);
  if (abs === 0) return '0.000';
  return v.toFixed(4);
}

export function basename(path: string): string {
  const ix = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return ix >= 0 ? path.slice(ix + 1) : path;
}

export function sceneName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  return parts[parts.length - 2]!;
}
