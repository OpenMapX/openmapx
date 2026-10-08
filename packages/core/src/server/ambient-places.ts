import type postgres from "postgres";
import {
  AMBIENT_LIMITS,
  AMBIENT_MAX_AGE_MS,
  type AmbientManifest,
  type AmbientPlace,
  ambientPlaceFromTile,
} from "../ambient-places";

function freshPublication(manifest: AmbientManifest): boolean {
  const dates = [
    manifest.publishedAt,
    manifest.sources.osm.publishedAt,
    ...(manifest.sources.overture ? [manifest.sources.overture.publishedAt] : []),
  ];
  return dates.every(
    (date) =>
      Number.isFinite(Date.parse(date)) && Date.now() - Date.parse(date) <= AMBIENT_MAX_AGE_MS,
  );
}

export function validAmbientTile(generation: string, z: number, x: number, y: number): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(generation) &&
    [z, x, y].every(Number.isSafeInteger) &&
    z >= AMBIENT_LIMITS.minZoom &&
    z <= AMBIENT_LIMITS.maxZoom &&
    x >= 0 &&
    y >= 0 &&
    x < 2 ** z &&
    y < 2 ** z
  );
}
export async function readAmbientManifest(sql: postgres.Sql): Promise<AmbientManifest | null> {
  const [exists] = await sql.unsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('ambient_places.state') IS NOT NULL AS exists`,
  );
  if (!exists.exists) return null;
  const [row] = await sql.unsafe<{ manifest: AmbientManifest; enabled: boolean }[]>(
    `SELECT g.manifest,s.enabled FROM ambient_places.state s JOIN ambient_places.generations g ON g.id=s.active WHERE s.singleton=1`,
  );
  if (!row) return null;
  return { ...row.manifest, enabled: row.enabled && freshPublication(row.manifest) };
}

/** Resolve a source-fresh published GERS alias, preferring active then newest.
 * Discovery disable does not revoke already published tiles or their identities.
 * Still-retained generations own their identities until removed or source-stale.
 */
export async function readAmbientPlaceByGers(
  sql: postgres.Sql,
  gers: string,
): Promise<{ generation: string; place: AmbientPlace } | null> {
  if (!gers || gers.length > 128) return null;
  return sql.begin("isolation level repeatable read", async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout='2000ms'`);
    const [exists] = await tx.unsafe<{ exists: boolean }[]>(
      `SELECT to_regclass('ambient_places.state') IS NOT NULL AS exists`,
    );
    if (!exists.exists) return null;
    const candidates = await tx.unsafe<{ generation: string; manifest: AmbientManifest }[]>(
      `SELECT g.id AS generation,g.manifest FROM ambient_places.generations g
       CROSS JOIN ambient_places.state s WHERE s.singleton=1
       ORDER BY (g.id=s.active) DESC,g.published_at DESC,g.id
       LIMIT ${AMBIENT_LIMITS.generations}`,
    );
    const generations = candidates
      .filter((candidate) => freshPublication(candidate.manifest))
      .map((candidate) => candidate.generation);
    if (!generations.length) return null;
    const [row] = await tx.unsafe<
      (Record<string, unknown> & { generation: string; lng: number; lat: number })[]
    >(
      `SELECT generation,id,gers_id,name,name_de,name_en,category,rank,min_zoom,tenant,sources,
        ST_X(ST_Transform(ST_GeomFromEWKB(geom),4326)) AS lng,ST_Y(ST_Transform(ST_GeomFromEWKB(geom),4326)) AS lat
        FROM ambient_places.features WHERE generation=ANY($1::UUID[]) AND gers_id=$2
        ORDER BY array_position($1::UUID[],generation),id COLLATE "C" LIMIT 1`,
      [generations, gers],
    );
    const place = row ? ambientPlaceFromTile(row, [row.lng, row.lat]) : null;
    return place ? { generation: row.generation, place } : null;
  });
}
export async function readAmbientTile(
  sql: postgres.Sql,
  generation: string,
  z: number,
  x: number,
  y: number,
): Promise<Buffer | null> {
  if (!validAmbientTile(generation, z, x, y)) throw new Error("Invalid ambient tile coordinates");
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout='2000ms'`);
    const [exists] = await tx.unsafe<{ exists: boolean }[]>(
      `SELECT to_regclass('ambient_places.generations') IS NOT NULL AS exists`,
    );
    if (!exists.exists) return null;
    const [known] = await tx.unsafe<{ exists: boolean }[]>(
      `SELECT EXISTS(SELECT 1 FROM ambient_places.generations WHERE id=$1) AS exists`,
      [generation],
    );
    if (!known.exists) return null;
    const [result] = await tx.unsafe<{ tile: Buffer }[]>(
      `
      WITH candidates AS MATERIALIZED (
        SELECT id,gers_id,name,name_de,name_en,category,rank,min_zoom,tenant,sources,ST_GeomFromEWKB(geom) AS geom
        FROM ambient_places.features
        WHERE generation=$1 AND min_zoom<=$2 AND ST_GeomFromEWKB(geom) && ST_TileEnvelope($2,$3,$4,margin=>64.0/4096)
        ORDER BY rank DESC,id COLLATE "C" LIMIT ${AMBIENT_LIMITS.tileFeatures}
      ), budgeted AS (
        SELECT *, sum(octet_length(id)+coalesce(octet_length(gers_id),0)+octet_length(name)
          +coalesce(octet_length(name_de),0)+coalesce(octet_length(name_en),0)
          +octet_length(category)+octet_length(sources)+160)
          OVER(ORDER BY rank DESC,id COLLATE "C" ROWS UNBOUNDED PRECEDING) AS bytes
        FROM candidates
      ), bounded AS (
        SELECT id,gers_id,name,name_de,name_en,category,rank,min_zoom,tenant,sources,
          ST_AsMVTGeom(geom,ST_TileEnvelope($2,$3,$4),4096,64,true) AS geom
        FROM budgeted WHERE bytes<=${AMBIENT_LIMITS.tileBytes - 1024}
        ORDER BY rank DESC,id COLLATE "C"
      ) SELECT ST_AsMVT(bounded,'ambient_places',4096,'geom') AS tile FROM bounded`,
      [generation, z, x, y],
    );
    if (result.tile.length > AMBIENT_LIMITS.tileBytes)
      throw new Error("Ambient tile byte budget exceeded");
    return result.tile;
  });
}
