import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWithRedirects, isValidFeedSlug, USER_AGENT, validatePublicUrl } from "@openmapx/core";
import { safeDownload } from "@openmapx/core/server";
import { gtfsDate, parseCsv, streamCsvBatches } from "./csv";
import { sql } from "./db";
import { invalidateSchemaCaches } from "./queries";

function assertValidGtfsSchema(schema: string): void {
  if (!schema.startsWith("gtfs_") || !isValidFeedSlug(schema.slice("gtfs_".length))) {
    throw new Error(`Invalid GTFS schema name "${schema}"`);
  }
}

const BATCH_SIZE = 5_000;
const SWISS_REDIRECT_HOSTS = ["opentransportdata.swiss", "*.opentransportdata.swiss"];

// Schema DDL

function createSchemaDDL(schema: string): string {
  return `
    CREATE EXTENSION IF NOT EXISTS postgis;
    DROP SCHEMA IF EXISTS "${schema}" CASCADE;
    CREATE SCHEMA "${schema}";

    CREATE TABLE "${schema}".agency (
      agency_id TEXT PRIMARY KEY DEFAULT '',
      agency_name TEXT NOT NULL DEFAULT '',
      agency_url TEXT,
      agency_timezone TEXT,
      agency_lang TEXT,
      agency_phone TEXT,
      agency_fare_url TEXT,
      agency_email TEXT
    );

    CREATE TABLE "${schema}".routes (
      route_id TEXT PRIMARY KEY,
      agency_id TEXT DEFAULT '' REFERENCES "${schema}".agency(agency_id),
      route_short_name TEXT DEFAULT '',
      route_long_name TEXT DEFAULT '',
      route_desc TEXT,
      route_type INTEGER NOT NULL DEFAULT 3,
      route_url TEXT,
      route_color TEXT,
      route_text_color TEXT,
      route_sort_order INTEGER
    );

    CREATE TABLE "${schema}".stops (
      stop_id TEXT PRIMARY KEY,
      stop_code TEXT,
      stop_name TEXT DEFAULT '',
      stop_desc TEXT,
      stop_lat DOUBLE PRECISION,
      stop_lon DOUBLE PRECISION,
      stop_loc GEOGRAPHY(POINT, 4326),
      zone_id TEXT,
      stop_url TEXT,
      location_type INTEGER DEFAULT 0,
      parent_station TEXT,
      stop_timezone TEXT,
      wheelchair_boarding INTEGER DEFAULT 0,
      platform_code TEXT,
      original_stop_id TEXT
    );

    CREATE TABLE "${schema}".calendar (
      service_id TEXT PRIMARY KEY,
      monday BOOLEAN NOT NULL DEFAULT false,
      tuesday BOOLEAN NOT NULL DEFAULT false,
      wednesday BOOLEAN NOT NULL DEFAULT false,
      thursday BOOLEAN NOT NULL DEFAULT false,
      friday BOOLEAN NOT NULL DEFAULT false,
      saturday BOOLEAN NOT NULL DEFAULT false,
      sunday BOOLEAN NOT NULL DEFAULT false,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL
    );

    CREATE TABLE "${schema}".calendar_dates (
      service_id TEXT NOT NULL,
      date DATE NOT NULL,
      exception_type INTEGER NOT NULL
    );

    CREATE TABLE "${schema}".trips (
      trip_id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL REFERENCES "${schema}".routes(route_id),
      service_id TEXT NOT NULL,
      trip_headsign TEXT,
      trip_short_name TEXT,
      direction_id INTEGER,
      block_id TEXT,
      shape_id TEXT,
      wheelchair_accessible INTEGER DEFAULT 0,
      bikes_allowed INTEGER DEFAULT 0
    );

    CREATE TABLE "${schema}".stop_times (
      trip_id TEXT NOT NULL,
      arrival_time INTERVAL,
      departure_time INTERVAL,
      stop_id TEXT NOT NULL,
      stop_sequence INTEGER NOT NULL,
      stop_headsign TEXT,
      pickup_type INTEGER DEFAULT 0,
      drop_off_type INTEGER DEFAULT 0,
      shape_dist_traveled DOUBLE PRECISION,
      timepoint INTEGER DEFAULT 1
    );

    CREATE TABLE "${schema}".shapes (
      shape_id TEXT NOT NULL,
      shape_pt_lat DOUBLE PRECISION NOT NULL,
      shape_pt_lon DOUBLE PRECISION NOT NULL,
      shape_pt_sequence INTEGER NOT NULL,
      shape_dist_traveled DOUBLE PRECISION
    );
  `;
}

