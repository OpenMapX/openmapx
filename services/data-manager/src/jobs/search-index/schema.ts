export type SearchIndexSchema = "osm_search" | "osm_search__staging";

export function assertValidSearchIndexSchema(schema: string): asserts schema is SearchIndexSchema {
  if (schema !== "osm_search" && schema !== "osm_search__staging") {
    throw new Error(`Invalid search index schema: ${schema}`);
  }
}

export function buildSearchIndexSchemaDDL(schema: SearchIndexSchema): string {
  assertValidSearchIndexSchema(schema);
  return `
CREATE EXTENSION IF NOT EXISTS postgis;
DROP SCHEMA IF EXISTS "${schema}" CASCADE;
CREATE SCHEMA "${schema}";

CREATE TABLE "${schema}".places (
  osm_type TEXT NOT NULL CHECK (osm_type IN ('node','way','relation')),
  osm_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  geom GEOGRAPHY(POINT, 4326) GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
  ) STORED,
  category TEXT,
  tags JSONB NOT NULL,
  importance DOUBLE PRECISION NOT NULL CHECK (importance BETWEEN 0 AND 1),
  PRIMARY KEY (osm_type, osm_id)
);

CREATE TABLE "${schema}".terms (
  osm_type TEXT NOT NULL,
  osm_id BIGINT NOT NULL,
  normalized_term TEXT NOT NULL,
  display_value TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('authoritative_code','explicit_reference','explicit_alias','generated_acronym')),
  namespace TEXT,
  PRIMARY KEY (osm_type, osm_id, kind, normalized_term),
  FOREIGN KEY (osm_type, osm_id) REFERENCES "${schema}".places ON DELETE CASCADE
);

CREATE TABLE "${schema}".index_state (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  region TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  current_fingerprint TEXT NOT NULL,
  epoch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building','ready','failed')),
  place_count BIGINT NOT NULL DEFAULT 0,
  term_count BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  last_error TEXT
);
`;
}

export function buildSearchIndexIndexesDDL(schema: SearchIndexSchema): string {
  assertValidSearchIndexSchema(schema);
  return `
CREATE INDEX idx_osm_search_terms_exact ON "${schema}".terms (normalized_term);
CREATE INDEX idx_osm_search_terms_prefix ON "${schema}".terms (normalized_term text_pattern_ops);
CREATE INDEX idx_osm_search_places_geom ON "${schema}".places USING GIST (geom);
`;
}
