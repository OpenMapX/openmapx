import { randomUUID } from "node:crypto";
import {
  AMBIENT_LIMITS,
  AMBIENT_MAX_AGE_MS,
  type AmbientManifest,
  type AmbientPlace,
} from "@openmapx/core/ambient-places";
import type postgres from "postgres";

export function fresh(value: Date | string | null): string {
  const date = value === null ? NaN : new Date(value).getTime();
  if (
    !Number.isFinite(date) ||
    Date.now() - date > AMBIENT_MAX_AGE_MS ||
    date > Date.now() + 60_000
  )
    throw new Error("Source publication is missing or too old (maximum 90 days)");
  return new Date(date).toISOString();
}
export async function tableExists(tx: postgres.TransactionSql, name: string): Promise<boolean> {
  const [row] = await tx.unsafe<{ exists: boolean }[]>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [name],
  );
  return row.exists;
}
export async function prepareAmbientGeneration(tx: postgres.TransactionSql): Promise<string> {
  await tx.unsafe(
    `DELETE FROM ambient_places.generations g WHERE g.cache_lease_until<now() AND NOT EXISTS(SELECT 1 FROM ambient_places.state s WHERE g.id=s.active OR g.id=s.previous)`,
  );
  const [capacity] = await tx.unsafe<{ count: number }[]>(
    `SELECT count(*)::INT AS count FROM ambient_places.generations`,
  );
  if (capacity.count >= AMBIENT_LIMITS.generations)
    throw new Error(
      "Generation retention limit reached; preserve seven-day tile cache leases before rebuilding",
    );
  return randomUUID();
}
export async function insertAmbientFeatures(
  tx: postgres.TransactionSql,
  generation: string,
  places: AmbientPlace[],
): Promise<void> {
  for (let offset = 0; offset < places.length; offset += 500) {
    const rows = places.slice(offset, offset + 500).map((p) => ({
      id: p.id,
      gers_id: p.gersId ?? null,
      name: p.name,
      name_de: p.names.de ?? null,
      name_en: p.names.en ?? null,
      category: p.category,
      rank: p.rank,
      min_zoom: p.minZoom,
      tenant: p.tenant,
      sources: p.sources,
      lng: p.coordinates[0],
      lat: p.coordinates[1],
    }));
    await tx.unsafe(
      `INSERT INTO ambient_places.features(generation,id,gers_id,name,name_de,name_en,category,rank,min_zoom,tenant,sources,geom)
      SELECT $1::UUID,r.id,r.gers_id,r.name,r.name_de,r.name_en,r.category,r.rank,r.min_zoom,r.tenant,r.sources,ST_AsEWKB(ST_Transform(ST_SetSRID(ST_MakePoint(r.lng,r.lat),4326),3857))
      FROM jsonb_to_recordset($2::TEXT::JSONB) AS r(id TEXT,gers_id TEXT,name TEXT,name_de TEXT,name_en TEXT,category TEXT,rank INT,min_zoom SMALLINT,tenant BOOLEAN,sources TEXT,lng DOUBLE PRECISION,lat DOUBLE PRECISION)`,
      [generation, JSON.stringify(rows)],
    );
  }
}
export async function activateAmbientGeneration(
  tx: postgres.TransactionSql,
  manifest: AmbientManifest,
): Promise<void> {
  const [count] = await tx.unsafe<{ count: string }[]>(
    `SELECT count(*)::TEXT AS count FROM ambient_places.features WHERE generation=$1`,
    [manifest.generation],
  );
  if (Number(count.count) !== manifest.placeCount)
    throw new Error("Candidate feature count validation failed");
  fresh(manifest.sources.osm.publishedAt);
  if (manifest.sources.overture) fresh(manifest.sources.overture.publishedAt);
  await tx.unsafe(`UPDATE ambient_places.generations SET manifest=$2::TEXT::JSONB WHERE id=$1`, [
    manifest.generation,
    JSON.stringify(manifest),
  ]);
  // Cover clients that discovered the outgoing generation just before this swap.
  await tx.unsafe(
    `UPDATE ambient_places.generations SET cache_lease_until=greatest(cache_lease_until,clock_timestamp()+interval '7 days 1 minute') WHERE id=(SELECT active FROM ambient_places.state WHERE singleton=1)`,
  );
  await tx.unsafe(
    `UPDATE ambient_places.state SET previous=active,active=$1,last_build_finished_at=clock_timestamp() WHERE singleton=1`,
    [manifest.generation],
  );
}