function createIndexesDDL(schema: string): string {
  return `
    CREATE INDEX IF NOT EXISTS idx_stops_loc ON "${schema}".stops USING GIST (stop_loc);
    CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON "${schema}".stop_times (stop_id);
    CREATE INDEX IF NOT EXISTS idx_stop_times_trip ON "${schema}".stop_times (trip_id, stop_sequence);
    CREATE INDEX IF NOT EXISTS idx_trips_service ON "${schema}".trips (service_id);
    CREATE INDEX IF NOT EXISTS idx_trips_route ON "${schema}".trips (route_id);
    CREATE INDEX IF NOT EXISTS idx_calendar_dates_pk ON "${schema}".calendar_dates (service_id, date);
    CREATE INDEX IF NOT EXISTS idx_shapes_pk ON "${schema}".shapes (shape_id, shape_pt_sequence);
  `;
}

function createServiceDaysDDL(schema: string): string {
  return `
    CREATE MATERIALIZED VIEW "${schema}".service_days AS
    SELECT c.service_id, d::date AS date
    FROM "${schema}".calendar c
    CROSS JOIN LATERAL generate_series(c.start_date, c.end_date, '1 day'::interval) d
    WHERE CASE EXTRACT(DOW FROM d)
      WHEN 0 THEN c.sunday
      WHEN 1 THEN c.monday
      WHEN 2 THEN c.tuesday
      WHEN 3 THEN c.wednesday
      WHEN 4 THEN c.thursday
      WHEN 5 THEN c.friday
      WHEN 6 THEN c.saturday
    END
    AND NOT EXISTS (
      SELECT 1 FROM "${schema}".calendar_dates cd
      WHERE cd.service_id = c.service_id AND cd.date = d::date AND cd.exception_type = 2
    )
    UNION
    SELECT cd.service_id, cd.date
    FROM "${schema}".calendar_dates cd
    WHERE cd.exception_type = 1;

    CREATE UNIQUE INDEX ON "${schema}".service_days (service_id, date);
    CREATE INDEX ON "${schema}".service_days (date);
  `;
}

// Download & Extract

function isSwissOpenDataUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "opentransportdata.swiss" || hostname.endsWith(".opentransportdata.swiss");
  } catch {
    return false;
  }
}

function trustedSwissRedirectHosts(url: string): string[] {
  return [new URL(url).hostname, ...SWISS_REDIRECT_HOSTS];
}

async function resolveGtfsDownloadUrl(url: string): Promise<string> {
  validatePublicUrl(url);
  if (!isSwissOpenDataUrl(url)) return url;

  const response = await fetchWithRedirects(url, {
    allowedRedirectHosts: trustedSwissRedirectHosts(url),
    follow203Redirect: true,
    headers: {
      Accept: "application/zip, application/octet-stream, */*;q=0.1",
      "User-Agent": USER_AGENT,
    },
    timeoutMs: 300_000,
  });

  try {
    if (!response.ok) {
      throw new Error(`GTFS feed request failed (${response.status}) for ${url}`);
    }
    const resolvedUrl = response.url || url;
    validatePublicUrl(resolvedUrl);
    return resolvedUrl;
  } finally {
    if (response.body) await response.body.cancel().catch(() => {});
  }
}

/**
 * Where the importer should obtain a GTFS zip:
 *   - "url"       — fetch from upstream via the safe downloader (existing behaviour).
 *   - "localPath" — read an already-downloaded zip from disk (data-manager's
 *                   `/data/gtfs/` is the canonical source, exposed to apps/api
 *                   via the OPENMAPX_HOST_DIR bind mount). Avoids re-downloading
 *                   feeds the Transitous pipeline already fetched for MOTIS.
 */
