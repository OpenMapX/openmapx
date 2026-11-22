import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execa } from "execa";
import { resolveOsmPolyUrl } from "../download-osm.js";
import { dataWorkerSignal, publishDataChange } from "../execution/worker-scope.js";
import { captureOvertureCatalogue } from "./attribution-capture.js";
import { assertOvertureDiskCapacity, estimateOverturePullBytes, freeBytesAt } from "./capacity.js";
import { duckDbSqlLiteral, runDuckDb } from "./duckdb.js";
import {
  assertValidOvertureRelease,
  buildOverturePullContract,
  discoverLatestOvertureRelease,
  OVERTURE_PLACE_COLUMNS,
  type OvertureRegionClip,
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

export type PolyCoordinate = readonly [number, number];
export type PolyRing = readonly PolyCoordinate[];

export interface ParsedOsmosisPoly {
  outer: PolyRing[];
  exclusions: PolyRing[];
  vertices: number;
}

export type RegionBoundary =
  | {
      kind: "none";
      envelopes: [RegionBbox];
      clip: { kind: "none" };
    }
  | {
      kind: "geofabrik-poly";
      envelopes: RegionBbox[];
      outer: PolyRing[];
      exclusions: PolyRing[];
      clip: Extract<OvertureRegionClip, { kind: "geofabrik-poly" }>;
    };

// A region is one or more lowercase "<area>" segments joined by "/" — a
// Geofabrik download path (e.g. "europe/germany/berlin", "north-america/us/texas").
// The strict shape is security-load-bearing: the slug is interpolated into
// DuckDB SQL string literals and filesystem paths, so quotes, semicolons, dots
// (path traversal), spaces and other metacharacters must never reach those sinks.
const REGION_RE = /^[a-z][a-z0-9_-]*(\/[a-z][a-z0-9_-]*)*$/;

const MAX_POLY_BYTES = 1024 * 1024;
const ANTIMERIDIAN_MIN_GAP_DEGREES = 10;
const COORD_TOKEN_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

function isCoordinatePairLine(line: string): boolean {
  const parts = line.split(/\s+/);
  return (
    parts.length === 2 && COORD_TOKEN_RE.test(parts[0] ?? "") && COORD_TOKEN_RE.test(parts[1] ?? "")
  );
}

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

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function assertValidCoordinate(lon: number, lat: number, context: string): void {
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lon < -180 ||
    lon > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    throw new Error(`Invalid coordinate in ${context}`);
  }
}

/**
 * Parses an Osmosis `.poly` boundary file into closed outer and `!`-prefixed
 * exclusion rings. Accepts named or numeric section headers, scientific
 * notation, CRLF/blank lines, unclosed rings, and consecutive duplicate
 * vertices while failing closed on malformed structure or oversized files.
 */
export function parseOsmosisPoly(polyText: string): ParsedOsmosisPoly {
  if (Buffer.byteLength(polyText, "utf8") > MAX_POLY_BYTES) {
    throw new Error(`Geofabrik .poly file exceeds ${MAX_POLY_BYTES} byte limit`);
  }
  const lines = polyText.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length && lines[index]?.trim() === "") index++;
  const nameLine = lines[index]?.trim();
  if (!nameLine || nameLine === "END") {
    throw new Error("Missing region name header in .poly file");
  }
  index++;

  const outer: PolyRing[] = [];
  const exclusions: PolyRing[] = [];
  let vertices = 0;

  while (true) {
    while (index < lines.length && lines[index]?.trim() === "") index++;
    if (index >= lines.length) {
      throw new Error("Unterminated .poly file: missing final END");
    }
    const header = lines[index]?.trim() ?? "";
    index++;
    if (header === "END") {
      for (let rest = index; rest < lines.length; rest++) {
        if (lines[rest]?.trim() !== "") {
          throw new Error("Unexpected trailing content after final END in .poly file");
        }
      }
      break;
    }

    const isExclusion = header.startsWith("!");
    if (isExclusion && header.slice(1).trim().length === 0) {
      throw new Error("Invalid empty exclusion section header in .poly file");
    }
    if (!isExclusion && isCoordinatePairLine(header)) {
      throw new Error(`Missing ring section header before coordinates in .poly file: "${header}"`);
    }

    const ring: [number, number][] = [];
    let closedSection = false;
    while (index < lines.length) {
      const trimmed = lines[index]?.trim() ?? "";
      index++;
      if (trimmed === "") continue;
      if (trimmed === "END") {
        closedSection = true;
        break;
      }
      const parts = trimmed.split(/\s+/);
      if (
        parts.length !== 2 ||
        !COORD_TOKEN_RE.test(parts[0] ?? "") ||
        !COORD_TOKEN_RE.test(parts[1] ?? "")
      ) {
        throw new Error(`Invalid coordinate line in .poly ring "${header}": "${trimmed}"`);
      }
      const lon = Number(parts[0]);
      const lat = Number(parts[1]);
      assertValidCoordinate(lon, lat, `.poly ring "${header}"`);
      const x = normalizeZero(lon);
      const y = normalizeZero(lat);
      const previous = ring.at(-1);
      if (!previous || previous[0] !== x || previous[1] !== y) {
        ring.push([x, y]);
      }
    }
    if (!closedSection) {
      throw new Error(`Unterminated ring section "${header}" in .poly file: missing END`);
    }

    const first = ring[0];
    const last = ring.at(-1);
    if (ring.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) {
      ring.pop();
    }
    const distinctVertices = new Set(ring.map(([x, y]) => `${x},${y}`)).size;
    if (!first || distinctVertices < 3) {
      throw new Error(`Ring "${header}" in .poly file has fewer than 3 distinct vertices`);
    }
    ring.push([first[0], first[1]]);
    if (isExclusion) exclusions.push(ring);
    else outer.push(ring);
    vertices += ring.length - 1;
  }

  if (outer.length === 0) {
    throw new Error("No outer rings found in .poly file");
  }
  return { outer, exclusions, vertices };
}

