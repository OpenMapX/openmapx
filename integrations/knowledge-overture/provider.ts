import type { KnowledgeContext, KnowledgeProvider, KnowledgeResult } from "@openmapx/core";
import { diceSimilarity } from "@openmapx/core";
import type { DatabaseClient } from "@openmapx/integration-framework";

let db: DatabaseClient | undefined;

export function bindDb(database: DatabaseClient): void {
  db = database;
}

interface SpatialRow {
  gers_id: string;
  name: string;
}

interface OvertureDetailRow {
  gers_id: string;
  name: string;
  names: Record<string, string> | null;
  brand: { name?: string; wikidata?: string } | null;
  opening_hours: string | null;
}

/**
 * Race a promise against a timeout returning null.
 * The orchestrator uses Promise.allSettled, not a race, so each source must
 * bound its own latency.
 */
async function withDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse an OSM ref like "node/123456789" into { type, id } or null.
 */
function parseOsmRef(ref: string): { type: string; id: bigint } | null {
  const match = /^(node|way|relation)\/(\d+)$/.exec(ref);
  if (!match) return null;
  return { type: match[1], id: BigInt(match[2]) };
}

/**
 * Resolve a GERS id for the given place.
 *
 * Phase 1 — link-first: query poi_conflation_link using the OSM ref from
 * context.ids.osm. The table is empty until plan 03, so this always falls
 * through for now (expected).
 *
 * Phase 2 — spatial+name: find candidates within 150 m of the place
 * coordinates and filter by openmapx_category; pick the one whose name
 * achieves diceSimilarity >= 0.8 with the place name.
 *
 * context.ids may be undefined (the neighborhoods call site passes a partial
 * Place with no ids) — falls through to the spatial path without throwing.
 */
async function resolveGers(
  database: DatabaseClient,
  osmTags: Record<string, string>,
  context: KnowledgeContext | undefined,
): Promise<string | null> {
  const osmRef = context?.ids?.osm;
  if (osmRef) {
    const parsed = parseOsmRef(osmRef);
    if (parsed) {
      const linkRows = await database.execute<SpatialRow[]>(
        `SELECT gers_id FROM overture_places.poi_conflation_link WHERE osm_type=$1 AND osm_id=$2 LIMIT 1`,
        [parsed.type, parsed.id],
      );
      if (Array.isArray(linkRows) && linkRows.length > 0) {
        return linkRows[0].gers_id;
      }
    }
  }

  const coords = context?.coordinates;
  const placeName = context?.name;
  if (!coords || !placeName) return null;

  const [lng, lat] = coords;
  const category = osmTags.openmapx_category ?? osmTags.category ?? null;

  let sql: string;
  let params: unknown[];
  if (category) {
    sql = `
      SELECT gers_id, name
      FROM overture_places.places
      WHERE ST_DWithin(geom::geography, ST_MakePoint($1, $2)::geography, 150)
        AND openmapx_category = $3
        AND operating_status <> 'permanently_closed'
      ORDER BY geom <-> ST_MakePoint($1, $2)::geometry
      LIMIT 5
    `;
    params = [lng, lat, category];
  } else {
    sql = `
      SELECT gers_id, name
      FROM overture_places.places
      WHERE ST_DWithin(geom::geography, ST_MakePoint($1, $2)::geography, 150)
        AND operating_status <> 'permanently_closed'
      ORDER BY geom <-> ST_MakePoint($1, $2)::geometry
      LIMIT 5
    `;
    params = [lng, lat];
  }

  const rows = await database.execute<SpatialRow[]>(sql, params);
  if (!Array.isArray(rows) || rows.length === 0) return null;

  for (const row of rows) {
    if (diceSimilarity(row.name.toLowerCase(), placeName.toLowerCase()) >= 0.8) {
      return row.gers_id;
    }
  }

  return null;
}

async function fetchOverturePlaceByGers(
  database: DatabaseClient,
  gersId: string,
): Promise<OvertureDetailRow | null> {
  const rows = await database.execute<OvertureDetailRow[]>(
    `
    SELECT gers_id, name, names, brand, opening_hours
    FROM overture_places.places
    WHERE gers_id = $1
    LIMIT 1
    `,
    [gersId],
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

function overtureRowToKnowledgeResult(row: OvertureDetailRow): KnowledgeResult | null {
  const result: KnowledgeResult = {};

  if (row.brand?.name) {
    result.brand = { name: row.brand.name };
    if (row.brand.wikidata) {
      result.brand.wikidata = row.brand.wikidata;
      result.externalIds = { wikidata: row.brand.wikidata };
    }
  }

  if (row.names && Object.keys(row.names).length > 0) {
    result.names = row.names;
  }

  if (row.opening_hours) {
    result.structuredOpeningHours = row.opening_hours;
  }

  return Object.keys(result).length > 0 ? result : null;
}

export const overtureKnowledgeSource: KnowledgeProvider = {
  name: "knowledge-overture",

  async lookup(osmTags, _lang, context) {
    const database = db;
    if (!database) return null;

    const gers = await withDeadline(1500, () => resolveGers(database, osmTags, context));
    if (!gers) return null;

    const row = await fetchOverturePlaceByGers(database, gers);
    return row ? overtureRowToKnowledgeResult(row) : null;
  },
};
