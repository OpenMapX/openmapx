import {
  AMBIENT_FORMAT_VERSION,
  AMBIENT_PLANET_REGION,
  AMBIENT_POLICY_VERSION,
  type AmbientManifest,
  type AmbientRegion,
  validateAmbientRegion,
} from "@openmapx/core/ambient-places";
import { DATA_ADVISORY_LOCKS } from "@openmapx/core/data-manager-sdk";
import { itemAt } from "@openmapx/core/item-at";
import postgres from "postgres";
import { cancellableTransaction } from "../execution/worker-scope.js";
import { freeBytesInPostgresContainer } from "../overture/capacity.js";
import { assertPlanetDiskCapacity, planetPlaceLimit } from "./capacity.js";
import {
  attachFeatureStorage,
  createFeatureStorage,
  dropRetiredFeatureStorage,
  featureTable,
} from "./feature-storage.js";
import type { AmbientBuildOptions } from "./germany.js";
import { planetOsmBatch, planetOvertureBatch } from "./planet-batches.js";
import { capturePlanetSources, type PlanetCheckpoint, readPlanetStage } from "./planet-state.js";
import {
  insertAmbientFeatures,
  insertAmbientGeneration,
  prepareAmbientGeneration,
} from "./publication.js";
import { AMBIENT_WRITE_LOCK, AmbientPublicationBusyError, ensureAmbientSchema } from "./schema.js";

export { readPlanetStage } from "./planet-state.js";