/**
 * Formats parsed rings as a WKT MULTIPOLYGON using only validated numeric
 * coordinates (never raw input tokens).
 */
export function ringsToMultiPolygonWkt(rings: readonly PolyRing[]): string {
  if (rings.length === 0) {
    throw new Error("At least one ring is required to build a MULTIPOLYGON WKT");
  }
  const polygons = rings.map((ring) => {
    if (ring.length < 4) {
      throw new Error("Each polygon ring must have at least 4 coordinates (closed ring)");
    }
    const coords = ring
      .map(([lon, lat]) => {
        assertValidCoordinate(lon, lat, "WKT ring");
        return `${normalizeZero(lon)} ${normalizeZero(lat)}`;
      })
      .join(",");
    return `((${coords}))`;
  });
  return `MULTIPOLYGON(${polygons.join(",")})`;
}

function ringBbox(ring: PolyRing): RegionBbox {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const [lon, lat] of ring) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

function mergeBboxes(boxes: readonly RegionBbox[]): RegionBbox {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    if (box.west < west) west = box.west;
    if (box.east > east) east = box.east;
    if (box.south < south) south = box.south;
    if (box.north > north) north = box.north;
  }
  return { west, south, east, north };
}

/**
 * Derives 1 bounding envelope for ordinary regions, or 2 disjoint x-range
 * envelopes for antimeridian-crossing multi-ring regions (e.g. Fiji, Russia,
 * Alaska, New Zealand) so STAC asset selection and Parquet row-group pruning do
 * not pull an entire global latitude band. Single wide rings (Antarctica) stay
 * as 1 envelope.
 */
export function regionEnvelopes(outer: readonly PolyRing[]): RegionBbox[] {
  if (outer.length === 0) {
    throw new Error("At least one outer ring is required to derive region envelopes");
  }
  const boxes = outer.map(ringBbox);
  const full = mergeBboxes(boxes);
  if (boxes.length < 2 || full.east - full.west <= 180) return [full];

  const sortedX = boxes
    .map((box) => ({ west: box.west, east: box.east }))
    .sort((a, b) => a.west - b.west || a.east - b.east);
  const spans: Array<{ west: number; east: number }> = [];
  for (const interval of sortedX) {
    const previous = spans.at(-1);
    if (!previous || interval.west > previous.east) {
      spans.push({ ...interval });
    } else if (interval.east > previous.east) {
      previous.east = interval.east;
    }
  }
  if (spans.length < 2) return [full];

  let maxGap = 0;
  let splitIndex = -1;
  for (let i = 0; i < spans.length - 1; i++) {
    const leftSpan = spans[i];
    const rightSpan = spans[i + 1];
    if (!leftSpan || !rightSpan) continue;
    const gap = rightSpan.west - leftSpan.east;
    if (gap > maxGap) {
      maxGap = gap;
      splitIndex = i;
    }
  }
  if (splitIndex < 0 || maxGap < ANTIMERIDIAN_MIN_GAP_DEGREES) return [full];

  const leftEdge = spans[splitIndex]?.east;
  const rightEdge = spans[splitIndex + 1]?.west;
  if (leftEdge === undefined || rightEdge === undefined) return [full];

  const leftBoxes = boxes.filter((box) => box.east <= leftEdge);
  const rightBoxes = boxes.filter((box) => box.west >= rightEdge);
  if (leftBoxes.length === 0 || rightBoxes.length === 0) return [full];

  return [mergeBboxes(leftBoxes), mergeBboxes(rightBoxes)];
}

