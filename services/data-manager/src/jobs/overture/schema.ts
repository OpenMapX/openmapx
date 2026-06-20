import { sql } from "../../db/index.js";

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
export function buildSchemaDDL(schema: string): string {
  return `
    CREATE EXTENSION IF NOT EXISTS postgis;
    DROP SCHEMA IF EXISTS "${schema}" CASCADE;
    CREATE SCHEMA "${schema}";

    CREATE TABLE "${schema}".places (
      gers_id           TEXT PRIMARY KEY,
      name              TEXT NOT NULL DEFAULT '',
      names             JSONB,
      basic_category    TEXT,
      taxonomy          TEXT[],
      openmapx_category TEXT,
      geom              GEOMETRY(POINT, 4326) NOT NULL,
      h3_r8             TEXT,
      addresses         JSONB,
      country_code      TEXT,
      websites          TEXT[],
      socials           TEXT[],
      emails            TEXT[],
      phones            TEXT[],
      brand             JSONB,
      opening_hours     TEXT,
      confidence        DOUBLE PRECISION,
      operating_status  TEXT,
      sources           JSONB,
      release           TEXT NOT NULL,
      imported_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX idx_overture_geom ON "${schema}".places USING GIST (geom);
    CREATE INDEX idx_overture_h3   ON "${schema}".places (h3_r8);
    CREATE INDEX idx_overture_cat  ON "${schema}".places (openmapx_category);

    CREATE TABLE "${schema}".poi_conflation_link (
      osm_type   TEXT NOT NULL,
      osm_id     BIGINT NOT NULL,
      gers_id    TEXT NOT NULL REFERENCES "${schema}".places(gers_id) ON DELETE CASCADE,
      confidence DOUBLE PRECISION NOT NULL,
      method     TEXT NOT NULL,
      release    TEXT NOT NULL,
      PRIMARY KEY (osm_type, osm_id, gers_id)
    );

    CREATE INDEX idx_link_gers ON "${schema}".poi_conflation_link (gers_id);
  `;
}

/**
 * Creates the overture_places schema in a staging schema, then atomically
 * swaps staging → live (readers never see a missing schema mid-import).
 * Mirrors the GTFS importer's atomic-swap pattern (importer.ts:791-800).
 *
 * This helper creates the *structure* only; data loading is handled by the
 * ingest job which shells out to DuckDB.
 */
export async function applyOvertureSchema(schema: string): Promise<void> {
  assertValidOvertureSchema(schema);

  const stagingSchema = `${schema}__staging`;
  assertValidOvertureSchema(stagingSchema);

  await sql.unsafe(buildSchemaDDL(stagingSchema));

  await sql.begin(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await tx.unsafe(`ALTER SCHEMA "${stagingSchema}" RENAME TO "${schema}"`);
  });
}

/**
 * Returns the DDL for the `osm_pois` table within a given schema.
 * `IF NOT EXISTS` guards make this idempotent — safe to call on both a fresh
 * staging schema and an existing live schema during incremental refreshes.
 */
export function buildOsmPoisTableDDL(schema: string): string {
  return `
    CREATE TABLE IF NOT EXISTS "${schema}".osm_pois (
      osm_type  TEXT NOT NULL,
      osm_id    BIGINT NOT NULL,
      name      TEXT NOT NULL DEFAULT '',
      lat       DOUBLE PRECISION NOT NULL,
      lng       DOUBLE PRECISION NOT NULL,
      category  TEXT,
      tags      JSONB,
      PRIMARY KEY (osm_type, osm_id)
    );
    CREATE INDEX IF NOT EXISTS idx_osm_pois_category ON "${schema}".osm_pois (category);
    CREATE INDEX IF NOT EXISTS idx_osm_pois_geom
      ON "${schema}".osm_pois USING GIST (ST_Point(lng, lat));
  `;
}

/**
 * Creates (or ensures) the `osm_pois` table inside the given schema.
 * The schema must already exist and pass `assertValidOvertureSchema`.
 */
export async function applyOsmPoisTable(schema: string): Promise<void> {
  assertValidOvertureSchema(schema);
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS postgis`);
  await sql.unsafe(buildOsmPoisTableDDL(schema));
}
