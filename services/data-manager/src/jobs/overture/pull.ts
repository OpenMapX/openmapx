import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execa } from "execa";
import { resolveOsmPolyUrl } from "../download-osm.js";
import { assertOvertureDiskCapacity, estimateOverturePullBytes, freeBytesAt } from "./capacity.js";
import { runDuckDb } from "./duckdb.js";
import {
  assertValidOvertureRelease,
  buildOverturePullContract,
  discoverLatestOvertureRelease,
  OVERTURE_PLACE_COLUMNS,
  pullContractPath,
  resolveOvertureStacContract,
} from "./stac.js";

export {
  assertValidOvertureRelease,
  discoverLatestOvertureRelease,
  latestReleaseFromCatalog,
  OVERTURE_STAC_URL,
} from "./stac.js";

export async function resolveOvertureRelease(release?: string): Promise<string> {
  if (release !== undefined) {
    assertValidOvertureRelease(release);
    return release;
  }
  return discoverLatestOvertureRelease();
}

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
  // Defense-in-depth: the region is already constrained to lowercase path
  // segments by assertValidRegion, but pin the fetched host to Geofabrik so a
  // region value can only ever select a path under the fixed boundary host
  // (no scheme/host injection — SSRF guard). The request uses the validated URL
  // object, so the host allow-list check actually guards the fetched value.
  const polyUrl = new URL(resolveOsmPolyUrl(region));
  if (polyUrl.protocol !== "https:" || polyUrl.hostname !== "download.geofabrik.de") {
    throw new Error(`Refusing to fetch non-Geofabrik boundary URL for region "${region}"`);
  }
  const safePolyUrl = polyUrl.toString();
  let stdout: string;
  try {
    ({ stdout } = await execa("curl", ["-fsSL", safePolyUrl], { timeout: 30_000 }));
  } catch {
    throw new Error(
      `Could not fetch Geofabrik boundary for region "${region}" (${safePolyUrl}). ` +
        `Use a valid Geofabrik region path (e.g. "europe/germany/berlin").`,
    );
  }
  return computeBboxFromPoly(stdout);
}

export interface PullOvertureOptions {
  region: string;
  dataDir: string;
  release?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (msg: string) => void;
}

function requireTextStdout(stdout: unknown, label: string): string {
  if (typeof stdout !== "string") {
    throw new Error(`DuckDB returned non-text output for ${label}`);
  }
  return stdout;
}

