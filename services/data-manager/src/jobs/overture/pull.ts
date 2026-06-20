import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { resolveOsmPolyUrl } from "../download-osm.js";

export const OVERTURE_RELEASE = "2026-06-17.0";

export interface RegionBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

// A region is one or more lowercase "<area>" segments joined by "/" — a
// Geofabrik download path (e.g. "europe/germany/berlin", "north-america/us/texas").
// The strict shape is security-load-bearing: the slug is interpolated into
// DuckDB SQL string literals and filesystem paths, so quotes, semicolons, dots
// (path traversal), spaces and other metacharacters must never reach those sinks.
const REGION_RE = /^[a-z][a-z0-9_-]*(\/[a-z][a-z0-9_-]*)*$/;

export function assertValidRegion(region: string): void {
  if (!REGION_RE.test(region)) {
    throw new Error(
      `Invalid region "${region}": expected lowercase "<area>[/<sub-area>...]" segments ` +
        `(letters, digits, "_", "-"; no quotes, dots, or path separators beyond "/").`,
    );
  }
}

export function regionSlug(region: string): string {
  assertValidRegion(region);
  return region.replace(/\//g, "-");
}

/**
 * Computes a bounding box from a Geofabrik `.poly` boundary file. The format is
 * a name line, then ring sections of `lon lat` coordinate lines terminated by
 * `END`. Holes don't affect the outer bbox, so we just min/max every coordinate
 * line (any line with two finite lon/lat tokens in range). Pure + testable.
 */
export function computeBboxFromPoly(polyText: string): RegionBbox {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const line of polyText.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    found = true;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (!found) throw new Error("no coordinates found in .poly file");
  return { west, south, east, north };
}

/**
 * Fetches the region's Geofabrik `.poly` boundary and derives its bbox. This
 * replaces a hardcoded per-region table — any of Geofabrik's ~555 regions
 * resolves from its own published boundary, country or sub-country.
 */
export async function fetchRegionBbox(region: string): Promise<RegionBbox> {
  assertValidRegion(region);
  const polyUrl = resolveOsmPolyUrl(region);
  let stdout: string;
  try {
    ({ stdout } = await execa("curl", ["-fsSL", polyUrl], { timeout: 30_000 }));
  } catch {
    throw new Error(
      `Could not fetch Geofabrik boundary for region "${region}" (${polyUrl}). ` +
        `Use a valid Geofabrik region path (e.g. "europe/germany/berlin").`,
    );
  }
  return computeBboxFromPoly(stdout);
}

export interface PullOvertureOptions {
  region: string;
  dataDir: string;
  release?: string;
  onProgress?: (msg: string) => void;
}

export async function pullOverture(opts: PullOvertureOptions): Promise<string> {
  const release = opts.release ?? OVERTURE_RELEASE;
  opts.onProgress?.(`Resolving ${opts.region} boundary from Geofabrik...`);
  const bbox = await fetchRegionBbox(opts.region);
  const slug = regionSlug(opts.region);
  const outDir = join(opts.dataDir, "overture", release);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${slug}.parquet`);

  const duckSql = [
    "INSTALL httpfs; LOAD httpfs;",
    "INSTALL spatial; LOAD spatial;",
    "SET s3_region='us-west-2';",
    `COPY (`,
    `  SELECT *`,
    `  FROM read_parquet('s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*')`,
    `  WHERE bbox.xmin <= ${bbox.east}`,
    `    AND bbox.xmax >= ${bbox.west}`,
    `    AND bbox.ymin <= ${bbox.north}`,
    `    AND bbox.ymax >= ${bbox.south}`,
    `) TO '${outPath}' (FORMAT parquet);`,
  ].join("\n");

  opts.onProgress?.(`Pulling Overture ${release} for ${opts.region} → ${outPath}`);
  await execa("duckdb", ["-c", duckSql], { stdio: "inherit" });
  opts.onProgress?.(`Done: ${outPath}`);
  return outPath;
}
