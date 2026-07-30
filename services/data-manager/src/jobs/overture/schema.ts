/**
 * Schema names that carry ODbL-licensed Overture themes (Buildings,
 * Transportation, Divisions, Base). These are explicitly rejected to enforce
 * CDLA-Permissive ↔ ODbL license isolation: any code in the `overture_places`
 * path must never inadvertently touch these schemas.
 */
const ODBL_BLOCKED_SCHEMAS = new Set([
  "overture_buildings",
  "overture_transportation",
  "overture_divisions",
  "overture_base",
]);

/**
 * Guards against operating on a non-Overture schema, an ODbL-licensed Overture
 * theme, or any name that is unsafe to interpolate into raw DDL SQL.
 *
 * Why strict: the name is interpolated directly into DDL identifiers
 * (`"${schema}".places`). Accepting arbitrary characters would permit
 * SQL-identifier injection via embedded quotes or other special chars.
 * The regex pins the shape to a single, safe form — mirrors `assertValidGtfsSchema`
 * from the GTFS importer.
 *
 * Allowed form: `overture_` followed by 1–55 lowercase letters, digits, or
 * underscores. The 55-char suffix cap keeps total length ≤ 63 (PostgreSQL's
 * identifier limit) and accommodates the `__staging` suffix appended internally.
 */
const OVERTURE_SCHEMA_RE = /^overture_[a-z0-9_]{1,55}$/;

export function assertValidOvertureSchema(name: string): void {
  if (!OVERTURE_SCHEMA_RE.test(name)) {
    throw new Error(
      `Invalid Overture schema name "${name}": must match overture_[a-z0-9_]{1,55} ` +
        `(lowercase letters, digits, underscores only; no hyphens, uppercase, or special chars)`,
    );
  }
  if (ODBL_BLOCKED_SCHEMAS.has(name)) {
    throw new Error(
      `Schema "${name}" is an ODbL-licensed Overture theme (Buildings/Transportation/Divisions/Base). ` +
        `The overture_places code path must not access it — CDLA↔ODbL isolation violation.`,
    );
  }
}

/**
 * Returns the raw SQL DDL string for the overture_places schema and its tables.
 * All columns follow design §5. Notable choices:
 *   - h3_r8 is TEXT (the 15-char hex H3 cell index) — H3 cell values are
 *     unsigned 64-bit integers that overflow signed int8; hex string storage
 *     sidesteps the conversion and is adequate for equality/grouping blocking.
 *   - geom is GEOMETRY(POINT,4326) (not geography) for lower-cost bbox/&& ops.
 */
export interface BuildOvertureSchemaOptions {
  /** Bulk ingest maintains these more cheaply when they are built after load. */
  deferPlacesIndexes?: boolean;
}

export function buildPlacesIndexesDDL(schema: string): string {
  assertValidOvertureSchema(schema);
  return `
    CREATE INDEX idx_overture_geom ON "${schema}".places USING GIST (geom);
    CREATE INDEX idx_overture_h3   ON "${schema}".places (h3_r8);
    CREATE INDEX idx_overture_basic_category ON "${schema}".places (basic_category);
    CREATE INDEX idx_overture_taxonomy_primary ON "${schema}".places (taxonomy_primary);
    CREATE INDEX idx_overture_taxonomy_hierarchy
      ON "${schema}".places USING GIN (taxonomy_hierarchy);
    CREATE INDEX idx_overture_taxonomy_alternates
      ON "${schema}".places USING GIN (taxonomy_alternates);
  `;
}