export type GtfsImportSource = { kind: "url"; url: string } | { kind: "localPath"; path: string };

async function obtainGtfsZip(source: GtfsImportSource, zipPath: string): Promise<void> {
  if (source.kind === "url") {
    const downloadUrl = await resolveGtfsDownloadUrl(source.url);
    // Use the shared safe downloader: validates public URL + DNS, handles
    // redirects manually through allowlist/validator, enforces a hard byte cap.
    await safeDownload(downloadUrl, {
      destPath: zipPath,
      timeoutMs: 300_000,
      maxBytes: 2 * 1024 * 1024 * 1024, // 2 GiB cap for GTFS zips
      headers: { "User-Agent": USER_AGENT },
    });
    return;
  }
  // Local source — copy into the temp dir so the rest of the pipeline (unzip,
  // hash, schema-validation cleanup) can treat it identically to a downloaded
  // archive. The caller is responsible for confining `path` to a known-safe
  // directory; the route handler that exposes this surface looks up the file
  // by archive id against `getMotisGtfsArchives()`, so user input never reaches
  // here directly.
  if (!existsSync(source.path) || !statSync(source.path).isFile()) {
    throw new Error(`GTFS archive not found at ${source.path}`);
  }
  copyFileSync(source.path, zipPath);
}

async function obtainAndExtract(source: GtfsImportSource, tempDir: string): Promise<string> {
  mkdirSync(tempDir, { recursive: true });
  const zipPath = join(tempDir, "feed.zip");

  await obtainGtfsZip(source, zipPath);

  // Compute hash
  const hash = createHash("sha256").update(readFileSync(zipPath)).digest("hex");

  // Extract
  const extractDir = join(tempDir, "extracted");
  mkdirSync(extractDir, { recursive: true });
  execFileSync("unzip", ["-o", "-q", zipPath, "-d", extractDir], {
    timeout: 120_000,
  });

  // GTFS files might be in a subdirectory — find the directory containing stops.txt
  let gtfsDir = extractDir;
  if (!existsSync(join(extractDir, "stops.txt"))) {
    const subdirs = readdirSync(extractDir, { withFileTypes: true });
    for (const d of subdirs) {
      if (d.isDirectory() && existsSync(join(extractDir, d.name, "stops.txt"))) {
        gtfsDir = join(extractDir, d.name);
        break;
      }
    }
  }

  // Store hash in a temp file for later retrieval
  writeFileSync(join(tempDir, "hash.txt"), hash);

  return gtfsDir;
}

function getHash(tempDir: string): string {
  try {
    return readFileSync(join(tempDir, "hash.txt"), "utf-8").trim();
  } catch {
    return "";
  }
}

// Batch Insert Helpers

async function batchInsert(
  schema: string,
  table: string,
  columns: string[],
  rows: (string | number | boolean | null)[][],
): Promise<void> {
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const placeholders = batch
      .map((row, ri) => `(${row.map((_, ci) => `$${ri * columns.length + ci + 1}`).join(", ")})`)
      .join(", ");
    const values = batch.flat();
    const cols = columns.map((c) => `"${c}"`).join(", ");

    await sql.unsafe(
      `INSERT INTO "${schema}"."${table}" (${cols}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      values,
    );
  }
}

// Import Individual GTFS Files

async function importAgency(schema: string, gtfsDir: string): Promise<void> {
  const path = join(gtfsDir, "agency.txt");
  if (!existsSync(path)) {
    // Insert a default agency if no file exists
    await sql.unsafe(
      `INSERT INTO "${schema}".agency (agency_id, agency_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      ["", "Unknown Agency"],
    );
    return;
  }
  const rows = parseCsv(readFileSync(path, "utf-8"));
  const data = rows.map((r) => [
    r.agency_id ?? "",
    r.agency_name ?? "",
    r.agency_url ?? null,
    r.agency_timezone ?? null,
    r.agency_lang ?? null,
    r.agency_phone ?? null,
    r.agency_fare_url ?? null,
    r.agency_email ?? null,
  ]);
  await batchInsert(
    schema,
    "agency",
    [
      "agency_id",
      "agency_name",
      "agency_url",
      "agency_timezone",
      "agency_lang",
      "agency_phone",
      "agency_fare_url",
      "agency_email",
    ],
    data,
  );
}

