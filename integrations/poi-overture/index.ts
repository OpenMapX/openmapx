import type { BoundingBox } from "@openmapx/core";
import {
  createPlace,
  OVERTURE_COMMERCIAL_CATEGORIES,
  openMapXCategoryToOvertureConcepts,
  overtureTaxonomyToOpenMapX,
} from "@openmapx/core";
import type { DatabaseClient, IntegrationContext } from "@openmapx/integration-framework";
import type {
  CategoryId,
  PoiSearchProvider,
  PoiSearchResult,
} from "@openmapx/integration-poi-search/types";
import { registerPlaceResolver } from "@openmapx/place-ids";

interface OvertureRow {
  gers_id: string;
  name: string;
  longitude: number;
  latitude: number;
  basic_category: string | null;
  taxonomy_primary: string | null;
  taxonomy_hierarchy: string[] | null;
  taxonomy_alternates: string[] | null;
  brand_name: string | null;
  brand_wikidata: string | null;
  phone: string | null;
  website: string | null;
}

function overtureRowToPoiSearchResult(
  row: OvertureRow,
  requestedCategory?: CategoryId,
): PoiSearchResult {
  const osmTags: Record<string, string> = {};
  if (row.brand_name) osmTags.brand = row.brand_name;
  if (row.brand_wikidata) osmTags["brand:wikidata"] = row.brand_wikidata;

  const category =
    requestedCategory ??
    overtureTaxonomyToOpenMapX({
      basicCategory: row.basic_category,
      primary: row.taxonomy_primary,
      hierarchy: row.taxonomy_hierarchy,
      alternates: row.taxonomy_alternates,
    });

  return {
    id: `overture:${row.gers_id}`,
    gersId: row.gers_id,
    name: row.name || row.gers_id,
    coordinates: [row.longitude, row.latitude],
    category: category ?? undefined,
    phone: row.phone ?? undefined,
    website: row.website ?? undefined,
    osmTags: Object.keys(osmTags).length > 0 ? osmTags : undefined,
  };
}

async function queryOverturePlaces(
  db: DatabaseClient,
  opts: { bbox: BoundingBox; concepts: string[]; lang?: string; minConfidence: number },
): Promise<OvertureRow[]> {
  const { bbox, concepts, minConfidence } = opts;
  const sql = `
    SELECT
      gers_id,
      name,
      ST_X(geom) AS longitude,
      ST_Y(geom) AS latitude,
      basic_category,
      taxonomy_primary,
      taxonomy_hierarchy,
      taxonomy_alternates,
      brand->'names'->>'primary' AS brand_name,
      brand->>'wikidata' AS brand_wikidata,
      phones[1] AS phone,
      websites[1] AS website
    FROM overture_places.places
    WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      AND (operating_status IS NULL OR operating_status <> 'permanently_closed')
      AND (confidence IS NULL OR confidence >= $6)
      AND (
        basic_category = ANY($5::TEXT[])
        OR taxonomy_primary = ANY($5::TEXT[])
        OR taxonomy_hierarchy && $5::TEXT[]
        OR taxonomy_alternates && $5::TEXT[]
      )
    LIMIT 200
  `;
  const params: unknown[] = [bbox.west, bbox.south, bbox.east, bbox.north, concepts, minConfidence];
  return db.execute<OvertureRow[]>(sql, params);
}

async function fetchOverturePlaceByGers(
  db: DatabaseClient,
  gers: string,
  _lang?: string,
): Promise<OvertureRow | null> {
  const rows = await db.execute<OvertureRow[]>(
    `SELECT
       gers_id,
       name,
       ST_X(geom) AS longitude,
       ST_Y(geom) AS latitude,
       basic_category,
       taxonomy_primary,
       taxonomy_hierarchy,
       taxonomy_alternates,
       brand->'names'->>'primary' AS brand_name,
       brand->>'wikidata' AS brand_wikidata,
       phones[1] AS phone,
       websites[1] AS website
     FROM overture_places.places
     WHERE gers_id = $1
     LIMIT 1`,
    [gers],
  );
  return rows[0] ?? null;
}

function overtureRowToPlace(row: OvertureRow) {
  const osmTags: Record<string, string> = {};
  if (row.brand_name) osmTags.brand = row.brand_name;
  if (row.brand_wikidata) osmTags["brand:wikidata"] = row.brand_wikidata;

  const category = overtureTaxonomyToOpenMapX({
    basicCategory: row.basic_category,
    primary: row.taxonomy_primary,
    hierarchy: row.taxonomy_hierarchy,
    alternates: row.taxonomy_alternates,
  });

  return createPlace({
    primaryScheme: "overture",
    ids: { overture: row.gers_id },
    name: row.name || row.gers_id,
    address: "",
    coordinates: [row.longitude, row.latitude],
    category: category ?? undefined,
    phone: row.phone ?? undefined,
    osmTags: Object.keys(osmTags).length > 0 ? osmTags : undefined,
  });
}

let boundDb: DatabaseClient | undefined;

function bindDb(db: DatabaseClient): void {
  boundDb = db;
}

export const overtureProvider: PoiSearchProvider = {
  id: "overture",
  categories: [...OVERTURE_COMMERCIAL_CATEGORIES],
  async search(
    category: string,
    bbox: BoundingBox,
    _options?: {
      lang?: string;
      filters?: Record<string, unknown>;
      osmTags?: Record<string, string>;
    },
  ): Promise<PoiSearchResult[]> {
    const concepts = openMapXCategoryToOvertureConcepts(category);
    if (!concepts.length) return [];
    if (!boundDb) return [];
    const rows = await queryOverturePlaces(boundDb, {
      bbox,
      concepts,
      lang: _options?.lang,
      // Calibrated to 0.5 (was 0.7): the sweep showed 0.7 excludes most genuine
      // places; matches the offline conflation candidate floor.
      minConfidence: 0.5,
    });
    return rows.map((row) => overtureRowToPoiSearchResult(row, category as CategoryId));
  },
};

export function setup(ctx: IntegrationContext): void {
  const db = ctx.db;
  if (!db) {
    ctx.log.warn("[poi-overture] ctx.db undefined — manifest must require postgis");
    return;
  }
  bindDb(db);

  ctx.registerHealthCheck(async () => {
    try {
      await db.execute("SELECT 1 FROM overture_places.places LIMIT 1");
      return { status: "up" as const };
    } catch {
      return { status: "down" as const, error: "overture_places not ingested" };
    }
  });

  ctx.registerPoiSearchProvider(overtureProvider);

  registerPlaceResolver("overture", async (gers, rctx) => {
    const row = await fetchOverturePlaceByGers(db, gers, rctx.lang);
    if (!row) return null;
    return overtureRowToPlace(row);
  });
}
