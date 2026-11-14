import type postgres from "postgres";
import {
  AMBIENT_FORMAT_VERSION,
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
/** The features of every published generation, from both of data-manager's
 * tables. The API writes the query itself: data-manager defines no view, as a
 * view would run its author's query with the reader's rights. */
export const PUBLISHED_AMBIENT_FEATURES = `(
  SELECT f.* FROM ambient_places.features f
    JOIN ambient_places.generations g ON g.id=f.generation WHERE g.publication_status='published'
  UNION ALL
  SELECT f.* FROM ambient_places.planet_features f
    JOIN ambient_places.generations g ON g.id=f.generation WHERE g.publication_status='published'
)`;

export async function readAmbientManifest(sql: postgres.Sql): Promise<AmbientManifest | null> {
  const [exists] = await sql.unsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('ambient_places.state') IS NOT NULL AS exists`,
  );
  if (!exists.exists) return null;
  const [row] = await sql.unsafe<{ manifest: AmbientManifest; enabled: boolean }[]>(
    `SELECT g.manifest,s.enabled FROM ambient_places.state s JOIN ambient_places.generations g ON g.id=s.active WHERE s.singleton=1 AND g.publication_status='published'`,
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
       CROSS JOIN ambient_places.state s WHERE s.singleton=1 AND g.publication_status='published'
         AND g.manifest->>'version'='${AMBIENT_FORMAT_VERSION}'
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
        contributors AS "_mapAttributions",field_contributors,source_lineage,
        ST_X(ST_Transform(ST_GeomFromEWKB(geom),4326)) AS lng,ST_Y(ST_Transform(ST_GeomFromEWKB(geom),4326)) AS lat
        FROM ${PUBLISHED_AMBIENT_FEATURES} f WHERE generation=ANY($1::UUID[]) AND gers_id=$2
        ORDER BY array_position($1::UUID[],generation),id COLLATE "C" LIMIT 1`,
      [generations, gers],
    );
    const place = row
      ? ambientPlaceFromTile({ ...row, format_version: AMBIENT_FORMAT_VERSION }, [row.lng, row.lat])
      : null;
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
    const [known] = await tx.unsafe<{ version: number }[]>(
      `SELECT (manifest->>'version')::INT AS version FROM ambient_places.generations g WHERE id=$1 AND g.publication_status='published'`,
      [generation],
    );
    if (known?.version !== AMBIENT_FORMAT_VERSION) return null;
    const lineage = `,${AMBIENT_FORMAT_VERSION} AS format_version,coalesce(contributors,'[]'::JSONB)::TEXT AS "_mapAttributions",field_contributors::TEXT AS field_contributors,source_lineage::TEXT AS source_lineage`;
    const worldWidth = 40075016.68557849;
    const shift = x === 0 ? worldWidth : x === 2 ** z - 1 ? -worldWidth : 0;
    const [result] = await tx.unsafe<{ tile: Buffer }[]>(
      `
      WITH spatial AS (
        SELECT id,gers_id,name,name_de,name_en,category,rank,min_zoom,tenant,sources${lineage},ST_GeomFromEWKB(geom) AS geom
        FROM ${PUBLISHED_AMBIENT_FEATURES} f
        WHERE generation=$1 AND min_zoom<=$2 AND ST_GeomFromEWKB(geom) && ST_TileEnvelope($2,$3,$4,margin=>64.0/4096)
        UNION ALL
        SELECT id,gers_id,name,name_de,name_en,category,rank,min_zoom,tenant,sources${lineage},ST_Translate(ST_GeomFromEWKB(geom),-$5::FLOAT8,0) AS geom
        FROM ${PUBLISHED_AMBIENT_FEATURES} f
        WHERE $5::FLOAT8<>0 AND generation=$1 AND min_zoom<=$2 AND ST_GeomFromEWKB(geom) && ST_Translate(ST_TileEnvelope($2,$3,$4,margin=>64.0/4096),$5::FLOAT8,0)
      ), candidates AS MATERIALIZED (
        SELECT * FROM spatial ORDER BY rank DESC,id COLLATE "C" LIMIT ${AMBIENT_LIMITS.tileFeatures}
      ), lineage_ranked AS (
        -- MVT interns string values. Charge each receipt/lineage string once, while
        -- retaining per-feature overhead; repeated notices must not displace POIs.
        SELECT *,row_number() OVER(PARTITION BY "_mapAttributions" ORDER BY rank DESC,id COLLATE "C") AS contributors_first,
          row_number() OVER(PARTITION BY field_contributors ORDER BY rank DESC,id COLLATE "C") AS fields_first,
          row_number() OVER(PARTITION BY source_lineage ORDER BY rank DESC,id COLLATE "C") AS lineage_first FROM candidates
      ), budgeted AS (
        SELECT *, sum(octet_length(id)+coalesce(octet_length(gers_id),0)+octet_length(name)
          +coalesce(octet_length(name_de),0)+coalesce(octet_length(name_en),0)
          +octet_length(category)+octet_length(sources)+160
          +CASE WHEN contributors_first=1 THEN coalesce(octet_length("_mapAttributions"),0) ELSE 0 END
          +CASE WHEN fields_first=1 THEN coalesce(octet_length(field_contributors),0) ELSE 0 END
          +CASE WHEN lineage_first=1 THEN coalesce(octet_length(source_lineage),0) ELSE 0 END+160)
          OVER(ORDER BY rank DESC,id COLLATE "C" ROWS UNBOUNDED PRECEDING) AS bytes
        FROM lineage_ranked
      ), bounded AS (
        SELECT id,gers_id,name,name_de,name_en,category,rank,min_zoom,tenant,sources,format_version,"_mapAttributions",field_contributors,source_lineage,
          ST_AsMVTGeom(geom,ST_TileEnvelope($2,$3,$4),4096,64,true) AS geom
        FROM budgeted WHERE bytes<=${AMBIENT_LIMITS.tileBytes - 1024}
        ORDER BY rank DESC,id COLLATE "C"
      ) SELECT ST_AsMVT(bounded,'ambient_places',4096,'geom') AS tile FROM bounded`,
      [generation, z, x, y, shift],
    );
    if (result.tile.length > AMBIENT_LIMITS.tileBytes)
      throw new Error("Ambient tile byte budget exceeded");
    return result.tile;
  });
}
