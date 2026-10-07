import type postgres from "postgres";
import { AMBIENT_LIMITS, AMBIENT_MAX_AGE_MS, type AmbientManifest } from "../ambient-places";

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
  const dates = [
    row.manifest.publishedAt,
    row.manifest.sources.osm.publishedAt,
    ...(row.manifest.sources.overture ? [row.manifest.sources.overture.publishedAt] : []),
  ];
  const fresh = dates.every(
    (date) =>
      Number.isFinite(Date.parse(date)) && Date.now() - Date.parse(date) <= AMBIENT_MAX_AGE_MS,
  );
  return { ...row.manifest, enabled: row.enabled && fresh };
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
        SELECT id,gers_id,name,name_de,name_en,category,rank,min_zoom,tenant,sources,geom
        FROM ambient_places.features
        WHERE generation=$1 AND min_zoom<=$2 AND geom && ST_TileEnvelope($2,$3,$4,margin=>64.0/4096)
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