async function importStops(schema: string, gtfsDir: string): Promise<number> {
  const path = join(gtfsDir, "stops.txt");
  if (!existsSync(path)) return 0;
  const rows = parseCsv(readFileSync(path, "utf-8"));
  const data = rows.map((r) => [
    r.stop_id ?? "",
    r.stop_code ?? null,
    r.stop_name ?? "",
    r.stop_desc ?? null,
    r.stop_lat ? Number.parseFloat(r.stop_lat) : null,
    r.stop_lon ? Number.parseFloat(r.stop_lon) : null,
    r.zone_id ?? null,
    r.stop_url ?? null,
    r.location_type ? Number.parseInt(r.location_type, 10) : 0,
    r.parent_station || null,
    r.stop_timezone ?? null,
    r.wheelchair_boarding ? Number.parseInt(r.wheelchair_boarding, 10) : 0,
    r.platform_code ?? null,
    r.original_stop_id ?? null,
  ]);
  await batchInsert(
    schema,
    "stops",
    [
      "stop_id",
      "stop_code",
      "stop_name",
      "stop_desc",
      "stop_lat",
      "stop_lon",
      "zone_id",
      "stop_url",
      "location_type",
      "parent_station",
      "stop_timezone",
      "wheelchair_boarding",
      "platform_code",
      "original_stop_id",
    ],
    data,
  );

  // Populate PostGIS column from lat/lon
  await sql.unsafe(`
    UPDATE "${schema}".stops
    SET stop_loc = ST_SetSRID(ST_MakePoint(stop_lon, stop_lat), 4326)::geography
    WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL
  `);

  return rows.length;
}

