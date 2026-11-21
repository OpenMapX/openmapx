/** One terrain sample: whether DEM data has loaded there, and the drawn tile's own height. */
export interface TerrainSample {
  state: "loaded" | "loading" | "none";
  /** Elevation from the drawn tile's own DEM data; absent while only a parent's is loaded. */
  drawn?: number;
}

/** Terrain as custom layers need it; the web adapter reads MapLibre's terrain. */
export interface TerrainProbe {
  enabled(): boolean;
  sample(lngLat: [number, number]): TerrainSample;
}

/**
 * Sample an n × n grid of drawn heights over a box, row by row from the
 * south-west corner. `null` without terrain; "pending" until every sample is
 * loaded with the drawn tile's own height (MapLibre answers 0 or a coarse
 * parent's height before that).
 */
export function sampleTerrainGrid(
  probe: TerrainProbe,
  west: number,
  south: number,
  east: number,
  north: number,
  n: number,
): Float32Array | "pending" | null {
  if (!probe.enabled()) return null;
  const grid = new Float32Array(n * n);
  const step = n > 1 ? 1 / (n - 1) : 0;
  for (let row = 0; row < n; row++) {
    const lat = south + (north - south) * row * step;
    for (let col = 0; col < n; col++) {
      const lng = west + (east - west) * col * step;
      const sample = probe.sample([lng, lat]);
      if (sample.state !== "loaded" || sample.drawn === undefined) return "pending";
      grid[row * n + col] = sample.drawn;
    }
  }
  return grid;
}

/** Bilinear height at (u, v) in 0..1 (u east, v north) from a grid of `sampleTerrainGrid`. */
export function bilinear(grid: Float32Array, n: number, u: number, v: number): number {
  const max = n - 1;
  const x = Math.min(Math.max(u, 0), 1) * max;
  const y = Math.min(Math.max(v, 0), 1) * max;
  const last = Math.max(0, max - 1);
  const x0 = Math.min(Math.floor(x), last);
  const y0 = Math.min(Math.floor(y), last);
  const x1 = Math.min(x0 + 1, max);
  const y1 = Math.min(y0 + 1, max);
  const fx = x - x0;
  const fy = y - y0;
  const at = (col: number, row: number) => grid[row * n + col] as number;
  const south = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const north = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return south * (1 - fy) + north * fy;
}
