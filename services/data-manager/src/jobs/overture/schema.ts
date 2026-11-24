import { buildPublicationFenceDDL } from "../publication-fence.js";

/**
 * Schema names that carry ODbL-licensed Overture themes (Buildings,
 * Transportation, Divisions, Base). The name pattern already refuses them;
 * they get their own message because touching one would break the
 * CDLA-Permissive ↔ ODbL license isolation, not just name the wrong schema.
 */
const ODBL_BLOCKED_SCHEMAS = new Set([
  "overture_buildings",
  "overture_transportation",
  "overture_divisions",
  "overture_base",
]);

/**
 * The Places schema, its staging schema and the one a publication retires.
 * The database guard (`services/postgis/scripts/sync-password.sh`) allows
 * data-manager to create exactly these Overture names, so the license
 * isolation holds in the database as well as here. The name is interpolated
 * into DDL identifiers (`"${schema}".places`), so nothing else may pass.
 */
const OVERTURE_SCHEMA_RE = /^overture_places(__staging|__previous)?$/;

export function assertValidOvertureSchema(name: string): void {
  if (ODBL_BLOCKED_SCHEMAS.has(name)) {
    throw new Error(
      `Schema "${name}" is an ODbL-licensed Overture theme (Buildings/Transportation/Divisions/Base). ` +
        `The overture_places code path must not access it — CDLA↔ODbL isolation violation.`,
    );
  }
  if (!OVERTURE_SCHEMA_RE.test(name)) {
    throw new Error(
      `Invalid Overture schema name "${name}": must be overture_places, ` +
        `overture_places__staging or overture_places__previous`,
    );
  }
}

/**
 * Returns the raw SQL DDL string for the overture_places schema and its tables.
 * All columns follow design §5. Notable choices:
 *   - h3_r8 is BIGINT: the top bit of an H3 cell index is reserved and always
 *     0, so every valid cell fits a signed bigint (8 bytes, compared as an
 *     integer instead of through a text collation). See `./h3.ts`.
 *   - geom is GEOMETRY(POINT,4326) (not geography) for lower-cost bbox/&& ops.
 */
export interface BuildOvertureSchemaOptions {
  /** Bulk ingest maintains these more cheaply when they are built after load. */
  deferPlacesIndexes?: boolean;
}

export function buildPlacesIndexesDDL(schema: string): string {
  assertValidOvertureSchema(schema);
  return `
    CREATE INDEX places_geom_idx ON "${schema}".places USING GIST (geom);
    CREATE INDEX places_h3_r8_idx ON "${schema}".places (h3_r8);
    CREATE INDEX places_basic_category_idx ON "${schema}".places (basic_category);
    CREATE INDEX places_taxonomy_primary_idx ON "${schema}".places (taxonomy_primary);
    CREATE INDEX places_taxonomy_hierarchy_idx
      ON "${schema}".places USING GIN (taxonomy_hierarchy);
    CREATE INDEX places_taxonomy_alternates_idx
      ON "${schema}".places USING GIN (taxonomy_alternates);
  `;
}