/**
 * Fetches and parses the region's Geofabrik `.poly` boundary, deriving exact
 * polygon rings and 1–2 pruning envelopes. `planet` returns an unclipped global
 * boundary without contacting Geofabrik.
 */
export async function fetchRegionBoundary(
  region: string,
  fetchPolyImpl?: (url: string) => Promise<string>,
): Promise<RegionBoundary> {
  assertValidRegion(region);
  if (region === "planet") {
    return {
      kind: "none",
      envelopes: [{ west: -180, south: -90, east: 180, north: 90 }],
      clip: { kind: "none" },
    };
  }
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
  let polyBytes: Buffer;
  try {
    if (fetchPolyImpl) {
      polyBytes = Buffer.from(await fetchPolyImpl(safePolyUrl), "utf8");
    } else {
      const result = await execa(
        "curl",
        ["-fsSL", "--max-filesize", String(MAX_POLY_BYTES), safePolyUrl],
        {
          timeout: 30_000,
          cancelSignal: dataWorkerSignal(),
          stripFinalNewline: false,
          encoding: "buffer",
        },
      );
      polyBytes = Buffer.from(result.stdout);
    }
  } catch {
    throw new Error(
      `Could not fetch Geofabrik boundary for region "${region}" (${safePolyUrl}). ` +
        `Use a valid Geofabrik region path (e.g. "europe/germany/berlin").`,
    );
  }
  const polyText = polyBytes.toString("utf8");
  const parsed = parseOsmosisPoly(polyText);
  const sha256 = createHash("sha256").update(polyBytes).digest("hex");
  return {
    kind: "geofabrik-poly",
    envelopes: regionEnvelopes(parsed.outer),
    outer: parsed.outer,
    exclusions: parsed.exclusions,
    clip: {
      kind: "geofabrik-poly",
      url: safePolyUrl,
      sha256,
      outerRings: parsed.outer.length,
      exclusionRings: parsed.exclusions.length,
      vertices: parsed.vertices,
    },
  };
}

function buildRegionPolySql(outerWktPath: string, exclusionsWktPath?: string): string {
  const outerLiteral = duckDbSqlLiteral(outerWktPath);
  if (!exclusionsWktPath) {
    return [
      "SET VARIABLE region_poly = (",
      `  WITH o AS (SELECT unnest(ST_Dump(ST_GeomFromText(content))).geom AS g FROM read_text(${outerLiteral})),`,
      "       u AS (SELECT ST_Union_Agg(ST_MakeValid(g)) AS g FROM o)",
      "  SELECT ST_SetCRS(u.g, 'OGC:CRS84') FROM u",
      ");",
    ].join("\n");
  }
  const exclusionsLiteral = duckDbSqlLiteral(exclusionsWktPath);
  return [
    "SET VARIABLE region_poly = (",
    `  WITH o AS (SELECT unnest(ST_Dump(ST_GeomFromText(content))).geom AS g FROM read_text(${outerLiteral})),`,
    "       u AS (SELECT ST_Union_Agg(ST_MakeValid(g)) AS g FROM o),",
    `       x_raw AS (SELECT unnest(ST_Dump(ST_GeomFromText(content))).geom AS g FROM read_text(${exclusionsLiteral})),`,
    "       x AS (SELECT ST_Union_Agg(ST_MakeValid(g)) AS g FROM x_raw)",
    "  SELECT ST_SetCRS(ST_Difference(u.g, x.g), 'OGC:CRS84') FROM u, x",
    ");",
  ].join("\n");
}

export interface PullOvertureOptions {
  region: string;
  dataDir: string;
  release?: string;
  fetchImpl?: typeof fetch;
  fetchPolyImpl?: (url: string) => Promise<string>;
  onProgress?: (msg: string) => void;
}

function requireTextStdout(stdout: unknown, label: string): string {
  if (typeof stdout !== "string") {
    throw new Error(`DuckDB returned non-text output for ${label}`);
  }
  return stdout;
}