async function importRoutes(schema: string, gtfsDir: string): Promise<number> {
  const path = join(gtfsDir, "routes.txt");
  if (!existsSync(path)) return 0;
  const rows = parseCsv(readFileSync(path, "utf-8"));

  // Collect referenced agency_ids and ensure they exist
  const agencyIds = new Set(rows.map((r) => r.agency_id ?? ""));
  for (const id of agencyIds) {
    await sql.unsafe(
      `INSERT INTO "${schema}".agency (agency_id, agency_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, id || "Unknown"],
    );
  }

  const data = rows.map((r) => [
    r.route_id ?? "",
    r.agency_id ?? "",
    r.route_short_name ?? "",
    r.route_long_name ?? "",
    r.route_desc ?? null,
    r.route_type ? Number.parseInt(r.route_type, 10) : 3,
    r.route_url ?? null,
    r.route_color ?? null,
    r.route_text_color ?? null,
    r.route_sort_order ? Number.parseInt(r.route_sort_order, 10) : null,
  ]);
  await batchInsert(
    schema,
    "routes",
    [
      "route_id",
      "agency_id",
      "route_short_name",
      "route_long_name",
      "route_desc",
      "route_type",
      "route_url",
      "route_color",
      "route_text_color",
      "route_sort_order",
    ],
    data,
  );
  return rows.length;
}

async function importCalendar(schema: string, gtfsDir: string): Promise<void> {
  const path = join(gtfsDir, "calendar.txt");
  if (!existsSync(path)) return;
  const rows = parseCsv(readFileSync(path, "utf-8"));
  const data = rows.map((r) => [
    r.service_id ?? "",
    r.monday === "1",
    r.tuesday === "1",
    r.wednesday === "1",
    r.thursday === "1",
    r.friday === "1",
    r.saturday === "1",
    r.sunday === "1",
    gtfsDate(r.start_date ?? ""),
    gtfsDate(r.end_date ?? ""),
  ]);
  await batchInsert(
    schema,
    "calendar",
    [
      "service_id",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
      "start_date",
      "end_date",
    ],
    data,
  );
}

async function importCalendarDates(schema: string, gtfsDir: string): Promise<void> {
  const path = join(gtfsDir, "calendar_dates.txt");
  if (!existsSync(path)) return;
  const rows = parseCsv(readFileSync(path, "utf-8"));
  const data = rows.map((r) => [
    r.service_id ?? "",
    gtfsDate(r.date ?? ""),
    r.exception_type ? Number.parseInt(r.exception_type, 10) : 1,
  ]);
  await batchInsert(schema, "calendar_dates", ["service_id", "date", "exception_type"], data);
}

async function importTrips(schema: string, gtfsDir: string): Promise<number> {
  const path = join(gtfsDir, "trips.txt");
  if (!existsSync(path)) return 0;
  const rows = parseCsv(readFileSync(path, "utf-8"));
  const data = rows.map((r) => [
    r.trip_id ?? "",
    r.route_id ?? "",
    r.service_id ?? "",
    r.trip_headsign ?? null,
    r.trip_short_name ?? null,
    r.direction_id ? Number.parseInt(r.direction_id, 10) : null,
    r.block_id ?? null,
    r.shape_id ?? null,
    r.wheelchair_accessible ? Number.parseInt(r.wheelchair_accessible, 10) : 0,
    r.bikes_allowed ? Number.parseInt(r.bikes_allowed, 10) : 0,
  ]);
  await batchInsert(
    schema,
    "trips",
    [
      "trip_id",
      "route_id",
      "service_id",
      "trip_headsign",
      "trip_short_name",
      "direction_id",
      "block_id",
      "shape_id",
      "wheelchair_accessible",
      "bikes_allowed",
    ],
    data,
  );
  return rows.length;
}

async function importStopTimes(schema: string, gtfsDir: string): Promise<void> {
  const path = join(gtfsDir, "stop_times.txt");
  if (!existsSync(path)) return;

  const columns = [
    "trip_id",
    "arrival_time",
    "departure_time",
    "stop_id",
    "stop_sequence",
    "stop_headsign",
    "pickup_type",
    "drop_off_type",
    "shape_dist_traveled",
    "timepoint",
  ];

  // Stream line-by-line to avoid OOM on large feeds (can be 500MB+)
  for await (const batch of streamCsvBatches(path, BATCH_SIZE)) {
    const data = batch.map((r) => [
      r.trip_id ?? "",
      r.arrival_time || null,
      r.departure_time || null,
      r.stop_id ?? "",
      r.stop_sequence ? Number.parseInt(r.stop_sequence, 10) : 0,
      r.stop_headsign ?? null,
      r.pickup_type ? Number.parseInt(r.pickup_type, 10) : 0,
      r.drop_off_type ? Number.parseInt(r.drop_off_type, 10) : 0,
      r.shape_dist_traveled ? Number.parseFloat(r.shape_dist_traveled) : null,
      r.timepoint ? Number.parseInt(r.timepoint, 10) : 1,
    ]);
    await batchInsert(schema, "stop_times", columns, data);
  }
}

async function importShapes(schema: string, gtfsDir: string): Promise<void> {
  const path = join(gtfsDir, "shapes.txt");
  if (!existsSync(path)) return;

  const columns = [
    "shape_id",
    "shape_pt_lat",
    "shape_pt_lon",
    "shape_pt_sequence",
    "shape_dist_traveled",
  ];

  // Stream line-by-line to avoid OOM on large feeds
  for await (const batch of streamCsvBatches(path, BATCH_SIZE)) {
    const data = batch.map((r) => [
      r.shape_id ?? "",
      Number.parseFloat(r.shape_pt_lat ?? "0"),
      Number.parseFloat(r.shape_pt_lon ?? "0"),
      Number.parseInt(r.shape_pt_sequence ?? "0", 10),
      r.shape_dist_traveled ? Number.parseFloat(r.shape_dist_traveled) : null,
    ]);
    await batchInsert(schema, "shapes", columns, data);
  }
}

// Compute Feed Bounding Box

async function computeBbox(schema: string): Promise<[number, number, number, number] | null> {
  const result = await sql.unsafe(`
    SELECT
      MIN(stop_lon) as west,
      MIN(stop_lat) as south,
      MAX(stop_lon) as east,
      MAX(stop_lat) as north
    FROM "${schema}".stops
    WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL
      AND location_type IN (0, 1)
  `);
  const row = result[0];
  if (!row?.west || !row?.south || !row?.east || !row?.north) return null;
  return [Number(row.west), Number(row.south), Number(row.east), Number(row.north)];
}

// Main Import Function

export interface ImportResult {
  schema: string;
  hash: string;
  stopCount: number;
  routeCount: number;
  tripCount: number;
  bbox: [number, number, number, number] | null;
}

export async function importGtfsFeed(
  source: string | GtfsImportSource,
  schema: string,
  onProgress?: (stage: string) => void,
): Promise<ImportResult> {
  assertValidGtfsSchema(schema);
  // Backwards-compat: callers that still pass a bare URL get the same
  // download-then-import flow as before.
  const normalized: GtfsImportSource =
    typeof source === "string" ? { kind: "url", url: source } : source;
  // Use mkdtempSync so the temp path is OS-generated — caller-derived data
  // never ends up in the filesystem path, and concurrent imports cannot collide.
  const tempDir = mkdtempSync(join(tmpdir(), "gtfs-import-"));

  try {
    // 1. Obtain the zip (download or copy local) and extract
    onProgress?.(normalized.kind === "url" ? "downloading" : "reading local archive");
    const gtfsDir = await obtainAndExtract(normalized, tempDir);
    const hash = getHash(tempDir);

    // 2. Create schema and tables (DROP/CREATE in DDL resets column layout; drop stale caches)
    onProgress?.("creating schema");
    invalidateSchemaCaches(schema);
    await sql.unsafe(createSchemaDDL(schema));

    // 3. Import data (order matters for FK constraints)
    onProgress?.("importing agency");
    await importAgency(schema, gtfsDir);

    onProgress?.("importing stops");
    const stopCount = await importStops(schema, gtfsDir);

    onProgress?.("importing routes");
    const routeCount = await importRoutes(schema, gtfsDir);

    onProgress?.("importing calendar");
    await importCalendar(schema, gtfsDir);
    await importCalendarDates(schema, gtfsDir);

    onProgress?.("importing trips");
    const tripCount = await importTrips(schema, gtfsDir);

    onProgress?.("importing stop_times");
    await importStopTimes(schema, gtfsDir);

    onProgress?.("importing shapes");
    await importShapes(schema, gtfsDir);

    // 4. Create indexes
    onProgress?.("creating indexes");
    await sql.unsafe(createIndexesDDL(schema));

    // 5. Create service_days materialized view
    onProgress?.("creating service_days view");
    const hasCalendar =
      (await sql.unsafe(`SELECT COUNT(*) as c FROM "${schema}".calendar`))[0].c > 0;
    const hasCalendarDates =
      (await sql.unsafe(`SELECT COUNT(*) as c FROM "${schema}".calendar_dates`))[0].c > 0;

    if (hasCalendar || hasCalendarDates) {
      await sql.unsafe(createServiceDaysDDL(schema));
    }

    // 6. Compute bounding box
    const bbox = await computeBbox(schema);

    return { schema, hash, stopCount, routeCount, tripCount, bbox };
  } finally {
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

/** Remove an imported GTFS schema entirely. */
export async function dropGtfsSchema(schema: string): Promise<void> {
  assertValidGtfsSchema(schema);
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  invalidateSchemaCaches(schema);
}

/**
 * Hash a GTFS zip on disk (sha256). Same algorithm the importer uses on the
 * temp copy after extraction, so a matching value means the bytes are
 * byte-identical to the last successful import. Used by the manager to
 * skip the COPY pipeline when a re-import would produce the same schema.
 */
export function hashGtfsArchive(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
