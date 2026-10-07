import { randomUUID } from "node:crypto";
import { assertSupportedOvertureContributors, type OvertureSourceItem } from "@openmapx/core";
import {
  AMBIENT_LIMITS,
  AMBIENT_MAX_AGE_MS,
  AMBIENT_POLICY_VERSION,
  type AmbientManifest,
  type AmbientOsmRow,
  type AmbientOvertureRow,
  type AmbientRegion,
  ambientPlaceFromOsm,
  ambientPlaceFromOverture,
  mergeAmbientPlaces,
  validateAmbientRegion,
} from "@openmapx/core/ambient-places";
import type postgres from "postgres";
import { AMBIENT_WRITE_LOCK, ensureAmbientSchema } from "./schema.js";

async function lock(tx: postgres.TransactionSql) {
  const [row] = await tx.unsafe<{ locked: boolean }[]>(
    `SELECT pg_try_advisory_xact_lock(${AMBIENT_WRITE_LOCK}) AS locked`,
  );
  if (!row.locked) throw new Error("Another ambient publication or pointer change is running");
}
function fresh(value: Date | string | null): string {
  const date = value === null ? NaN : new Date(value).getTime();
  if (
    !Number.isFinite(date) ||
    Date.now() - date > AMBIENT_MAX_AGE_MS ||
    date > Date.now() + 60_000
  )
    throw new Error("Source publication is missing or too old (maximum 90 days)");
  return new Date(date).toISOString();
}
async function tableExists(tx: postgres.TransactionSql, name: string): Promise<boolean> {
  const [row] = await tx.unsafe<{ exists: boolean }[]>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [name],
  );
  return row.exists;
}
export async function buildAmbientPlaces(
  sql: postgres.Sql,
  input: AmbientRegion,
): Promise<AmbientManifest> {
  const region = validateAmbientRegion(input);
  await ensureAmbientSchema(sql);
  return sql.begin("isolation level repeatable read", async (tx) => {
    await lock(tx);
    await tx.unsafe(`SET LOCAL statement_timeout='120000ms'`);
    if (!(await tableExists(tx, "osm_search.index_state")))
      throw new Error("Build the regional OSM search index first");
    const [osmState] = await tx.unsafe<
      { region: string; epoch: string; status: string; published_at: Date | null }[]
    >(`SELECT region,epoch,status,published_at FROM osm_search.index_state WHERE singleton=1`);
    if (!osmState || osmState.status !== "ready") throw new Error("OSM search index must be ready");
    const osmPublished = fresh(osmState.published_at);
    const params = region.bounds;
    const osmRows = await tx.unsafe<AmbientOsmRow[]>(
      `SELECT osm_type,osm_id::TEXT,name,lng,lat,category,tags,importance FROM osm_search.places WHERE geom && ST_MakeEnvelope($1,$2,$3,$4,4326)::geography ORDER BY osm_type,osm_id LIMIT ${AMBIENT_LIMITS.places + 1}`,
      params,
    );
    if (osmRows.length > AMBIENT_LIMITS.places)
      throw new Error("Regional OSM input exceeds 100000 places; choose a smaller region");
    const osm = osmRows.flatMap((row) => {
      const p = ambientPlaceFromOsm(row);
      return p ? [p] : [];
    });
    let overtureSource: AmbientManifest["sources"]["overture"] = null;
    let overture: NonNullable<ReturnType<typeof ambientPlaceFromOverture>>[] = [];
    const links = new Map<string, string>();
    if (await tableExists(tx, "overture_places.places")) {
      if (!(await tableExists(tx, "overture_places.conflation_state")))
        throw new Error("Overture conflation state is missing");
      const [state] = await tx.unsafe<
        { region: string; release: string; status: string; places_published_at: Date | null }[]
      >(
        `SELECT region,release,status,places_published_at FROM overture_places.conflation_state WHERE singleton=1`,
      );
      if (!state) {
        const [input] = await tx.unsafe<{ populated: boolean }[]>(
          `SELECT EXISTS(SELECT 1 FROM overture_places.places LIMIT 1) AS populated`,
        );
        if (input.populated) throw new Error("Overture conflation state is missing");
      }
      if (state && state.status !== "completed")
        throw new Error("Overture conflation must be completed before ambient publication");
      if (state) {
        const publishedAt = fresh(state.places_published_at);
        const [releases] = await tx.unsafe<{ mismatch: boolean }[]>(
          `SELECT EXISTS(SELECT 1 FROM overture_places.places WHERE release<>$1 AND geom && ST_MakeEnvelope($2,$3,$4,$5,4326) LIMIT 1) AS mismatch`,
          [state.release, ...params],
        );
        if (releases.mismatch)
          throw new Error("Overture conflation release does not match published places");
        const rows = await tx.unsafe<
          (AmbientOvertureRow & { sources: OvertureSourceItem[] | null })[]
        >(
          `SELECT gers_id,name,ST_X(geom) AS longitude,ST_Y(geom) AS latitude,basic_category,taxonomy_primary,taxonomy_hierarchy,taxonomy_alternates,names,confidence,operating_status,sources FROM overture_places.places WHERE geom && ST_MakeEnvelope($1,$2,$3,$4,4326) ORDER BY gers_id LIMIT ${AMBIENT_LIMITS.places + 1}`,
          params,
        );
        if (rows.length > AMBIENT_LIMITS.places)
          throw new Error("Regional Overture input exceeds 100000 places; choose a smaller region");
        overture = rows.flatMap((row) => {
          const p = ambientPlaceFromOverture(row);
          if (p)
            assertSupportedOvertureContributors(
              (row.sources ?? []).flatMap((source) => (source.dataset ? [source.dataset] : [])),
            );
          return p ? [p] : [];
        });
        const linkRows = await tx.unsafe<{ id: string; gers_id: string }[]>(
          `SELECT 'osm:'||l.osm_type||'/'||l.osm_id::TEXT AS id,l.gers_id FROM overture_places.poi_conflation_link l JOIN osm_search.places p USING(osm_type,osm_id) WHERE p.geom && ST_MakeEnvelope($1,$2,$3,$4,4326)::geography AND l.release=$5 UNION SELECT 'osm:'||l.osm_type||'/'||l.osm_id::TEXT AS id,l.gers_id FROM overture_places.poi_conflation_link l JOIN overture_places.places o USING(gers_id) WHERE o.geom && ST_MakeEnvelope($1,$2,$3,$4,4326) AND l.release=$5 LIMIT ${AMBIENT_LIMITS.places + 1}`,
          [...params, state.release],
        );
        if (linkRows.length > AMBIENT_LIMITS.places)
          throw new Error("Regional conflation input exceeds 100000 links");
        for (const row of linkRows) links.set(row.id, row.gers_id);
        overtureSource = {
          region: state.region,
          release: state.release,
          publishedAt,
          count: overture.length,
        };
      }
    }
    const validOsm = new Set(osm.map((p) => p.id));
    const excludedOsm = new Set(
      osmRows
        .filter((row) => !validOsm.has(`osm:${row.osm_type}/${row.osm_id}`))
        .map((row) => `osm:${row.osm_type}/${row.osm_id}`),
    );
    const places = mergeAmbientPlaces(osm, overture, links, excludedOsm);
    if (places.length === 0) throw new Error("Refusing to publish an empty ambient generation");
    if (places.length > AMBIENT_LIMITS.places)
      throw new Error("Combined regional output exceeds 100000 places");
    await tx.unsafe(
      `DELETE FROM ambient_places.generations g WHERE g.published_at<now()-interval '7 days' AND NOT EXISTS(SELECT 1 FROM ambient_places.state s WHERE g.id=s.active OR g.id=s.previous)`,
    );
    const [capacity] = await tx.unsafe<{ count: number }[]>(
      `SELECT count(*)::INT AS count FROM ambient_places.generations`,
    );
    if (capacity.count >= AMBIENT_LIMITS.generations)
      throw new Error(
        "Generation retention limit reached; preserve seven-day tile cache leases before rebuilding",
      );
    const manifest: AmbientManifest = {
      version: 1,
      policyVersion: AMBIENT_POLICY_VERSION,
      generation: randomUUID(),
      publishedAt: new Date().toISOString(),
      region,
      placeCount: places.length,
      enabled: true,
      sources: {
        osm: {
          region: osmState.region,
          epoch: osmState.epoch,
          publishedAt: osmPublished,
          count: osm.length,
        },
        overture: overtureSource,
      },
    };
    await tx.unsafe(
      `INSERT INTO ambient_places.generations(id,manifest) VALUES($1,$2::TEXT::JSONB)`,
      [manifest.generation, JSON.stringify(manifest)],
    );
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
        SELECT $1::UUID,r.id,r.gers_id,r.name,r.name_de,r.name_en,r.category,r.rank,r.min_zoom,r.tenant,r.sources,ST_Transform(ST_SetSRID(ST_MakePoint(r.lng,r.lat),4326),3857)
        FROM jsonb_to_recordset($2::TEXT::JSONB) AS r(id TEXT,gers_id TEXT,name TEXT,name_de TEXT,name_en TEXT,category TEXT,rank INT,min_zoom SMALLINT,tenant BOOLEAN,sources TEXT,lng DOUBLE PRECISION,lat DOUBLE PRECISION)`,
        [manifest.generation, JSON.stringify(rows)],
      );
    }
    const [count] = await tx.unsafe<{ count: number }[]>(
      `SELECT count(*)::INT AS count FROM ambient_places.features WHERE generation=$1`,
      [manifest.generation],
    );
    if (count.count !== manifest.placeCount)
      throw new Error("Candidate feature count validation failed");
    await tx.unsafe(`UPDATE ambient_places.state SET previous=active,active=$1 WHERE singleton=1`, [
      manifest.generation,
    ]);
    return manifest;
  });
}
export async function setAmbientEnabled(sql: postgres.Sql, enabled: boolean): Promise<void> {
  await ensureAmbientSchema(sql);
  await sql.begin(async (tx) => {
    await lock(tx);
    await tx.unsafe(`UPDATE ambient_places.state SET enabled=$1 WHERE singleton=1`, [enabled]);
  });
}
export async function rollbackAmbientPlaces(sql: postgres.Sql): Promise<void> {
  await ensureAmbientSchema(sql);
  await sql.begin(async (tx) => {
    await lock(tx);
    const [state] = await tx.unsafe<{ previous: string | null }[]>(
      `SELECT previous FROM ambient_places.state WHERE singleton=1`,
    );
    if (!state.previous) throw new Error("No previous ambient generation available");
    await tx.unsafe(
      `UPDATE ambient_places.state SET active=previous,previous=active WHERE singleton=1`,
    );
  });
}