export async function pullOverture(opts: PullOvertureOptions): Promise<string> {
  const release = opts.release ?? (await discoverLatestOvertureRelease(opts.fetchImpl ?? fetch));
  assertValidOvertureRelease(release);
  opts.onProgress?.(`Resolving ${opts.region} boundary from Geofabrik...`);
  const bbox = await fetchRegionBbox(opts.region);
  opts.onProgress?.(`Resolving exact Overture ${release} Places assets from STAC...`);
  const stac = await resolveOvertureStacContract(release, bbox, opts.fetchImpl ?? fetch);
  const slug = regionSlug(opts.region);
  const outDir = join(opts.dataDir, "overture", release);
  mkdirSync(outDir, { recursive: true });
  assertOvertureDiskCapacity({
    stage: "regional snapshot pull",
    workingBytes: estimateOverturePullBytes(opts.dataDir, slug),
    freeBytes: freeBytesAt(opts.dataDir),
  });
  const outPath = join(outDir, `${slug}.parquet`);
  const partialPath = join(outDir, `${slug}.${process.pid}.${Date.now()}.partial.parquet`);
  const contractPath = pullContractPath(opts.dataDir, release, opts.region);
  const partialContractPath = `${contractPath}.${process.pid}.${Date.now()}.partial`;

  const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const assetList = stac.assets.map((asset) => sqlLiteral(asset.href)).join(", ");
  const projectedColumns = OVERTURE_PLACE_COLUMNS.map((column) => `  ${column}`).join(",\n");

  const duckSql = [
    "INSTALL httpfs; LOAD httpfs;",
    "INSTALL spatial; LOAD spatial;",
    `COPY (`,
    `  SELECT`,
    projectedColumns,
    `  FROM read_parquet([${assetList}], union_by_name=false)`,
    `  WHERE bbox.xmin <= ${bbox.east}`,
    `    AND bbox.xmax >= ${bbox.west}`,
    `    AND bbox.ymin <= ${bbox.north}`,
    `    AND bbox.ymax >= ${bbox.south}`,
    `) TO ${sqlLiteral(partialPath)} (FORMAT parquet);`,
  ].join("\n");

  opts.onProgress?.(
    `Pulling Overture ${release} for ${opts.region} from ${stac.assets.length} exact STAC asset(s)...`,
  );
  try {
    await runDuckDb(["-c", duckSql], { stdio: "inherit" });

    // This compatibility probe intentionally exercises every nested field used
    // by ingest. LIMIT 0 makes it a schema/type check without scanning rows.
    const compatibilitySql = [
      "INSTALL spatial; LOAD spatial;",
      `SELECT id::VARCHAR, names.primary::VARCHAR, basic_category::VARCHAR,`,
      `       taxonomy.primary::VARCHAR, taxonomy.hierarchy::VARCHAR[],`,
      `       taxonomy.alternates::VARCHAR[], ST_AsHEXWKB(geometry),`,
      `       addresses[1].country::VARCHAR, websites::VARCHAR[], socials::VARCHAR[],`,
      `       emails::VARCHAR[], phones::VARCHAR[], to_json(brand), confidence::DOUBLE,`,
      `       operating_status::VARCHAR, to_json(sources), version::INTEGER`,
      `FROM read_parquet(${sqlLiteral(partialPath)}) LIMIT 0;`,
    ].join("\n");
    await runDuckDb(["-c", compatibilitySql]);

    const statsSql = [
      "INSTALL spatial; LOAD spatial;",
      `SELECT count(*)::BIGINT AS row_count,`,
      `       count(*) FILTER (WHERE id IS NULL OR trim(id) = '')::BIGINT AS invalid_ids,`,
      `       (count(*) - count(DISTINCT id))::BIGINT AS duplicate_ids,`,
      `       count(*) FILTER (WHERE geometry IS NULL)::BIGINT AS null_geometries,`,
      `       count(*) FILTER (WHERE geometry IS NOT NULL AND ST_GeometryType(geometry) <> 'POINT')::BIGINT AS non_point_geometries,`,
      `       count(*) FILTER (WHERE theme <> 'places' OR type <> 'place')::BIGINT AS wrong_type_rows`,
      `FROM read_parquet(${sqlLiteral(partialPath)});`,
    ].join("\n");
    const statsResult = await runDuckDb(["-json", "-c", statsSql]);
    const statsRows = JSON.parse(
      requireTextStdout(statsResult.stdout, "Overture snapshot statistics"),
    ) as Array<Record<string, number>>;
    const stats = statsRows[0];
    if (!stats || !Number.isSafeInteger(stats.row_count) || stats.row_count <= 0) {
      throw new Error("Overture regional snapshot contains no rows");
    }
    for (const field of [
      "invalid_ids",
      "duplicate_ids",
      "null_geometries",
      "non_point_geometries",
      "wrong_type_rows",
    ] as const) {
      if (stats[field] !== 0) {
        throw new Error(`Overture regional snapshot failed ${field}: ${stats[field]} row(s)`);
      }
    }

    const contributorSql = [
      `SELECT DISTINCT dataset`,
      `FROM (`,
      `  SELECT UNNEST(LIST_TRANSFORM(sources, lambda source: source.dataset)) AS dataset`,
      `  FROM read_parquet(${sqlLiteral(partialPath)})`,
      `  WHERE sources IS NOT NULL`,
      `)`,
      `WHERE dataset IS NOT NULL AND trim(dataset) <> ''`,
      `ORDER BY dataset;`,
    ].join("\n");
    const contributorResult = await runDuckDb(["-json", "-c", contributorSql]);
    const contributorRows = JSON.parse(
      requireTextStdout(contributorResult.stdout, "Overture contributors"),
    ) as Array<{ dataset: string }>;
    const contract = buildOverturePullContract(
      stac,
      opts.region,
      bbox,
      partialPath,
      {
        rowCount: stats.row_count,
        contributors: contributorRows.map((row) => row.dataset),
      },
      basename(outPath),
    );

    writeFileSync(partialContractPath, `${JSON.stringify(contract, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(partialPath, outPath);
    // Publish the contract last: ingest never observes a new contract pointing
    // at a partial parquet snapshot.
    renameSync(partialContractPath, contractPath);
    opts.onProgress?.(
      `Validated ${contract.rowCount} places and ${contract.contributors.length} contributor(s).`,
    );
    opts.onProgress?.(`Done: ${outPath}`);
    return outPath;
  } finally {
    rmSync(partialPath, { force: true });
    rmSync(partialContractPath, { force: true });
  }
}
