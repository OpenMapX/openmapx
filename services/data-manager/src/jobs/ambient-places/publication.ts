import { randomUUID } from "node:crypto";
import {
  AMBIENT_LIMITS,
  AMBIENT_MAX_AGE_MS,
  type AmbientManifest,
  type AmbientPlace,
} from "@openmapx/core/ambient-places";
import { itemAt } from "@openmapx/core/item-at";
import type postgres from "postgres";
import {
  attachFeatureStorage,
  createFeatureStorage,
  type FeatureStorageLocking,
  featureTable,
  retireAmbientGenerations,
} from "./feature-storage.js";

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
  return itemAt(
    await tx.unsafe<{ exists: boolean }[]>(`SELECT to_regclass($1) IS NOT NULL AS exists`, [name]),
    0,
    "row from the table check",
  ).exists;
}
export async function prepareAmbientGeneration(tx: postgres.TransactionSql): Promise<string> {
  await retireAmbientGenerations(tx);
  const capacity = itemAt(
    await tx.unsafe<{ count: number }[]>(
      `SELECT count(*)::INT AS count FROM ambient_places.generations`,
    ),
    0,
    "row from the ambient generation count query",
  );
  if (capacity.count >= AMBIENT_LIMITS.generations)
    throw new Error(
      "Generation retention limit reached; preserve seven-day tile cache leases before rebuilding",
    );
  return randomUUID();
}
/** Records a new generation and creates its still unattached feature partition. */
export async function insertAmbientGeneration(
  tx: postgres.TransactionSql,
  manifest: AmbientManifest,
  storage: "regional" | "planet",
  publicationStatus: "staging" | "published",
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO ambient_places.generations(id,manifest,storage,publication_status) VALUES($1,$2::TEXT::JSONB,$3,$4)`,
    [manifest.generation, JSON.stringify(manifest), storage, publicationStatus],
  );
  await createFeatureStorage(tx, manifest.generation);
}
export async function insertAmbientFeatures(
  tx: postgres.TransactionSql,
  generation: string,
  places: AmbientPlace[],
): Promise<void> {
  const target = featureTable(generation);
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
      contributors: p.contributors ?? [],
      field_contributors: p.fieldContributors ?? null,
      source_lineage: p.sourceLineage ?? null,
      lng: p.coordinates[0],
      lat: p.coordinates[1],
    }));
    const result = await tx.unsafe(
      `INSERT INTO ${target}(generation,id,gers_id,name,name_de,name_en,category,rank,min_zoom,tenant,sources,geom,contributors,field_contributors,source_lineage)
      SELECT $1::UUID,r.id,r.gers_id,r.name,r.name_de,r.name_en,r.category,r.rank,r.min_zoom,r.tenant,r.sources,ST_Transform(ST_SetSRID(ST_MakePoint(r.lng,r.lat),4326),3857),r.contributors,r.field_contributors,r.source_lineage
      FROM jsonb_to_recordset($2::TEXT::JSONB) AS r(id TEXT,gers_id TEXT,name TEXT,name_de TEXT,name_en TEXT,category TEXT,rank INT,min_zoom SMALLINT,tenant BOOLEAN,sources TEXT,lng DOUBLE PRECISION,lat DOUBLE PRECISION,contributors JSONB,field_contributors JSONB,source_lineage JSONB)`,
      [generation, JSON.stringify(rows)],
    );
    if (result.count !== rows.length)
      throw new Error("Candidate feature insert count validation failed");
  }
}
/** Publishes a regional generation in its build's transaction. */
export async function activateAmbientGeneration(
  tx: postgres.TransactionSql,
  manifest: AmbientManifest,
  locking: FeatureStorageLocking = {},
): Promise<void> {
  const table = featureTable(manifest.generation);
  const count = itemAt(
    await tx.unsafe<{ count: string }[]>(`SELECT count(*)::TEXT AS count FROM ${table}`),
    0,
    "row from the candidate feature count query",
  );
  if (Number(count.count) !== manifest.placeCount)
    throw new Error("Candidate feature count validation failed");
  fresh(manifest.sources.osm.publishedAt);
  if (manifest.sources.overture) fresh(manifest.sources.overture.publishedAt);
  await tx.unsafe(`ANALYZE ${table}`);
  await attachFeatureStorage(tx, manifest.generation, locking);
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
