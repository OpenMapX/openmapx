import type { BoundingBox } from "@openmapx/core";
import {
  OVERTURE_COMMERCIAL_CATEGORIES,
  openmapxCategoryToOvertureLeaves,
  overtureCategoryToOpenMapX,
} from "@openmapx/core";
import type { DatabaseClient, IntegrationContext } from "@openmapx/integration-framework";
import type {
  CategoryId,
  PoiSearchProvider,
  PoiSearchResult,
} from "@openmapx/integration-poi-search/types";

interface OvertureRow {
  gers_id: string;
  name: string;
  longitude: number;
  latitude: number;
  openmapx_category: string | null;
  basic_category: string | null;
  brand_name: string | null;
  brand_wikidata: string | null;
  phone: string | null;
}

function overtureRowToPoiSearchResult(row: OvertureRow): PoiSearchResult {
  const osmTags: Record<string, string> = {};
  if (row.brand_name) osmTags.brand = row.brand_name;
  if (row.brand_wikidata) osmTags["brand:wikidata"] = row.brand_wikidata;

  const category: CategoryId | undefined =
    (row.openmapx_category as CategoryId | null) ??
    (row.basic_category
      ? (overtureCategoryToOpenMapX(row.basic_category) ?? undefined)
      : undefined);

  return {
    id: `overture:${row.gers_id}`,
    gersId: row.gers_id,
    name: row.name || row.gers_id,
    coordinates: [row.longitude, row.latitude],
    category: category ?? undefined,
    phone: row.phone ?? undefined,
    osmTags: Object.keys(osmTags).length > 0 ? osmTags : undefined,
  };
}

async function queryOverturePlaces(
  db: DatabaseClient,
  opts: { bbox: BoundingBox; leaves: string[]; lang?: string; minConfidence: number },
): Promise<OvertureRow[]> {
  const { bbox, leaves, minConfidence } = opts;
  const leafParams = leaves.map((_, i) => `$${i + 5}`).join(", ");
  const sql = `
    SELECT
      gers_id,
      name,
      ST_X(geom) AS longitude,
      ST_Y(geom) AS latitude,
      openmapx_category,
      basic_category,
      brand->>'name' AS brand_name,
      brand->>'wikidata' AS brand_wikidata,
      phones[1] AS phone
    FROM overture_places.places
    WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      AND operating_status <> 'permanently_closed'
      AND confidence >= $${leaves.length + 5}
      AND basic_category IN (${leafParams})
    LIMIT 200
  `;
  const params: unknown[] = [
    bbox.west,
    bbox.south,
    bbox.east,
    bbox.north,
    ...leaves,
    minConfidence,
  ];
  return db.execute<OvertureRow[]>(sql, params);
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
    const leaves = openmapxCategoryToOvertureLeaves(category);
    if (!leaves.length) return [];
    if (!boundDb) return [];
    const rows = await queryOverturePlaces(boundDb, {
      bbox,
      leaves,
      lang: _options?.lang,
      minConfidence: 0.7,
    });
    return rows.map(overtureRowToPoiSearchResult);
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
}