export function buildSchemaDDL(schema: string, options: BuildOvertureSchemaOptions = {}): string {
  assertValidOvertureSchema(schema);
  return (
    `
    DROP SCHEMA IF EXISTS "${schema}" CASCADE;
    CREATE SCHEMA "${schema}";
    ${buildPublicationFenceDDL(schema)}

    CREATE TABLE "${schema}".places (
      gers_id           TEXT CONSTRAINT places_pkey PRIMARY KEY,
      name              TEXT NOT NULL DEFAULT '',
      names             JSONB,
      basic_category    TEXT,
      taxonomy_primary  TEXT,
      taxonomy_hierarchy TEXT[],
      taxonomy_alternates TEXT[],
      geom              GEOMETRY(Point, 4326) NOT NULL,
      h3_r8             BIGINT NOT NULL,
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

    ${buildConflationLinkTableDDL(schema, "poi_conflation_link")}

    CREATE TABLE "${schema}".poi_conflation_candidate (
      osm_type          TEXT NOT NULL,
      osm_id            BIGINT NOT NULL,
      gers_id           TEXT NOT NULL,
      source_confidence DOUBLE PRECISION,
      match_confidence  DOUBLE PRECISION NOT NULL
        CONSTRAINT poi_conflation_candidate_match_confidence_check
        CHECK (match_confidence BETWEEN 0 AND 1),
      distance_m        DOUBLE PRECISION NOT NULL
        CONSTRAINT poi_conflation_candidate_distance_m_check CHECK (distance_m >= 0),
      method            TEXT NOT NULL,
      evidence          JSONB NOT NULL,
      release           TEXT NOT NULL,
      CONSTRAINT poi_conflation_candidate_pkey PRIMARY KEY (osm_type, osm_id, gers_id),
      CONSTRAINT poi_conflation_candidate_gers_id_fkey FOREIGN KEY (gers_id)
        REFERENCES "${schema}".places (gers_id) ON DELETE CASCADE
    );

    -- The primary key serves lookups by (osm_type, osm_id).
    CREATE INDEX poi_conflation_candidate_gers_id_idx
      ON "${schema}".poi_conflation_candidate (gers_id);

    -- Durable assignment workspace. Candidate scoring and exact assignment are
    -- separate retry boundaries: a failed assignment never forces another
    -- country-wide OSM extraction or candidate scan.
    CREATE UNLOGGED TABLE "${schema}".poi_conflation_component (
      osm_type          TEXT NOT NULL,
      osm_id            BIGINT NOT NULL,
      component_id      BIGINT NOT NULL,
      CONSTRAINT poi_conflation_component_pkey PRIMARY KEY (osm_type, osm_id)
    );

    CREATE INDEX poi_conflation_component_component_id_osm_type_osm_id_idx
      ON "${schema}".poi_conflation_component (component_id, osm_type, osm_id);

    -- The next link snapshot; publication swaps it in by renaming.
    ${buildConflationLinkTableDDL(schema, "poi_conflation_link_next")}

    CREATE TABLE "${schema}".conflation_state (
      singleton         SMALLINT DEFAULT 1
        CONSTRAINT conflation_state_singleton_check CHECK (singleton = 1),
      release           TEXT NOT NULL,
      region            TEXT NOT NULL,
      place_count       BIGINT NOT NULL
        CONSTRAINT conflation_state_place_count_check CHECK (place_count > 0),
      sources_catalogue JSONB NOT NULL CONSTRAINT conflation_state_sources_catalogue_check
        CHECK (jsonb_typeof(sources_catalogue) = 'array'),
      places_published_at TIMESTAMPTZ,
      status            TEXT NOT NULL CONSTRAINT conflation_state_status_check CHECK (
        status IN ('pending', 'running', 'completed', 'failed', 'waiting_for_osm')
      ),
      phase             TEXT NOT NULL DEFAULT 'extract' CONSTRAINT conflation_state_phase_check CHECK (
        phase IN ('extract', 'score', 'assign', 'publish', 'complete')
      ),
      attempt_count     INTEGER NOT NULL DEFAULT 0
        CONSTRAINT conflation_state_attempt_count_check CHECK (attempt_count >= 0),
      source_fingerprint TEXT,
      emitted_count     BIGINT,
      extracted_count   BIGINT,
      processed_count   BIGINT,
      candidate_count   BIGINT,
      component_count   BIGINT,
      assignment_cursor BIGINT,
      staged_link_count BIGINT,
      linked_count      BIGINT,
      score_cursor_h3   BIGINT,
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
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT conflation_state_pkey PRIMARY KEY (singleton)
    );
  ` +
    (options.deferPlacesIndexes ? "" : buildPlacesIndexesDDL(schema)) +
    buildOsmPoisTableDDL(schema, "osm_pois") +
    buildOsmPoisIndexesDDL(schema, "osm_pois")
  );
}

export type ConflationLinkTable = "poi_conflation_link" | "poi_conflation_link_next";

