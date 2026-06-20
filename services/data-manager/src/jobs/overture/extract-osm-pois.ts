import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OsmFilter } from "@openmapx/core/utils/osmCategoryFilters";
import { CATEGORY_FILTERS } from "@openmapx/core/utils/osmCategoryFilters";
import { execa } from "execa";
import { sql } from "../../db/index.js";
import { assertValidRegion } from "./pull.js";
import { applyOsmPoisTable } from "./schema.js";

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
  pbfPath: string;
  dataDir: string;
  region: string;
  onProgress?: (msg: string) => void;
}

export interface OsmPoiRecord {
  osmType: "node" | "way" | "relation";
  osmId: string;
  name: string;
  lat: number;
  lng: number;
  category: string | undefined;
  tags: Record<string, string>;
}

/**
 * Extracts named POIs from a local OSM PBF file using `osmium tags-filter`,
 * writing a GeoJSON output that is then parsed into structured records.
 *
 * This shells out to `osmium` (same pattern as convert-overpass.ts) so the
 * heavy XML/PBF work stays in the C++ tool rather than Node.
 */
export async function extractOsmPois(opts: ExtractOsmPoisOptions): Promise<OsmPoiRecord[]> {
  assertValidRegion(opts.region);
  const outDir = join(opts.dataDir, "overture", "osm-extract");
  const outPath = join(outDir, `${opts.region.replace(/\//g, "-")}-pois.geojson`);

  const filterExpressions: string[] = [];
  for (const filters of Object.values(CATEGORY_FILTERS)) {
    for (const { key, value } of filters) {
      filterExpressions.push(`${key}=${value}`);
    }
  }
  const uniqueFilters = [...new Set(filterExpressions)];

  opts.onProgress?.(`Extracting OSM POIs from ${opts.pbfPath}...`);
  mkdirSync(outDir, { recursive: true });

  await execa(
    "osmium",
    [
      "tags-filter",
      opts.pbfPath,
      "nwr/name",
      ...uniqueFilters.map((f) => `nwr/${f}`),
      "-o",
      outPath,
      "--output-format",
      "geojson",
      "-O",
    ],
    { stdio: "inherit" },
  );

  opts.onProgress?.(`Parsing ${outPath}...`);

  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(outPath, "utf8");
  const geojson = JSON.parse(raw) as {
    features: Array<{
      type: string;
      id?: string;
      geometry: { type: string; coordinates: unknown };
      properties: Record<string, string>;
    }>;
  };

  const records: OsmPoiRecord[] = [];
  for (const feature of geojson.features ?? []) {
    const props = feature.properties ?? {};
    const name = props.name;
    if (!name) continue;

    let lat: number;
    let lng: number;
    const geom = feature.geometry;

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
      if (!coords) continue;
      [lng, lat] = coords;
    } else {
      continue;
    }

    let osmType: "node" | "way" | "relation" = "node";
    let osmId = "";
    const rawId = feature.id ?? "";
    if (typeof rawId === "string") {
      if (rawId.startsWith("node/")) {
        osmType = "node";
        osmId = rawId.slice(5);
      } else if (rawId.startsWith("way/")) {
        osmType = "way";
        osmId = rawId.slice(4);
      } else if (rawId.startsWith("relation/")) {
        osmType = "relation";
        osmId = rawId.slice(9);
      } else {
        osmId = rawId;
      }
    }

    const category = osmTagsToCategory(props);
    records.push({ osmType, osmId, name, lat, lng, category, tags: props });
  }

  opts.onProgress?.(`Extracted ${records.length} POIs.`);

  const schema = "overture_places";
  opts.onProgress?.("Ensuring osm_pois table exists...");
  await applyOsmPoisTable(schema);
  await upsertOsmPois(schema, records);
  opts.onProgress?.(`Persisted ${records.length} OSM POIs to ${schema}.osm_pois.`);

  return records;
}

/**
 * Computes a representative [lng, lat] point for non-Point geometries.
 * For LineString: mean of all coordinates.
 * For Polygon: mean of the outer ring coordinates.
 * For MultiPolygon: mean of the first polygon's outer ring.
 * Returns null if no usable coordinates are present.
 */
function representativePoint(geom: {
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
  let sumLng = 0;
  let sumLat = 0;
  for (const [lngVal, latVal] of ring) {
    sumLng += lngVal;
    sumLat += latVal;
  }
  return [sumLng / ring.length, sumLat / ring.length];
}

const OSM_POIS_INSERT_BATCH = 500;

/**
 * Batch-upserts OSM POI records into `<schema>.osm_pois`.
 * osm_id is BIGINT in the table; OsmPoiRecord.osmId is a numeric string — we
 * parse it with parseInt and pass as a number so postgres-js can send it.
 * The ON CONFLICT clause makes re-runs idempotent.
 */
async function upsertOsmPois(schema: string, records: OsmPoiRecord[]): Promise<void> {
  if (records.length === 0) return;

  for (let i = 0; i < records.length; i += OSM_POIS_INSERT_BATCH) {
    const batch = records.slice(i, i + OSM_POIS_INSERT_BATCH);

    const osmTypes = batch.map((r) => r.osmType);
    const osmIds = batch.map((r) => parseInt(r.osmId, 10));
    const names = batch.map((r) => r.name);
    const lats = batch.map((r) => r.lat);
    const lngs = batch.map((r) => r.lng);
    const categories = batch.map((r) => r.category ?? null);
    const tags = batch.map((r) => JSON.stringify(r.tags));

    await sql.unsafe(
      `INSERT INTO "${schema}".osm_pois
         (osm_type, osm_id, name, lat, lng, category, tags)
       SELECT
         UNNEST($1::TEXT[]),
         UNNEST($2::BIGINT[]),
         UNNEST($3::TEXT[]),
         UNNEST($4::DOUBLE PRECISION[]),
         UNNEST($5::DOUBLE PRECISION[]),
         UNNEST($6::TEXT[]),
         UNNEST($7::JSONB[])
       ON CONFLICT (osm_type, osm_id) DO UPDATE
         SET name     = EXCLUDED.name,
             lat      = EXCLUDED.lat,
             lng      = EXCLUDED.lng,
             category = EXCLUDED.category,
             tags     = EXCLUDED.tags`,
      [osmTypes, osmIds, names, lats, lngs, categories, tags],
    );
  }
}