export async function pullOverture(opts: PullOvertureOptions): Promise<string> {
  const sourcesCatalogue = captureOvertureCatalogue(new Date().toISOString());
  const release = opts.release ?? (await discoverLatestOvertureRelease(opts.fetchImpl ?? fetch));
  assertValidOvertureRelease(release);
  opts.onProgress?.(`Resolving ${opts.region} boundary from Geofabrik...`);
  const boundary = await fetchRegionBoundary(opts.region, opts.fetchPolyImpl);
  opts.onProgress?.(`Resolving exact Overture ${release} Places assets from STAC...`);
  const stac = await resolveOvertureStacContract(
    release,
    boundary.envelopes,
    opts.fetchImpl ?? fetch,
  );
  const slug = regionSlug(opts.region);
  const outDir = join(opts.dataDir, "overture", release);
  mkdirSync(outDir, { recursive: true });
  assertOvertureDiskCapacity({
    stage: "regional snapshot pull",
    workingBytes: Math.max(
      estimateOverturePullBytes(opts.dataDir, slug),
      opts.region === "planet" ? stac.selectedAssetRows * 512 : 0,
    ),
    freeBytes: freeBytesAt(opts.dataDir),
  });
  const outPath = join(outDir, `${slug}.parquet`);
  const contractPath = pullContractPath(opts.dataDir, release, opts.region);
  // Stage on the publication filesystem for atomic renames. mkdtemp creates a
  // random, owner-only directory so neither COPY nor the contract write can
  // follow a pre-created staging symlink.
  const stagingDir = mkdtempSync(join(outDir, `.${slug}-`));
  const partialPath = join(stagingDir, "snapshot.parquet");
  const partialContractPath = join(stagingDir, "contract.json");

  try {
    const assetList = stac.assets.map((asset) => duckDbSqlLiteral(asset.href)).join(", ");
    const projectedColumns = OVERTURE_PLACE_COLUMNS.map((column) => `  ${column}`).join(",\n");

    let regionPolySql: string | undefined;
    if (boundary.kind === "geofabrik-poly") {
      const outerWktPath = join(stagingDir, "region-outer.wkt");
      writeFileSync(outerWktPath, ringsToMultiPolygonWkt(boundary.outer), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      let exclusionsWktPath: string | undefined;
      if (boundary.exclusions.length > 0) {
        exclusionsWktPath = join(stagingDir, "region-exclusions.wkt");
        writeFileSync(exclusionsWktPath, ringsToMultiPolygonWkt(boundary.exclusions), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      }
      regionPolySql = buildRegionPolySql(outerWktPath, exclusionsWktPath);
    }

    const selectBranches = boundary.envelopes.map((envelope) =>
      [
        `  SELECT`,
        projectedColumns,
        `  FROM read_parquet([${assetList}], union_by_name=false)`,
        `  WHERE bbox.xmin <= ${envelope.east}`,
        `    AND bbox.xmax >= ${envelope.west}`,
        `    AND bbox.ymin <= ${envelope.north}`,
        `    AND bbox.ymax >= ${envelope.south}`,
        ...(regionPolySql ? [`    AND ST_Intersects(geometry, getvariable('region_poly'))`] : []),
      ].join("\n"),
    );

    const duckSql = [
      "LOAD httpfs;",
      "LOAD spatial;",
      ...(regionPolySql
        ? [
            regionPolySql,
            "SET VARIABLE _region_poly_valid = (SELECT CASE WHEN ST_IsValid(getvariable('region_poly')) AND NOT ST_IsEmpty(getvariable('region_poly')) AND ST_Area(getvariable('region_poly')) > 0 THEN 1 ELSE error('invalid region polygon') END);",
          ]
        : []),
      `COPY (`,
      selectBranches.join("\n  UNION ALL\n"),
      `) TO ${duckDbSqlLiteral(partialPath)} (FORMAT parquet, COMPRESSION zstd);`,
    ].join("\n");

    opts.onProgress?.(
      `Pulling Overture ${release} for ${opts.region} from ${stac.assets.length} exact STAC asset(s)...`,
    );
    await runDuckDb(["-c", duckSql], { stdio: "inherit" });

    // This compatibility probe intentionally exercises every nested field used
    // by ingest. LIMIT 0 makes it a schema/type check without scanning rows.
    const compatibilitySql = [
      "LOAD spatial;",
      `SELECT id::VARCHAR, names.primary::VARCHAR, basic_category::VARCHAR,`,
      `       taxonomy.primary::VARCHAR, taxonomy.hierarchy::VARCHAR[],`,
      `       taxonomy.alternates::VARCHAR[], ST_AsHEXWKB(geometry),`,
      `       addresses[1].country::VARCHAR, websites::VARCHAR[], socials::VARCHAR[],`,
      `       emails::VARCHAR[], phones::VARCHAR[], to_json(brand), confidence::DOUBLE,`,
      `       operating_status::VARCHAR, to_json(sources), version::INTEGER`,
      `FROM read_parquet(${duckDbSqlLiteral(partialPath)}) LIMIT 0;`,
    ].join("\n");
    await runDuckDb(["-c", compatibilitySql]);

    const statsSql = [
      "LOAD spatial;",
      ...(regionPolySql ? [regionPolySql] : []),
      `SELECT count(*)::BIGINT AS row_count,`,
      `       count(*) FILTER (WHERE id IS NULL OR trim(id) = '')::BIGINT AS invalid_ids,`,
      `       (count(*) - count(DISTINCT id))::BIGINT AS duplicate_ids,`,
      `       count(*) FILTER (WHERE geometry IS NULL)::BIGINT AS null_geometries,`,
      `       count(*) FILTER (WHERE geometry IS NOT NULL AND ST_GeometryType(geometry) <> 'POINT')::BIGINT AS non_point_geometries,`,
      `       count(*) FILTER (WHERE geometry IS NOT NULL AND ST_CRS(geometry) IS DISTINCT FROM 'OGC:CRS84')::BIGINT AS wrong_crs_geometries,`,
      `       count(*) FILTER (WHERE ST_IsEmpty(geometry) OR NOT (ST_X(geometry) BETWEEN -180 AND 180) OR NOT (ST_Y(geometry) BETWEEN -90 AND 90))::BIGINT AS invalid_points,`,
      `       count(*) FILTER (WHERE theme <> 'places' OR type <> 'place')::BIGINT AS wrong_type_rows${
        regionPolySql
          ? ",\n       count(*) FILTER (WHERE geometry IS NOT NULL AND NOT ST_Intersects(geometry, getvariable('region_poly')))::BIGINT AS outside_region"
          : ""
      }`,
      `FROM read_parquet(${duckDbSqlLiteral(partialPath)});`,
    ].join("\n");
    const statsResult = await runDuckDb(["-json", "-c", statsSql]);
    const statsRows = JSON.parse(
      requireTextStdout(statsResult.stdout, "Overture snapshot statistics"),
    ) as Array<Record<string, number>>;
    const stats = statsRows[0];
    const rowCount = stats?.row_count;
    if (!stats || rowCount === undefined || !Number.isSafeInteger(rowCount) || rowCount <= 0) {
      throw new Error("Overture regional snapshot contains no rows");
    }
    const zeroCheckFields = [
      "invalid_ids",
      "duplicate_ids",
      "null_geometries",
      "non_point_geometries",
      "wrong_crs_geometries",
      "invalid_points",
      "wrong_type_rows",
      ...(regionPolySql ? (["outside_region"] as const) : []),
    ] as const;
    for (const field of zeroCheckFields) {
      if (stats[field] !== 0) {
        throw new Error(`Overture regional snapshot failed ${field}: ${stats[field]} row(s)`);
      }
    }

    const contributorSql = [
      `SELECT DISTINCT dataset`,
      `FROM (`,
      `  SELECT UNNEST(LIST_TRANSFORM(sources, lambda source: source.dataset)) AS dataset`,
      `  FROM read_parquet(${duckDbSqlLiteral(partialPath)})`,
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
      boundary.envelopes,
      boundary.clip,
      partialPath,
      {
        rowCount,
        contributors: contributorRows.map((row) => row.dataset),
      },
      basename(outPath),
      sourcesCatalogue,
    );

    // Persist validated provider metadata as data, never executable content.
    // The destination uses only the operator's dataDir, validated release and
    // region, and the private staging directory; upstream fields are contents.
    writeFileSync(partialContractPath, `${JSON.stringify(contract, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await publishDataChange(() => {
      renameSync(partialPath, outPath);
      // Publish metadata last; interruption of this pair remains unknown.
      renameSync(partialContractPath, contractPath);
    });
    opts.onProgress?.(
      `Validated ${contract.rowCount} places and ${contract.contributors.length} contributor(s).`,
    );
    opts.onProgress?.(`Done: ${outPath}`);
    return outPath;
  } finally {
    rmSync(stagingDir, { force: true, recursive: true });
  }
}
