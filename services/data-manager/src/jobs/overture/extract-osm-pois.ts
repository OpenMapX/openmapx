import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OsmFilter } from "@openmapx/core/utils/osmCategoryFilters";
import { CATEGORY_FILTERS } from "@openmapx/core/utils/osmCategoryFilters";
import { execa } from "execa";
import { latLngToCell } from "h3-js";
import { sql } from "../../db/index.js";
import { osmPbfName } from "../download-osm.js";
import { assertValidRegion } from "./pull.js";

export type { OsmFilter };

const osmTagMap = new Map<string, string>();
for (const [catId, filters] of Object.entries(CATEGORY_FILTERS)) {
  for (const { key, value } of filters) {
    osmTagMap.set(`${key}=${value}`, catId);
  }
}

/**
 * Maps a set of OSM tags to the first matching OpenMapX category, using the
 * CATEGORY_FILTERS reverse index. Returns `undefined` when no filter matches.
 */
export function osmTagsToCategory(tags: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(tags)) {
    const catId = osmTagMap.get(`${key}=${value}`);
    if (catId) return catId;
  }
  return undefined;
}

export interface ExtractOsmPoisOptions {
  /** Defaults to the region's downloaded PBF: <dataDir>/osm/<osmPbfName(region)>. */
  pbfPath?: string;
  dataDir: string;
  region: string;
  onProgress?: (msg: string) => void;
  /** Durable-job heartbeat invoked after each streamed database batch. */
  onCheckpoint?: (extracted: number) => Promise<void>;
}

/** Execa must not retain the country-scale GeoJSON stream in memory. */
export const OSMIUM_EXPORT_STREAM_OPTIONS = {
  stdout: "pipe",
  stderr: "inherit",
  buffer: false,
} as const;

export interface OsmPoiRecord {
  osmType: "node" | "way" | "relation";
  osmId: string;
  name: string;
  lat: number;
  lng: number;
  h3R8: string;
  category: string | undefined;
  tags: Record<string, string>;
}

interface GeoJsonFeature {
  type?: string;
  id?: string;
  geometry?: { type: string; coordinates: unknown };
  properties?: Record<string, unknown>;
}

function sourceIdentity(feature: GeoJsonFeature): {
  osmType: "node" | "way" | "relation";
  osmId: string;
} | null {
  const attributeType = feature.properties?.["@type"];
  const attributeId = feature.properties?.["@id"];
  if (
    (attributeType === "node" || attributeType === "way" || attributeType === "relation") &&
    (typeof attributeId === "string" || typeof attributeId === "number")
  ) {
    const osmId = String(attributeId);
    if (/^-?\d+$/.test(osmId)) return { osmType: attributeType, osmId };
  }

  const match = /^([nwa])(-?\d+)$/.exec(feature.id ?? "");
  if (!match) return null;
  const [, kind, encodedId] = match;
  if (kind === "n") return { osmType: "node", osmId: encodedId };
  if (kind === "w") return { osmType: "way", osmId: encodedId };

  // Osmium area IDs encode the source object: 2*way or 2*relation+1.
  const areaId = BigInt(encodedId);
  if (areaId < 0n) return null;
  return areaId % 2n === 0n
    ? { osmType: "way", osmId: String(areaId / 2n) }
    : { osmType: "relation", osmId: String((areaId - 1n) / 2n) };
}

/**
 * Maps one osmium-exported GeoJSON feature to an OsmPoiRecord, or null when it
 * is unnamed, lacks a usable geometry, or has no parseable id. osmium
 * `--add-unique-id=type_id` emits ids like n123 / w123 / r123.
 *
 * Exported for testing only — internal helper used by `extractOsmPois`.
 */
export function featureToOsmPoiRecord(feature: GeoJsonFeature): OsmPoiRecord | null {
  const props = Object.fromEntries(
    Object.entries(feature.properties ?? {}).filter(
      ([key, value]) => !key.startsWith("@") && typeof value === "string",
    ),
  ) as Record<string, string>;
  const name = props.name;
  if (!name) return null;

  const geom = feature.geometry;
  if (!geom) return null;

  let lat: number;
  let lng: number;
  if (geom.type === "Point") {
    const [lngVal, latVal] = geom.coordinates as number[];
    lng = lngVal;
    lat = latVal;
  } else if (
    geom.type === "LineString" ||
    geom.type === "Polygon" ||
    geom.type === "MultiPolygon"
  ) {
    const coords = representativePoint(geom);
    if (!coords) return null;
    [lng, lat] = coords;
  } else {
    return null;
  }
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return null;
  }

  const identity = sourceIdentity(feature);
  if (!identity) return null;

  const category = osmTagsToCategory(props);
  return { ...identity, name, lat, lng, h3R8: latLngToCell(lat, lng, 8), category, tags: props };
}

