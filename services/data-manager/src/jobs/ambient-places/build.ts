export { discardPlanetPlaces, resumePlanetPlaces } from "./planet-build.js";

import { randomUUID } from "node:crypto";
import { assertSupportedOvertureContributors, type OvertureSourceItem } from "@openmapx/core";
import {
  AMBIENT_LIMITS,
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
import { type AmbientBuildOptions, buildGermanyPlaces } from "./germany.js";
import { buildPlanetPlaces } from "./planet-build.js";
import {
  activateAmbientGeneration,
  fresh,
  insertAmbientFeatures,
  prepareAmbientGeneration,
  tableExists,
} from "./publication.js";
import { AMBIENT_WRITE_LOCK, AmbientPublicationBusyError, ensureAmbientSchema } from "./schema.js";
import { lockAmbientCountrySources } from "./source-locks.js";

async function lock(tx: postgres.TransactionSql) {
  const [row] = await tx.unsafe<{ locked: boolean }[]>(
    `SELECT pg_try_advisory_xact_lock(${AMBIENT_WRITE_LOCK}) AS locked`,
  );
  if (!row.locked) throw new AmbientPublicationBusyError();
}
export async function buildAmbientPlaces(
  sql: postgres.Sql,
  input: AmbientRegion,
  onClaim?: () => void | Promise<void>,
  options: AmbientBuildOptions = {},
): Promise<AmbientManifest> {
  const region = validateAmbientRegion(input);
  if (region.coverage === "planet") return buildPlanetPlaces(sql, onClaim, { ...options, region });
  await ensureAmbientSchema(sql);
  const attempt = randomUUID();
  let startedAt: string | null = null;
  try {
    return await sql.begin("isolation level repeatable read", async (tx) => {
      await lock(tx);
      if (region.coverage === "germany") await lockAmbientCountrySources(tx);
      await tx.unsafe(`SET LOCAL statement_timeout='120000ms'`);
      const [clock] = await tx.unsafe<{ started_at: string }[]>(
        `SELECT clock_timestamp()::TEXT AS started_at`,
      );
      startedAt = clock.started_at;
      // Progress writes share the publication transaction and its writer lock.
      // A rejected contender must never create a new MVCC version of this row.
      await tx.unsafe(
        `UPDATE ambient_places.state SET last_build_id=$1,last_build_started_at=$2,last_build_finished_at=NULL,last_build_error=NULL WHERE singleton=1`,
        [attempt, startedAt],
      );
      await onClaim?.();
      if (!(await tableExists(tx, "osm_search.index_state")))
        throw new Error("Build the regional OSM search index first");
      const [osmState] = await tx.unsafe<
        {
          region: string;
          epoch: string;
          status: string;
          published_at: Date | null;
          place_count: string;
        }[]
      >(
        `SELECT region,epoch,status,published_at,place_count::TEXT FROM osm_search.index_state WHERE singleton=1`,
      );
      if (!osmState || osmState.status !== "ready")
        throw new Error("OSM search index must be ready");
      const osmPublished = fresh(osmState.published_at);
      if (region.coverage === "germany") return buildGermanyPlaces(tx, region, osmState, options);
      const params = region.bounds;
      let osmRows: AmbientOsmRow[] = await tx.unsafe<AmbientOsmRow[]>(
        `SELECT osm_type,osm_id::TEXT,name,lng,lat,category,tags,importance FROM osm_search.places WHERE geom && ST_MakeEnvelope($1,$2,$3,$4,4326)::geography ORDER BY osm_type,osm_id LIMIT ${AMBIENT_LIMITS.places + 1}`,
        params,
      );
      if (osmRows.length > AMBIENT_LIMITS.places)
        throw new Error("Regional OSM input exceeds 100000 places; choose a smaller region");
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
            throw new Error(
              "Regional Overture input exceeds 100000 places; choose a smaller region",
            );
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
          // A linked OSM point can straddle the bbox boundary. Its policy and
          // authoritative fields must still win over the regional Overture point.
          const counterparts = await tx.unsafe<AmbientOsmRow[]>(
            `SELECT l.osm_type,l.osm_id::TEXT,
            CASE WHEN p.osm_id IS NOT NULL THEN p.name ELSE coalesce(nullif(raw.name,''),o.name) END AS name,
            coalesce(p.lng,raw.lng) AS lng,coalesce(p.lat,raw.lat) AS lat,
            coalesce(p.category,raw.category) AS category,coalesce(p.tags,raw.tags,'{}'::JSONB) AS tags,coalesce(p.importance,0.5) AS importance
            FROM overture_places.places o JOIN overture_places.poi_conflation_link l USING(gers_id)
            LEFT JOIN osm_search.places p ON p.osm_type=l.osm_type AND p.osm_id=l.osm_id
            LEFT JOIN overture_places.osm_pois raw ON raw.osm_type=l.osm_type AND raw.osm_id=l.osm_id
            WHERE o.geom && ST_MakeEnvelope($1,$2,$3,$4,4326) AND l.release=$5 AND (p.osm_id IS NOT NULL OR raw.osm_id IS NOT NULL)
            ORDER BY l.osm_type,l.osm_id LIMIT ${AMBIENT_LIMITS.places + 1}`,
            [...params, state.release],
          );
          const allOsm = new Map(osmRows.map((row) => [`${row.osm_type}/${row.osm_id}`, row]));
          for (const row of counterparts) allOsm.set(`${row.osm_type}/${row.osm_id}`, row);
          if (counterparts.length > AMBIENT_LIMITS.places || allOsm.size > AMBIENT_LIMITS.places)
            throw new Error(
              "Regional OSM and linked input exceeds 100000 places; choose a smaller region",
            );
          osmRows = [...allOsm.values()];
          overtureSource = {
            region: state.region,
            release: state.release,
            publishedAt,
            count: overture.length,
          };
        }
      }
      const osm = osmRows.flatMap((row) => {
        const p = ambientPlaceFromOsm(row);
        return p ? [p] : [];
      });
      const inside = (coordinates: [number, number]) =>
        coordinates[0] >= params[0] &&
        coordinates[0] <= params[2] &&
        coordinates[1] >= params[1] &&
        coordinates[1] <= params[3];
      const validOsm = new Set(osm.map((p) => p.id));
      const excludedOsm = new Set(
        osmRows
          .filter((row) => !validOsm.has(`osm:${row.osm_type}/${row.osm_id}`))
          .map((row) => `osm:${row.osm_type}/${row.osm_id}`),
      );
      const places = mergeAmbientPlaces(osm, overture, links, excludedOsm).filter((p) =>
        inside(p.coordinates),
      );
      if (places.length === 0) throw new Error("Refusing to publish an empty ambient generation");
      if (places.length > AMBIENT_LIMITS.places)
        throw new Error("Combined regional output exceeds 100000 places");
      const generation = await prepareAmbientGeneration(tx);
      const manifest: AmbientManifest = {
        version: 1,
        policyVersion: AMBIENT_POLICY_VERSION,
        generation,
        publishedAt: new Date().toISOString(),
        region,
        placeCount: places.length,
        enabled: true,
        sources: {
          osm: {
            region: osmState.region,
            epoch: osmState.epoch,
            publishedAt: osmPublished,
            count: osm.filter((p) => inside(p.coordinates)).length,
          },
          overture: overtureSource,
        },
      };
      await tx.unsafe(
        `INSERT INTO ambient_places.generations(id,manifest) VALUES($1,$2::TEXT::JSONB)`,
        [manifest.generation, JSON.stringify(manifest)],
      );
      await insertAmbientFeatures(tx, manifest.generation, places);
      await activateAmbientGeneration(tx, manifest);
      return manifest;
    });
  } catch (error) {
    if (startedAt !== null) {
      // The candidate transaction has rolled back. Record its failure only if
      // no newer writer owns the lock or has already completed another attempt.
      await sql
        .begin(async (tx) => {
          const [writer] = await tx.unsafe<{ locked: boolean }[]>(
            `SELECT pg_try_advisory_xact_lock(${AMBIENT_WRITE_LOCK}) AS locked`,
          );
          if (!writer.locked) return;
          await tx.unsafe(
            `UPDATE ambient_places.state SET last_build_id=$1,last_build_started_at=$2,last_build_finished_at=clock_timestamp(),last_build_error=$3 WHERE singleton=1 AND (last_build_started_at IS NULL OR last_build_started_at<=$2::TIMESTAMPTZ OR last_build_id=$1)`,
            [attempt, startedAt, error instanceof Error ? error.message : "Publication failed"],
          );
        })
        .catch(() => undefined);
    }
    throw error;
  }
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
      `UPDATE ambient_places.generations SET cache_lease_until=greatest(cache_lease_until,now()+interval '7 days 1 minute') WHERE id IN (SELECT active FROM ambient_places.state WHERE singleton=1 UNION SELECT previous FROM ambient_places.state WHERE singleton=1)`,
    );
    await tx.unsafe(
      `UPDATE ambient_places.state SET active=previous,previous=active WHERE singleton=1`,
    );
  });
}
