import type { BoundingBox } from "@openmapx/core";
import {
  OVERTURE_COMMERCIAL_CATEGORIES,
  openmapxCategoryToOvertureLeaves,
  overtureCategoryToOpenMapX,
} from "@openmapx/core";
import type { DatabaseClient, IntegrationContext } from "@openmapx/integration-framework";
import type { PoiSearchProvider, PoiSearchResult } from "@openmapx/integration-poi-search/types";

interface OvertureRow {
  id: string;
  primary_name: string | null;
  longitude: number;
  latitude: number;
  basic_category: string | null;
  brand_name: string | null;
  brand_wikidata: string | null;
  operator: string | null;
}

function overtureRowToPoiSearchResult(row: OvertureRow): PoiSearchResult {
  const osmTags: Record<string, string> = {};
  if (row.brand_name) osmTags.brand = row.brand_name;
  if (row.brand_wikidata) osmTags["brand:wikidata"] = row.brand_wikidata;
  if (row.operator) osmTags.operator = row.operator;

  const category = row.basic_category
    ? (overtureCategoryToOpenMapX(row.basic_category) ?? undefined)
    : undefined;

  return {
    id: `overture:${row.id}`,
    gersId: row.id,
    name: row.primary_name ?? row.id,
    coordinates: [row.longitude, row.latitude],
    category,
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
      id,
      primary_name,
      longitude,
      latitude,
      basic_category,
      brand_name,
      brand_wikidata,
      operator
    FROM overture_places.places
    WHERE longitude BETWEEN $1 AND $2
      AND latitude BETWEEN $3 AND $4
      AND operating_status <> 'permanently_closed'
      AND confidence >= $${leaves.length + 5}
      AND basic_category IN (${leafParams})
    LIMIT 200
  `;
  const params: unknown[] = [
    bbox.west,
    bbox.east,
    bbox.south,
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