async function withPlanetSession<T>(
  sql: postgres.Sql,
  operation: (connection: postgres.Sql, pid: number) => Promise<T>,
): Promise<T> {
  await ensureAmbientSchema(sql);
  // A dedicated one-connection pool preserves session locks between transactions.
  // Unlike reserve(), it also rejects/reconnects safely after backend termination.
  // The driver itself clones parsed options this way for subscriptions. Its
  // public Options type omits the parsed host/port arrays accepted at runtime.
  const options = { ...sql.options, max: 1, idle_timeout: 0, max_lifetime: 0 };
  const connection = postgres(options as unknown as postgres.Options<{}>);
  let writer = false;
  const held: (readonly [number, number])[] = [];
  try {
    const lock = itemAt(
      await connection.unsafe<{ locked: boolean; pid: number }[]>(
        `SELECT pg_try_advisory_lock(${AMBIENT_WRITE_LOCK}) AS locked,pg_backend_pid() AS pid`,
      ),
      0,
      "row from the ambient write lock query",
    );
    if (!lock.locked) throw new AmbientPublicationBusyError();
    writer = true;
    for (const pair of [DATA_ADVISORY_LOCKS.overture, DATA_ADVISORY_LOCKS.searchIndex]) {
      const source = itemAt(
        await connection.unsafe<{ locked: boolean }[]>(
          `SELECT pg_try_advisory_lock_shared($1,$2) AS locked`,
          [...pair],
        ),
        0,
        "row from the planet source lock query",
      );
      if (!source.locked)
        throw new AmbientPublicationBusyError(
          "Planet sources are being prepared; retry after source publication",
        );
      held.push(pair);
    }
    return await operation(connection, lock.pid);
  } finally {
    try {
      for (const pair of held.reverse())
        await connection.unsafe(`SELECT pg_advisory_unlock_shared($1,$2)`, [...pair]);
      if (writer) await connection.unsafe(`SELECT pg_advisory_unlock(${AMBIENT_WRITE_LOCK})`);
    } finally {
      await connection.end({ timeout: 2 });
    }
  }
}
async function assertSession(connection: Pick<postgres.Sql, "unsafe">, pid: number): Promise<void> {
  const [row] = await connection.unsafe<{ pid: number; locked: boolean }[]>(
    `SELECT pg_backend_pid() AS pid,EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=0 AND objid=${AMBIENT_WRITE_LOCK} AND objsubid=1 AND granted) AS locked`,
  );
  if (row?.pid !== pid || !row.locked)
    throw new Error(
      "Planet build connection lost its source locks; resume the committed checkpoint",
    );
}
async function planetTransaction<T>(
  connection: postgres.Sql,
  pid: number,
  operation: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return cancellableTransaction(connection, async (tx) => {
    await assertSession(tx, pid);
    return operation(tx);
  });
}
const initial: PlanetCheckpoint = {
  phase: "osm",
  osmType: "",
  osmId: "0",
  gers: "",
  processed: 0,
  batches: 0,
  placeCount: 0,
  osmProcessed: 0,
  overtureProcessed: 0,
  osmCount: 0,
  overtureCount: 0,
};
export async function buildPlanetPlaces(
  sql: postgres.Sql,
  onClaim?: () => void | Promise<void>,
  options: AmbientBuildOptions & { region?: AmbientRegion } = {},
): Promise<AmbientManifest> {
  return withPlanetSession(sql, async (connection, pid) => {
    if (await readPlanetStage(connection))
      throw new AmbientPublicationBusyError(
        "Resume or discard the interrupted planet candidate before a new build",
      );
    const source = await capturePlanetSources(connection);
    const available = options.availableBytes ?? freeBytesInPostgresContainer;
    assertPlanetDiskCapacity(await available(), source.osmRows + source.overtureRows);
    const region = validateAmbientRegion(options.region ?? AMBIENT_PLANET_REGION);
    if (region.coverage !== "planet") throw new Error("Planet coverage is required");
    let manifest!: AmbientManifest;
    await planetTransaction(connection, pid, async (tx) => {
      const generation = await prepareAmbientGeneration(tx);
      manifest = {
        version: AMBIENT_FORMAT_VERSION,
        policyVersion: AMBIENT_POLICY_VERSION,
        generation,
        publishedAt: new Date().toISOString(),
        region,
        placeCount: 0,
        enabled: true,
        sources: source.sources,
      };
      await insertAmbientGeneration(tx, manifest, "planet", "staging");
      await tx.unsafe(
        `INSERT INTO ambient_places.planet_builds(generation,source_signature,status,checkpoint) VALUES($1,$2,'running',$3::TEXT::JSONB)`,
        [generation, source.signature, JSON.stringify(initial)],
      );
      await tx.unsafe(
        `UPDATE ambient_places.state SET last_build_id=$1,last_build_started_at=clock_timestamp(),last_build_finished_at=NULL,last_build_error=NULL WHERE singleton=1`,
        [generation],
      );
    });
    await onClaim?.();
    await dropRetiredFeatureStorage(sql, { retry: options.cleanupRetry });
    return runPlanet(connection, pid, manifest, source.signature, { ...initial }, options);
  });
}
export async function resumePlanetPlaces(
  sql: postgres.Sql,
  generation: string,
  onClaim?: () => void | Promise<void>,
  options: AmbientBuildOptions = {},
): Promise<AmbientManifest> {
  featureTable(generation);
  return withPlanetSession(sql, async (connection, pid) => {
    const [stage] = await connection.unsafe<
      {
        manifest: AmbientManifest;
        checkpoint: PlanetCheckpoint;
        source_signature: string;
        publication_status: string;
      }[]
    >(
      `SELECT g.manifest,g.publication_status,b.checkpoint,b.source_signature FROM ambient_places.planet_builds b JOIN ambient_places.generations g ON g.id=b.generation WHERE g.id=$1`,
      [generation],
    );
    if (!stage || stage.publication_status !== "staging")
      throw new Error("Only an unpublished planet candidate can be resumed");
    if (stage.manifest.version !== AMBIENT_FORMAT_VERSION)
      throw new Error("Planet attribution format changed; discard and rebuild the candidate");
    if (stage.manifest.policyVersion !== AMBIENT_POLICY_VERSION)
      throw new Error("Planet policy changed; discard and rebuild the candidate");
    const source = await capturePlanetSources(connection);
    if (source.signature !== stage.source_signature)
      throw new Error("Planet sources changed; discard and rebuild the candidate");
    // Backups leave candidate tables out, so a restored build has its
    // checkpoint but none of its rows; it starts again from the beginning.
    let checkpoint = stage.checkpoint;
    await planetTransaction(connection, pid, async (tx) => {
      const [candidate] = await tx.unsafe<{ exists: boolean }[]>(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [featureTable(generation, "candidate")],
      );
      if (!candidate?.exists) {
        await createFeatureStorage(tx, generation, "candidate");
        checkpoint = { ...initial };
      }
      await tx.unsafe(
        `UPDATE ambient_places.planet_builds SET status='running',error=NULL,checkpoint=$2::TEXT::JSONB,updated_at=clock_timestamp() WHERE generation=$1`,
        [generation, JSON.stringify(checkpoint)],
      );
    });
    await connection.unsafe(
      `UPDATE ambient_places.state SET last_build_id=$1,last_build_finished_at=NULL,last_build_error=NULL WHERE singleton=1`,
      [generation],
    );
    await onClaim?.();
    return runPlanet(connection, pid, stage.manifest, stage.source_signature, checkpoint, options);
  });
}
async function runPlanet(
  connection: postgres.Sql,
  pid: number,
  manifest: AmbientManifest,
  signature: string,
  checkpoint: PlanetCheckpoint,
  options: AmbientBuildOptions,
): Promise<AmbientManifest> {
  const generation = manifest.generation;
  const table = featureTable(generation, "candidate");
  const available = options.availableBytes ?? freeBytesInPostgresContainer;
  const limit = planetPlaceLimit();
  try {
    const source = await capturePlanetSources(connection);
    if (source.signature !== signature)
      throw new Error("Planet sources changed; discard and rebuild the candidate");
    while (checkpoint.phase !== "validate") {
      await assertSession(connection, pid);
      assertPlanetDiskCapacity(
        await available(),
        source.osmRows + source.overtureRows - checkpoint.processed,
      );
      checkpoint = await planetTransaction(connection, pid, async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout='120000ms'`);
        const overtureSource = source.overture;
        let batch: Awaited<ReturnType<typeof planetOsmBatch>>;
        if (checkpoint.phase === "osm")
          batch = await planetOsmBatch(tx, checkpoint, overtureSource);
        else if (overtureSource !== null)
          batch = await planetOvertureBatch(tx, checkpoint, overtureSource);
        else throw new Error("Planet build reached its Overture phase without an Overture release");
        const next = {
          ...batch.checkpoint,
          processed: checkpoint.processed + batch.rows,
          batches: checkpoint.batches + (batch.rows ? 1 : 0),
          placeCount: checkpoint.placeCount + batch.places.length,
        };
        if (next.placeCount > limit)
          throw new Error(
            `Planet ambient output exceeds ${limit} places; size and configure capacity before retrying`,
          );
        await insertAmbientFeatures(tx, generation, batch.places, "candidate");
        await tx.unsafe(
          `UPDATE ambient_places.planet_builds SET checkpoint=$2::TEXT::JSONB,updated_at=clock_timestamp() WHERE generation=$1`,
          [generation, JSON.stringify(next)],
        );
        return next;
      });
      await options.onProgress?.(checkpoint);
    }
    await assertSession(connection, pid);
    assertPlanetDiskCapacity(await available(), 0);
    const finalSources = await capturePlanetSources(connection);
    if (finalSources.signature !== signature)
      throw new Error("Planet sources changed; discard and rebuild the candidate");
    if (
      !checkpoint.placeCount ||
      checkpoint.osmProcessed !== finalSources.osmRows ||
      checkpoint.overtureProcessed !== finalSources.overtureRows
    )
      throw new Error(
        "Planet candidate source/count validation failed; active generation retained",
      );
    await connection.unsafe(`ANALYZE ${table}`);
    manifest = {
      ...manifest,
      placeCount: checkpoint.placeCount,
      publishedAt: new Date().toISOString(),
      sources: {
        osm: { ...manifest.sources.osm, count: checkpoint.osmCount },
        overture: manifest.sources.overture
          ? { ...manifest.sources.overture, count: checkpoint.overtureCount }
          : null,
      },
    };
    await options.onProgress?.(checkpoint);
    await planetTransaction(connection, pid, async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout='1000ms'; SET LOCAL statement_timeout='120000ms'`);
      await attachFeatureStorage(tx, generation, { retry: options.lockRetry, from: "candidate" });
      await tx.unsafe(
        `UPDATE ambient_places.generations SET manifest=$2::TEXT::JSONB,publication_status='published',published_at=clock_timestamp(),cache_lease_until=clock_timestamp()+interval '7 days 1 minute' WHERE id=$1`,
        [generation, JSON.stringify(manifest)],
      );
      await tx.unsafe(
        `UPDATE ambient_places.generations SET cache_lease_until=greatest(cache_lease_until,clock_timestamp()+interval '7 days 1 minute') WHERE id=(SELECT active FROM ambient_places.state WHERE singleton=1)`,
      );
      await tx.unsafe(
        `UPDATE ambient_places.state SET previous=active,active=$1,last_build_finished_at=clock_timestamp(),last_build_error=NULL WHERE singleton=1`,
        [generation],
      );
      await tx.unsafe(
        `UPDATE ambient_places.planet_builds SET status='completed',error=NULL,updated_at=clock_timestamp() WHERE generation=$1`,
        [generation],
      );
    });
    return manifest;
  } catch (error) {
    // Only the original locked backend may record failure. A disconnected
    // session leaves its durable checkpoint available for explicit resume.
    await assertSession(connection, pid)
      .then(async () => {
        const message = error instanceof Error ? error.message : "Planet build failed";
        await planetTransaction(connection, pid, async (tx) => {
          await tx.unsafe(
            `UPDATE ambient_places.planet_builds SET status='failed',error=$2,updated_at=clock_timestamp() WHERE generation=$1`,
            [generation, message],
          );
          await tx.unsafe(
            `UPDATE ambient_places.state SET last_build_finished_at=clock_timestamp(),last_build_error=$2 WHERE singleton=1 AND last_build_id=$1`,
            [generation, message],
          );
        });
      })
      .catch(() => undefined);
    throw error;
  }
}
export async function discardPlanetPlaces(sql: postgres.Sql, generation: string): Promise<void> {
  const table = featureTable(generation, "candidate");
  return withPlanetSession(sql, async (connection, pid) => {
    await planetTransaction(connection, pid, async (tx) => {
      const [row] = await tx.unsafe<{ publication_status: string }[]>(
        `SELECT publication_status FROM ambient_places.generations WHERE id=$1`,
        [generation],
      );
      if (!row || row.publication_status !== "staging")
        throw new Error("Only an unpublished planet candidate can be discarded");
      // A restored candidate has no table: backups leave it out.
      await tx.unsafe(`SET LOCAL lock_timeout='1000ms'; DROP TABLE IF EXISTS ${table}`);
      await tx.unsafe(`DELETE FROM ambient_places.generations WHERE id=$1`, [generation]);
      await tx.unsafe(
        `UPDATE ambient_places.state SET last_build_error=NULL WHERE singleton=1 AND last_build_id=$1`,
        [generation],
      );
    });
  });
}
