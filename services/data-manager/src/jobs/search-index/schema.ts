import { buildPublicationFenceDDL } from "../publication-fence.js";

export type SearchIndexSchema = "osm_search" | "osm_search__staging";

export function assertValidSearchIndexSchema(schema: string): asserts schema is SearchIndexSchema {
  if (schema !== "osm_search" && schema !== "osm_search__staging") {
    throw new Error(`Invalid search index schema: ${schema}`);
  }
}

export function buildSearchIndexSchemaDDL(schema: SearchIndexSchema): string {
  assertValidSearchIndexSchema(schema);
  return `
DROP SCHEMA IF EXISTS "${schema}" CASCADE;
CREATE SCHEMA "${schema}";
${buildPublicationFenceDDL(schema)}

CREATE TABLE "${schema}".places (
  osm_type TEXT NOT NULL CONSTRAINT places_osm_type_check CHECK (osm_type IN ('node','way','relation')),
  osm_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  geom GEOMETRY(Point, 4326) NOT NULL CONSTRAINT places_geom_check
    CHECK (ST_X(geom) BETWEEN -180 AND 180 AND ST_Y(geom) BETWEEN -90 AND 90),
  category TEXT,
  tags JSONB NOT NULL,
  importance DOUBLE PRECISION NOT NULL
    CONSTRAINT places_importance_check CHECK (importance BETWEEN 0 AND 1),
  CONSTRAINT places_pkey PRIMARY KEY (osm_type, osm_id)
);

CREATE TABLE "${schema}".terms (
  osm_type TEXT NOT NULL,
  osm_id BIGINT NOT NULL,
  normalized_term TEXT NOT NULL,
  display_value TEXT NOT NULL,
  kind TEXT NOT NULL CONSTRAINT terms_kind_check
    CHECK (kind IN ('authoritative_code','explicit_reference','explicit_alias','generated_acronym')),
  namespace TEXT,
  CONSTRAINT terms_pkey PRIMARY KEY (osm_type, osm_id, kind, normalized_term),
  CONSTRAINT terms_osm_type_osm_id_fkey FOREIGN KEY (osm_type, osm_id)
    REFERENCES "${schema}".places ON DELETE CASCADE
);

CREATE TABLE "${schema}".index_state (
  singleton SMALLINT DEFAULT 1 CONSTRAINT index_state_singleton_check CHECK (singleton = 1),
  region TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  current_fingerprint TEXT NOT NULL,
  epoch TEXT NOT NULL,
  status TEXT NOT NULL CONSTRAINT index_state_status_check
    CHECK (status IN ('building','ready','failed')),
  place_count BIGINT NOT NULL DEFAULT 0,
  term_count BIGINT NOT NULL DEFAULT 0,
  ambient_source_version INTEGER NOT NULL DEFAULT 2,
  source_file_identity TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  last_error TEXT,
  CONSTRAINT index_state_pkey PRIMARY KEY (singleton)
);
`;
}

export function buildSearchIndexIndexesDDL(schema: SearchIndexSchema): string {
  assertValidSearchIndexSchema(schema);
  // A text_pattern_ops btree serves the exact lookup as well as the prefix one.
  return `
CREATE INDEX terms_normalized_term_idx ON "${schema}".terms (normalized_term text_pattern_ops);
CREATE INDEX places_geom_idx ON "${schema}".places USING GIST (geom);
`;
}