/**
 * The published links and the next snapshot share one definition, so that
 * publication can swap them by renaming. Constraint names follow the table
 * name, which the swap relies on. There is no foreign key to `places`:
 * dropping a table that has one locks `places` against its readers, which
 * every link publication would then have to wait for. Links come from
 * candidates, which do reference `places`, and a release's places are never
 * deleted on their own: the whole schema is replaced together.
 */
export function buildConflationLinkTableDDL(schema: string, table: ConflationLinkTable): string {
  assertValidOvertureSchema(schema);
  return `
    CREATE TABLE "${schema}"."${table}" (
      osm_type          TEXT NOT NULL,
      osm_id            BIGINT NOT NULL,
      gers_id           TEXT NOT NULL,
      source_confidence DOUBLE PRECISION,
      match_confidence  DOUBLE PRECISION NOT NULL,
      distance_m        DOUBLE PRECISION NOT NULL,
      method            TEXT NOT NULL,
      evidence          JSONB NOT NULL,
      release           TEXT NOT NULL,
      CONSTRAINT "${table}_pkey" PRIMARY KEY (osm_type, osm_id),
      CONSTRAINT "${table}_gers_id_key" UNIQUE (gers_id),
      CONSTRAINT "${table}_match_confidence_check" CHECK (match_confidence BETWEEN 0 AND 1),
      CONSTRAINT "${table}_distance_m_check" CHECK (distance_m >= 0)
    );
  `;
}

export type OsmPoisTable = "osm_pois" | "osm_pois__staging";

/**
 * Indexes of the OSM POI snapshot, named after the table they are built on:
 * the staging table is indexed before publication renames it and them.
 */
export function buildOsmPoisIndexesDDL(schema: string, table: OsmPoisTable): string {
  assertValidOvertureSchema(schema);
  return `
    CREATE INDEX "${table}_category_idx" ON "${schema}"."${table}" (category);
    CREATE INDEX "${table}_h3_r8_osm_type_osm_id_idx"
      ON "${schema}"."${table}" (h3_r8, osm_type, osm_id);
    CREATE INDEX "${table}_geom_idx" ON "${schema}"."${table}" USING GIST (geom);
  `;
}

/**
 * Returns the DDL for an OSM POI snapshot table, without its indexes. The live
 * table and the staging table that extraction fills share this definition, and
 * their constraint names follow the table name, which the swap relies on.
 */
export function buildOsmPoisTableDDL(schema: string, table: OsmPoisTable): string {
  assertValidOvertureSchema(schema);
  return `
    CREATE TABLE "${schema}"."${table}" (
      osm_type  TEXT NOT NULL,
      osm_id    BIGINT NOT NULL,
      name      TEXT NOT NULL DEFAULT '',
      geom      GEOMETRY(Point, 4326) NOT NULL,
      h3_r8     BIGINT NOT NULL,
      category  TEXT,
      tags      JSONB,
      CONSTRAINT "${table}_pkey" PRIMARY KEY (osm_type, osm_id),
      CONSTRAINT "${table}_geom_check"
        CHECK (ST_X(geom) BETWEEN -180 AND 180 AND ST_Y(geom) BETWEEN -90 AND 90)
    );
  `;
}

/**
 * The embedding cache's own schema. No publication swaps or drops it, because
 * its key, the SHA-256 of `model + "\n" + text`, does not depend on the
 * release. The database guard allows data-manager to create this name.
 */
export const EMBEDDING_CACHE_SCHEMA = "overture_embeddings";

/**
 * Returns the DDL that creates the embedding cache unless it exists. Vectors
 * are `real[]`: half the size of `double precision[]`, and cosine similarity
 * between them moves by less than a millionth.
 */
export function buildEmbeddingCacheDDL(): string {
  return `
    CREATE SCHEMA IF NOT EXISTS ${EMBEDDING_CACHE_SCHEMA};
    CREATE TABLE IF NOT EXISTS ${EMBEDDING_CACHE_SCHEMA}.embedding_cache (
      text_hash  TEXT CONSTRAINT embedding_cache_pkey PRIMARY KEY,
      model      TEXT NOT NULL,
      embedding  REAL[] NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
}
