import type postgres from "postgres";

export const AMBIENT_WRITE_LOCK = 139399;
export const ambientSchemaDDL = `
CREATE SCHEMA IF NOT EXISTS ambient_places;
CREATE TABLE IF NOT EXISTS ambient_places.generations (
  id UUID PRIMARY KEY, manifest JSONB NOT NULL, published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ambient_places.features (
  generation UUID NOT NULL REFERENCES ambient_places.generations(id) ON DELETE CASCADE,
  id TEXT NOT NULL, gers_id TEXT, name TEXT NOT NULL, name_de TEXT, name_en TEXT,
  category TEXT NOT NULL, rank INTEGER NOT NULL, min_zoom SMALLINT NOT NULL,
  tenant BOOLEAN NOT NULL, sources TEXT NOT NULL, geom geometry(POINT,3857) NOT NULL,
  PRIMARY KEY(generation,id)
);
CREATE INDEX IF NOT EXISTS ambient_features_geom ON ambient_places.features USING GIST(geom);
CREATE TABLE IF NOT EXISTS ambient_places.state (
  singleton SMALLINT PRIMARY KEY CHECK(singleton=1),
  active UUID REFERENCES ambient_places.generations(id), previous UUID REFERENCES ambient_places.generations(id),
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_build_started_at TIMESTAMPTZ, last_build_finished_at TIMESTAMPTZ, last_build_error TEXT
);
INSERT INTO ambient_places.state(singleton) VALUES(1) ON CONFLICT DO NOTHING;
`;
const initialization = new WeakMap<postgres.Sql, Promise<void>>();
export async function ensureAmbientSchema(sql: postgres.Sql): Promise<void> {
  let ready = initialization.get(sql);
  if (!ready) {
    ready = sql
      .begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL statement_timeout='10000ms'; SELECT pg_advisory_xact_lock(${AMBIENT_WRITE_LOCK})`,
        );
        await tx.unsafe(ambientSchemaDDL);
      })
      .then(() => undefined);
    initialization.set(sql, ready);
    ready.catch(() => initialization.delete(sql));
  }
  await ready;
}