/**
 * Extracts named POIs from a local OSM PBF file using `osmium tags-filter`,
 * writing a GeoJSON output that is then parsed into structured records.
 *
 * This shells out to `osmium` (same pattern as convert-overpass.ts) so the
 * heavy XML/PBF work stays in the C++ tool rather than Node.
 */
export async function extractOsmPois(opts: ExtractOsmPoisOptions): Promise<{ extracted: number }> {
  assertValidRegion(opts.region);
  const pbfPath = opts.pbfPath ?? join(opts.dataDir, "osm", osmPbfName(opts.region));
  const outDir = join(opts.dataDir, "overture", "osm-extract");
  const slug = opts.region.replace(/\//g, "-");
  const filteredPbf = join(outDir, `${slug}-pois.osm.pbf`);

  const filterExpressions: string[] = [];
  for (const filters of Object.values(CATEGORY_FILTERS)) {
    for (const { key, value } of filters) {
      filterExpressions.push(`${key}=${value}`);
    }
  }
  const uniqueFilters = [...new Set(filterExpressions)];

  opts.onProgress?.(`Extracting OSM POIs from ${pbfPath}...`);
  mkdirSync(outDir, { recursive: true });

  // osmium tags-filter only emits OSM formats, so filter to a temp PBF first,
  // then convert that to GeoJSON via osmium export (a single tags-filter →
  // geojson step is rejected by osmium).
  await execa(
    "osmium",
    ["tags-filter", pbfPath, ...uniqueFilters.map((f) => `nwr/${f}`), "-o", filteredPbf, "-O"],
    { stdio: "inherit" },
  );
  const schema = "overture_places";
  const stagingTable = "osm_pois__staging";
  opts.onProgress?.("Preparing a fresh OSM POI staging table...");
  await sql.unsafe(`DROP TABLE IF EXISTS "${schema}"."${stagingTable}"`);
  await sql.unsafe(
    `CREATE UNLOGGED TABLE "${schema}"."${stagingTable}"
       (LIKE "${schema}".osm_pois INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
  );
  await sql.unsafe(`ALTER TABLE "${schema}"."${stagingTable}" ADD PRIMARY KEY (osm_type, osm_id)`);

  // GeoJSON Text Sequence (one feature per line). Stream stdout directly into
  // the database pipeline: a country-sized intermediate is gigabytes and does
  // not need to exist either as one Node string or as another on-disk file.
  const exportProcess = execa(
    "osmium",
    ["export", "-f", "geojsonseq", "--add-unique-id=type_id", "--attributes=type,id", filteredPbf],
    // Execa buffers piped output by default. Germany-scale GeoJSON exceeds
    // that buffer, so consume stdout exclusively through the line iterator.
    OSMIUM_EXPORT_STREAM_OPTIONS,
  );
  opts.onProgress?.("Streaming osmium GeoJSON output into PostGIS...");
  const { createInterface } = await import("node:readline");
  if (!exportProcess.stdout) {
    exportProcess.kill("SIGTERM");
    await exportProcess.catch(() => undefined);
    throw new Error("osmium export did not provide a stdout stream");
  }
  const rl = createInterface({
    input: exportProcess.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let extracted = 0;
  let records: OsmPoiRecord[] = [];
  try {
    for await (const rawLine of rl) {
      // geojsonseq may prefix each record with the RS (0x1e) control character.
      const line = (rawLine.charCodeAt(0) === 0x1e ? rawLine.slice(1) : rawLine).trim();
      if (!line) continue;
      let feature: GeoJsonFeature;
      try {
        feature = JSON.parse(line);
      } catch {
        continue;
      }
      const record = featureToOsmPoiRecord(feature);
      if (!record) continue;
      records.push(record);
      extracted += 1;
      if (records.length >= OSM_POIS_INSERT_BATCH) {
        await insertOsmPois(schema, stagingTable, records);
        records = [];
        await opts.onCheckpoint?.(extracted);
        if (extracted % 25_000 === 0) {
          opts.onProgress?.(`Streamed ${extracted} OSM POIs into PostGIS...`);
        }
      }
    }
    await insertOsmPois(schema, stagingTable, records);
    await exportProcess;
  } catch (error) {
    exportProcess.kill("SIGTERM");
    await exportProcess.catch(() => undefined);
    throw error;
  } finally {
    rl.close();
  }

  opts.onProgress?.(`Extracted ${extracted} POIs; publishing the staged snapshot...`);
  await sql.begin(async (tx) => {
    await tx.unsafe(`DROP TABLE IF EXISTS "${schema}".osm_pois__previous`);
    await tx.unsafe(`ALTER TABLE "${schema}".osm_pois RENAME TO osm_pois__previous`);
    await tx.unsafe(`ALTER TABLE "${schema}"."${stagingTable}" RENAME TO osm_pois`);
    await tx.unsafe(`DROP TABLE "${schema}".osm_pois__previous`);
    await tx.unsafe(`CREATE INDEX idx_osm_pois_category ON "${schema}".osm_pois (category)`);
    await tx.unsafe(
      `CREATE INDEX idx_osm_pois_h3
         ON "${schema}".osm_pois (h3_r8, osm_type, osm_id)`,
    );
    await tx.unsafe(
      `CREATE INDEX idx_osm_pois_geom
         ON "${schema}".osm_pois USING GIST (ST_Point(lng, lat))`,
    );
  });
  opts.onProgress?.(`Published ${extracted} OSM POIs to ${schema}.osm_pois.`);

  return { extracted };
}

/**
 * Exported for testing only — internal helper used by `extractOsmPois`.
 *
 * Computes a representative [lng, lat] point for non-Point geometries.
 * For LineString: mean of all coordinates.
 * For Polygon: mean of the outer ring coordinates.
 * For MultiPolygon: mean of the first polygon's outer ring.
 * Returns null if no usable coordinates are present.
 */
export function representativePoint(geom: {
  type: string;
  coordinates: unknown;
}): [number, number] | null {
  let ring: number[][];
  if (geom.type === "LineString") {
    ring = geom.coordinates as number[][];
  } else if (geom.type === "Polygon") {
    const poly = geom.coordinates as number[][][];
    ring = poly[0] ?? [];
  } else if (geom.type === "MultiPolygon") {
    const multi = geom.coordinates as number[][][][];
    ring = multi[0]?.[0] ?? [];
  } else {
    return null;
  }
  if (ring.length === 0) return null;
  let sumSin = 0;
  let sumCos = 0;
  let sumLat = 0;
  for (const [lngVal, latVal] of ring) {
    const rad = (lngVal * Math.PI) / 180;
    sumSin += Math.sin(rad);
    sumCos += Math.cos(rad);
    sumLat += latVal;
  }
  const meanLng = (Math.atan2(sumSin / ring.length, sumCos / ring.length) * 180) / Math.PI;
  return [meanLng, sumLat / ring.length];
}

const OSM_POIS_INSERT_BATCH = 5_000;

/** Keeps the last geometry emitted for an OSM object within one bounded batch. */
export function deduplicateOsmPoiRecords(records: OsmPoiRecord[]): OsmPoiRecord[] {
  const bySource = new Map<string, OsmPoiRecord>();
  for (const record of records) {
    bySource.set(`${record.osmType}:${record.osmId}`, record);
  }
  return [...bySource.values()];
}

/**
 * Batch-inserts OSM POI records into the fresh staging table.
 * osm_id is BIGINT in the table; OsmPoiRecord.osmId is a numeric string — we
 * parse it with parseInt and pass as a number so postgres-js can send it.
 * Osmium emits each OSM object once; a duplicate therefore fails the staged
 * extract instead of silently hiding a malformed snapshot.
 */
async function insertOsmPois(
  schema: string,
  table: "osm_pois__staging",
  records: OsmPoiRecord[],
): Promise<void> {
  if (records.length === 0) return;

  for (let i = 0; i < records.length; i += OSM_POIS_INSERT_BATCH) {
    const batch = deduplicateOsmPoiRecords(records.slice(i, i + OSM_POIS_INSERT_BATCH));

    const osmTypes = batch.map((r) => r.osmType);
    const osmIds = batch.map((r) => parseInt(r.osmId, 10));
    const names = batch.map((r) => r.name);
    const lats = batch.map((r) => r.lat);
    const lngs = batch.map((r) => r.lng);
    const h3Cells = batch.map((r) => r.h3R8);
    const categories = batch.map((r) => r.category ?? null);
    const tags = batch.map((r) => JSON.stringify(r.tags));

    await sql.unsafe(
      `INSERT INTO "${schema}"."${table}"
         (osm_type, osm_id, name, lat, lng, h3_r8, category, tags)
       SELECT
         UNNEST($1::TEXT[]),
         UNNEST($2::BIGINT[]),
         UNNEST($3::TEXT[]),
         UNNEST($4::DOUBLE PRECISION[]),
         UNNEST($5::DOUBLE PRECISION[]),
         UNNEST($6::TEXT[]),
         UNNEST($7::TEXT[]),
         UNNEST($8::JSONB[])
       ON CONFLICT (osm_type, osm_id) DO UPDATE SET
         name = EXCLUDED.name,
         lat = EXCLUDED.lat,
         lng = EXCLUDED.lng,
         h3_r8 = EXCLUDED.h3_r8,
         category = EXCLUDED.category,
         tags = EXCLUDED.tags`,
      [osmTypes, osmIds, names, lats, lngs, h3Cells, categories, tags],
    );
  }
}