export function buildSchemaDDL(schema: string, options: BuildOvertureSchemaOptions = {}): string {
  assertValidOvertureSchema(schema);
  return (
    `
    CREATE EXTENSION IF NOT EXISTS postgis;
    DROP SCHEMA IF EXISTS "${schema}" CASCADE;
    CREATE SCHEMA "${schema}";

    CREATE TABLE "${schema}".places (
      gers_id           TEXT PRIMARY KEY,
      name              TEXT NOT NULL DEFAULT '',
      names             JSONB,
      basic_category    TEXT,
      taxonomy_primary  TEXT,
      taxonomy_hierarchy TEXT[],
      taxonomy_alternates TEXT[],
      geom              GEOMETRY NOT NULL,
      h3_r8             TEXT,
      addresses         JSONB,
      country_code      TEXT,
      websites          TEXT[],
      socials           TEXT[],
      emails            TEXT[],
      phones            TEXT[],
      brand             JSONB,
      confidence        DOUBLE PRECISION,
      operating_status  TEXT,
      sources           JSONB,
      release           TEXT NOT NULL,
      imported_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE "${schema}".poi_conflation_link (
      osm_type          TEXT NOT NULL,
      osm_id            BIGINT NOT NULL,
      gers_id           TEXT NOT NULL UNIQUE REFERENCES "${schema}".places(gers_id) ON DELETE CASCADE,
      source_confidence DOUBLE PRECISION,
      match_confidence  DOUBLE PRECISION NOT NULL CHECK (match_confidence BETWEEN 0 AND 1),
      distance_m        DOUBLE PRECISION NOT NULL CHECK (distance_m >= 0),
      method            TEXT NOT NULL,
      evidence          JSONB NOT NULL,
      release           TEXT NOT NULL,
      PRIMARY KEY (osm_type, osm_id)
    );

    CREATE INDEX idx_link_gers ON "${schema}".poi_conflation_link (gers_id);

    CREATE TABLE "${schema}".poi_conflation_candidate (
      osm_type          TEXT NOT NULL,
      osm_id            BIGINT NOT NULL,
      gers_id           TEXT NOT NULL REFERENCES "${schema}".places(gers_id) ON DELETE CASCADE,
      source_confidence DOUBLE PRECISION,
      match_confidence  DOUBLE PRECISION NOT NULL CHECK (match_confidence BETWEEN 0 AND 1),
      distance_m        DOUBLE PRECISION NOT NULL CHECK (distance_m >= 0),
      method            TEXT NOT NULL,
      evidence          JSONB NOT NULL,
      release           TEXT NOT NULL,
      PRIMARY KEY (osm_type, osm_id, gers_id)
    );

    CREATE INDEX idx_candidate_osm
      ON "${schema}".poi_conflation_candidate (osm_type, osm_id);
    CREATE INDEX idx_candidate_gers
      ON "${schema}".poi_conflation_candidate (gers_id);

    -- Durable assignment workspace. Candidate scoring and exact assignment are
    -- separate retry boundaries: a failed assignment never forces another
    -- country-wide OSM extraction or candidate scan.
    CREATE UNLOGGED TABLE "${schema}".poi_conflation_component (
      osm_type          TEXT NOT NULL,
      osm_id            BIGINT NOT NULL,
      component_id      BIGINT NOT NULL,
      PRIMARY KEY (osm_type, osm_id)
    );

    CREATE INDEX idx_conflation_component
      ON "${schema}".poi_conflation_component (component_id, osm_type, osm_id);

    CREATE TABLE "${schema}".poi_conflation_link_next (
      osm_type          TEXT NOT NULL,
      osm_id            BIGINT NOT NULL,
      gers_id           TEXT NOT NULL UNIQUE,
      source_confidence DOUBLE PRECISION,
      match_confidence  DOUBLE PRECISION NOT NULL CHECK (match_confidence BETWEEN 0 AND 1),
      distance_m        DOUBLE PRECISION NOT NULL CHECK (distance_m >= 0),
      method            TEXT NOT NULL,
      evidence          JSONB NOT NULL,
      release           TEXT NOT NULL,
      PRIMARY KEY (osm_type, osm_id)
    );

    CREATE TABLE "${schema}".conflation_state (
      singleton         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
      release           TEXT NOT NULL,
      region            TEXT NOT NULL,
      place_count       BIGINT NOT NULL CHECK (place_count > 0),
      status            TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'completed', 'failed', 'waiting_for_osm')
      ),
      phase             TEXT NOT NULL DEFAULT 'extract' CHECK (
        phase IN ('extract', 'score', 'assign', 'publish', 'complete')
      ),
      attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      source_fingerprint TEXT,
      emitted_count     BIGINT,
      extracted_count   BIGINT,
      processed_count   BIGINT,
      candidate_count   BIGINT,
      component_count   BIGINT,
      assignment_cursor BIGINT,
      staged_link_count BIGINT,
      linked_count      BIGINT,
      score_cursor_h3   TEXT,
      score_cursor_type TEXT,
      score_cursor_id   BIGINT,
      phase_durations_ms JSONB NOT NULL DEFAULT '{}'::JSONB,
      last_error        TEXT,
      started_at        TIMESTAMPTZ,
      attempt_started_at TIMESTAMPTZ,
      phase_started_at  TIMESTAMPTZ,
      completed_at      TIMESTAMPTZ,
      workspace_cleaned_at TIMESTAMPTZ,
      release_files_pruned_at TIMESTAMPTZ,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  ` +
    (options.deferPlacesIndexes ? "" : buildPlacesIndexesDDL(schema)) +
    buildOsmPoisTableDDL(schema) +
    buildEmbeddingCacheDDL(schema)
  );
}

/**
 * Returns the DDL for the `osm_pois` table within a given schema.
 * The parent schema is always freshly created by `buildSchemaDDL`; there is no
 * legacy-table mutation path.
 */
export function buildOsmPoisTableDDL(schema: string): string {
  return `
    CREATE TABLE "${schema}".osm_pois (
      osm_type  TEXT NOT NULL,
      osm_id    BIGINT NOT NULL,
      name      TEXT NOT NULL DEFAULT '',
      lat       DOUBLE PRECISION NOT NULL,
      lng       DOUBLE PRECISION NOT NULL,
      h3_r8     TEXT NOT NULL,
      category  TEXT,
      tags      JSONB,
      PRIMARY KEY (osm_type, osm_id)
    );
    CREATE INDEX idx_osm_pois_category ON "${schema}".osm_pois (category);
    CREATE INDEX idx_osm_pois_h3
      ON "${schema}".osm_pois (h3_r8, osm_type, osm_id);
    CREATE INDEX idx_osm_pois_geom
      ON "${schema}".osm_pois USING GIST (ST_Point(lng, lat));
  `;
}

/**
 * Returns the DDL for the `embedding_cache` table within a given schema.
 * Stores SHA-256 hashes of `model + "\\n" + text` alongside the embedding vector.
 */
export function buildEmbeddingCacheDDL(schema: string): string {
  return `
    CREATE TABLE "${schema}".embedding_cache (
      text_hash  TEXT PRIMARY KEY,
      model      TEXT NOT NULL,
      embedding  DOUBLE PRECISION[] NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `;
}
