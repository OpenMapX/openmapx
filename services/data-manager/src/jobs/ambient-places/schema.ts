import { DATA_ADVISORY_LOCKS } from "@openmapx/core/data-manager-sdk";
import { itemAt } from "@openmapx/core/item-at";
import type postgres from "postgres";
import { cancellableTransaction } from "../execution/worker-scope.js";

export const AMBIENT_WRITE_LOCK = DATA_ADVISORY_LOCKS.ambientPublication;
export class AmbientPublicationBusyError extends Error {
  constructor(message = "Another ambient publication or pointer change is running") {
    super(message);
  }
}

/**
 * The layout `ambientSchemaDDL` creates. Data-manager creates this schema at
 * runtime and never upgrades it: a schema of another version is refused, and
 * the operator drops it and builds nearby places again.
 */
export const AMBIENT_SCHEMA_VERSION = 1;

/**
 * Every generation, regional or planet, is one partition of `features`,
 * created as a standalone table, filled, and attached when it is published.
 * Retiring a generation detaches and drops its partition.
 */
export const ambientSchemaDDL = `
CREATE SCHEMA IF NOT EXISTS ambient_places;
CREATE TABLE ambient_places.generations (
  id UUID NOT NULL, manifest JSONB NOT NULL, published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cache_lease_until TIMESTAMPTZ NOT NULL DEFAULT now()+interval '7 days 1 minute',
  storage TEXT NOT NULL, publication_status TEXT NOT NULL,
  CONSTRAINT generations_pkey PRIMARY KEY(id),
  CONSTRAINT generations_storage_check CHECK(storage IN ('regional','planet')),
  CONSTRAINT generations_publication_status_check CHECK(publication_status IN ('staging','published'))
);
CREATE TABLE ambient_places.features (
  generation UUID NOT NULL, id TEXT NOT NULL, gers_id TEXT, name TEXT NOT NULL, name_de TEXT, name_en TEXT,
  category TEXT NOT NULL, rank INTEGER NOT NULL, min_zoom SMALLINT NOT NULL,
  tenant BOOLEAN NOT NULL, sources TEXT NOT NULL, geom geometry(Geometry, 3857) NOT NULL,
  contributors JSONB, field_contributors JSONB, source_lineage JSONB,
  CONSTRAINT features_pkey PRIMARY KEY(generation,id)
) PARTITION BY LIST(generation);
CREATE INDEX features_geom_idx ON ambient_places.features USING GIST(geom);
CREATE INDEX features_gers_id_idx ON ambient_places.features(gers_id) WHERE gers_id IS NOT NULL;
CREATE TABLE ambient_places.state (
  singleton SMALLINT NOT NULL, schema_version INTEGER NOT NULL,
  active UUID, previous UUID, enabled BOOLEAN NOT NULL DEFAULT true,
  last_build_id UUID, last_build_started_at TIMESTAMPTZ, last_build_finished_at TIMESTAMPTZ, last_build_error TEXT,
  CONSTRAINT state_pkey PRIMARY KEY(singleton),
  CONSTRAINT state_singleton_check CHECK(singleton=1),
  CONSTRAINT state_active_fkey FOREIGN KEY(active) REFERENCES ambient_places.generations(id),
  CONSTRAINT state_previous_fkey FOREIGN KEY(previous) REFERENCES ambient_places.generations(id)
);
CREATE TABLE ambient_places.planet_builds (
  generation UUID NOT NULL, source_signature TEXT NOT NULL, status TEXT NOT NULL,
  checkpoint JSONB NOT NULL, error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT planet_builds_pkey PRIMARY KEY(generation),
  CONSTRAINT planet_builds_generation_fkey FOREIGN KEY(generation) REFERENCES ambient_places.generations(id) ON DELETE CASCADE,
  CONSTRAINT planet_builds_status_check CHECK(status IN ('running','failed','completed'))
);
INSERT INTO ambient_places.state(singleton,schema_version) VALUES(1,${AMBIENT_SCHEMA_VERSION});
`;

export class AmbientSchemaVersionError extends Error {
  constructor(found: number | null) {
    super(
      `The ambient_places schema has ${found === null ? "no schema version" : `version ${found}`}, but this data manager uses version ${AMBIENT_SCHEMA_VERSION}. Drop it with DROP SCHEMA ambient_places CASCADE and build nearby places again.`,
    );
  }
}

/** The version of an existing schema: undefined when there is nothing to keep, null when it has no marker. */
async function existingVersion(tx: postgres.TransactionSql): Promise<number | null | undefined> {
  const layout = itemAt(
    await tx.unsafe<{ tables: boolean; versioned: boolean }[]>(
      `SELECT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=to_regnamespace('ambient_places')) AS tables,
        EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('ambient_places.state') AND attname='schema_version' AND NOT attisdropped) AS versioned`,
    ),
    0,
    "row from the ambient schema layout query",
  );
  if (!layout.tables) return undefined;
  if (!layout.versioned) return null;
  const [state] = await tx.unsafe<{ schema_version: number }[]>(
    `SELECT schema_version FROM ambient_places.state WHERE singleton=1`,
  );
  return state?.schema_version ?? null;
}

const initialization = new WeakMap<postgres.Sql, Promise<void>>();
export async function ensureAmbientSchema(sql: postgres.Sql): Promise<void> {
  let ready = initialization.get(sql);
  if (!ready) {
    ready = cancellableTransaction(sql, async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout='10000ms'`);
      const writer = itemAt(
        await tx.unsafe<{ locked: boolean }[]>(
          `SELECT pg_try_advisory_xact_lock(${AMBIENT_WRITE_LOCK}) AS locked`,
        ),
        0,
        "row from the ambient write lock query",
      );
      if (!writer.locked) throw new AmbientPublicationBusyError();
      const version = await existingVersion(tx);
      if (version === undefined) await tx.unsafe(ambientSchemaDDL);
      else if (version !== AMBIENT_SCHEMA_VERSION) throw new AmbientSchemaVersionError(version);
    });
    initialization.set(sql, ready);
    ready.catch(() => initialization.delete(sql));
  }
  await ready;
}
