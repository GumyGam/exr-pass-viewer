// CPU-side helpers used by the renderer.
//
// Percentile computation for falsecolor / normalize / vector / position
// viz modes. The shader itself can't compute percentiles in a single pass,
// so we sample on CPU and feed the result in as uniforms.
//
// We cache percentile results per (passKey) — the UI is expected to compose
// a stable key like `${fileKey}::${passName}::${componentIdx}`. The cache
// is process-global and bounded by entry count, not memory.

/** Number of pixels we sample to estimate percentiles. ~10k is enough for
 *  visualization purposes; full sort would be O(WH log WH) which is slow
 *  on a 4K plate. */
const SAMPLE_COUNT = 10_000;

/** LRU cap on the cache. Each entry is two floats; size is negligible. */
const CACHE_MAX = 512;

const cache = new Map<string, [number, number]>();

/** Drop a cache entry (or all entries when called with no arg). */
export function invalidatePercentileCache(key?: string): void {
  if (key === undefined) cache.clear();
  else cache.delete(key);
}

/**
 * Compute [p2, p98] over a Float32Array, by random subsampling.
 *
 * Random sampling is deterministic for a given (length, count, seed) so
 * repeated calls with the same input give the same answer. We don't bother
 * with a seed parameter — the seed is derived from length.
 *
 * If hi - lo < 1e-8 we widen the range to avoid divide-by-zero in shaders.
 */
export function computePercentileRange(
  data: Float32Array,
  cacheKey?: string,
): [number, number] {
  if (cacheKey !== undefined) {
    const cached = cache.get(cacheKey);
    if (cached) {
      // LRU bump.
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached;
    }
  }

  const n = data.length;
  if (n === 0) return [0, 1e-8];

  // Build a sample using a deterministic linear-congruential walk over indices.
  // This is faster and good enough for visualization.
  const count = Math.min(SAMPLE_COUNT, n);
  const sample = new Float32Array(count);
  if (count === n) {
    sample.set(data);
  } else {
    // Stride sampling. Deterministic and avoids RNG state.
    const stride = n / count;
    for (let i = 0; i < count; i++) {
      const idx = Math.min(n - 1, Math.floor(i * stride));
      sample[i] = data[idx];
    }
  }

  // In-place sort (Float32Array supports sort with default ascending order).
  sample.sort();

  const loIdx = Math.floor(0.02 * (count - 1));
  const hiIdx = Math.floor(0.98 * (count - 1));
  let lo = sample[loIdx];
  let hi = sample[hiIdx];
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = lo + 1e-8;
  if (hi - lo < 1e-8) hi = lo + 1e-8;

  const range: [number, number] = [lo, hi];
  if (cacheKey !== undefined) {
    cache.set(cacheKey, range);
    if (cache.size > CACHE_MAX) {
      // Drop oldest. Map iteration is insertion-ordered.
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
  }
  return range;
}

/**
 * Compute the 98th percentile of the per-pixel magnitude of a 2D vector
 * field. Used by the vector viz mode to normalize arrow lengths.
 */
export function computeMagnitude98(
  x: Float32Array,
  y: Float32Array,
  cacheKey?: string,
): number {
  if (cacheKey !== undefined) {
    const cached = cache.get(cacheKey);
    if (cached) {
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached[1];
    }
  }

  const n = Math.min(x.length, y.length);
  if (n === 0) return 1e-8;
  const count = Math.min(SAMPLE_COUNT, n);
  const mags = new Float32Array(count);
  const stride = n / count;
  for (let i = 0; i < count; i++) {
    const idx = Math.min(n - 1, Math.floor(i * stride));
    const xi = x[idx];
    const yi = y[idx];
    mags[i] = Math.sqrt(xi * xi + yi * yi);
  }
  mags.sort();
  const hiIdx = Math.floor(0.98 * (count - 1));
  let m = mags[hiIdx];
  if (!Number.isFinite(m) || m < 1e-8) m = 1e-8;
  if (cacheKey !== undefined) {
    cache.set(cacheKey, [0, m]);
    if (cache.size > CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
  }
  return m;
}
