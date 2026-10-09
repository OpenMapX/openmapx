import type postgres from "postgres";

export const AMBIENT_WRITE_LOCK = 139399;
export class AmbientPublicationBusyError extends Error {
  constructor(message = "Another ambient publication or pointer change is running") {
    super(message);
  }
}
export const ambientSchemaDDL = `
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS ambient_places;
CREATE TABLE IF NOT EXISTS ambient_places.generations (
  id UUID PRIMARY KEY, manifest JSONB NOT NULL, published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cache_lease_until TIMESTAMPTZ NOT NULL DEFAULT now()+interval '7 days 1 minute'
);
ALTER TABLE ambient_places.generations ADD COLUMN IF NOT EXISTS cache_lease_until TIMESTAMPTZ NOT NULL DEFAULT now()+interval '7 days 1 minute';
ALTER TABLE ambient_places.generations ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE ambient_places.generations ADD COLUMN IF NOT EXISTS publication_status TEXT NOT NULL DEFAULT 'published';
CREATE TABLE IF NOT EXISTS ambient_places.features (
  generation UUID NOT NULL REFERENCES ambient_places.generations(id) ON DELETE CASCADE,
  id TEXT NOT NULL, gers_id TEXT, name TEXT NOT NULL, name_de TEXT, name_en TEXT,
  category TEXT NOT NULL, rank INTEGER NOT NULL, min_zoom SMALLINT NOT NULL,
  tenant BOOLEAN NOT NULL, sources TEXT NOT NULL, geom BYTEA NOT NULL,
  PRIMARY KEY(generation,id)
);
-- EWKB keeps this internal store out of Martin's automatic geometry-table discovery.
CREATE INDEX IF NOT EXISTS ambient_features_generation_geom ON ambient_places.features USING GIST(generation,ST_GeomFromEWKB(geom));
DROP INDEX IF EXISTS ambient_places.ambient_features_geom;
CREATE INDEX IF NOT EXISTS ambient_features_gers ON ambient_places.features(generation,gers_id) WHERE gers_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS ambient_places.state (
  singleton SMALLINT PRIMARY KEY CHECK(singleton=1),
  active UUID REFERENCES ambient_places.generations(id), previous UUID REFERENCES ambient_places.generations(id),
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_build_id UUID, last_build_started_at TIMESTAMPTZ, last_build_finished_at TIMESTAMPTZ, last_build_error TEXT
);
ALTER TABLE ambient_places.state ADD COLUMN IF NOT EXISTS last_build_id UUID;
CREATE TABLE IF NOT EXISTS ambient_places.planet_features (
  LIKE ambient_places.features INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  PRIMARY KEY(generation,id)
) PARTITION BY LIST(generation);
CREATE INDEX IF NOT EXISTS ambient_planet_geom ON ambient_places.planet_features USING GIST(ST_GeomFromEWKB(geom));
CREATE INDEX IF NOT EXISTS ambient_planet_gers ON ambient_places.planet_features(generation,gers_id) WHERE gers_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS ambient_places.planet_builds (
  generation UUID PRIMARY KEY REFERENCES ambient_places.generations(id) ON DELETE CASCADE,
  source_signature TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','failed','completed')),
  checkpoint JSONB NOT NULL, error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE VIEW ambient_places.features_all AS
  SELECT f.* FROM ambient_places.features f JOIN ambient_places.generations g ON g.id=f.generation WHERE g.publication_status='published'
  UNION ALL
  SELECT f.* FROM ambient_places.planet_features f JOIN ambient_places.generations g ON g.id=f.generation WHERE g.publication_status='published';
INSERT INTO ambient_places.state(singleton) VALUES(1) ON CONFLICT DO NOTHING;
`;
const initialization = new WeakMap<postgres.Sql, Promise<void>>();
export async function ensureAmbientSchema(sql: postgres.Sql): Promise<void> {
  let ready = initialization.get(sql);
  if (!ready) {
    ready = sql
      .begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout='10000ms'`);
        const [writer] = await tx.unsafe<{ locked: boolean }[]>(
          `SELECT pg_try_advisory_xact_lock(${AMBIENT_WRITE_LOCK}) AS locked`,
        );
        if (!writer.locked) throw new AmbientPublicationBusyError();
        await tx.unsafe(ambientSchemaDDL);
      })
      .then(() => undefined);
    initialization.set(sql, ready);
    ready.catch(() => initialization.delete(sql));
  }
  await ready;
}
