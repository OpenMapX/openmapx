import { join } from "node:path";
import { overtureCategoryToOpenMapX } from "@openmapx/core/utils/overtureCategoryMap";
import { latLngToCell } from "h3-js";
import { sql } from "../../db/index.js";
import { runDuckDb } from "./duckdb.js";
import { regionSlug, resolveOvertureRelease } from "./pull.js";
import { assertValidOvertureSchema, buildSchemaDDL } from "./schema.js";

/**
 * Backfills `h3_r8` and `openmapx_category` columns in the given schema for
 * any rows that are missing them. Called after ingest and after changelog delta
 * apply so both paths produce fully-populated derived columns.
 */
export async function backfillDerivedColumns(schema: string): Promise<void> {
  assertValidOvertureSchema(schema);

  const H3_BATCH = 5_000;
  while (true) {
    const h3Rows = await sql<{ gers_id: string; lat: number; lng: number }[]>`
      SELECT gers_id,
             ST_Y(geom) AS lat,
             ST_X(geom) AS lng
      FROM ${sql(schema)}.places
      WHERE h3_r8 IS NULL
      LIMIT ${H3_BATCH}
    `;
    if (h3Rows.length === 0) break;

    const gersIds = h3Rows.map((row) => row.gers_id);
    const h3Values = h3Rows.map((row) => latLngToCell(row.lat, row.lng, 8));

    await sql.unsafe(
      `UPDATE "${schema}".places AS p
       SET h3_r8 = v.h3
       FROM (SELECT UNNEST($1::TEXT[]) AS gers_id, UNNEST($2::TEXT[]) AS h3) AS v
       WHERE p.gers_id = v.gers_id`,
      [gersIds, h3Values],
    );
  }

  const catRows = await sql<
    {
      gers_id: string;
      basic_category: string | null;
      taxonomy: string[] | null;
    }[]
  >`
    SELECT gers_id, basic_category, taxonomy
    FROM ${sql(schema)}.places
    WHERE openmapx_category IS NULL
      AND (basic_category IS NOT NULL OR taxonomy IS NOT NULL)
  `;

  const updates: Array<{ gers_id: string; category: string }> = [];
  for (const row of catRows) {
    const candidates = [row.basic_category, ...(row.taxonomy ?? [])].filter(Boolean) as string[];
    for (const leaf of candidates) {
      const matched = overtureCategoryToOpenMapX(leaf);
      if (matched) {
        updates.push({ gers_id: row.gers_id, category: matched });
        break;
      }
    }
  }

  const CAT_BATCH = 5_000;
  for (let i = 0; i < updates.length; i += CAT_BATCH) {
    const chunk = updates.slice(i, i + CAT_BATCH);
    await sql.unsafe(
      `UPDATE "${schema}".places AS p
       SET openmapx_category = v.category
       FROM (SELECT UNNEST($1::TEXT[]) AS gers_id, UNNEST($2::TEXT[]) AS category) AS v
       WHERE p.gers_id = v.gers_id`,
      [chunk.map((u) => u.gers_id), chunk.map((u) => u.category)],
    );
  }
}

export interface IngestOvertureOptions {
  region: string;
  dataDir: string;
  release?: string;
  onProgress?: (msg: string) => void;
}

export async function ingestOverture(opts: IngestOvertureOptions): Promise<void> {
  const release = await resolveOvertureRelease(opts.release);
  const slug = regionSlug(opts.region);
  const parquetPath = join(opts.dataDir, "overture", release, `${slug}.parquet`);
  const schema = "overture_places";
  const stagingSchema = `${schema}__staging`;

  assertValidOvertureSchema(schema);
  assertValidOvertureSchema(stagingSchema);

  const databaseUrl =
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@postgis:5432/openmapx";

  opts.onProgress?.("Creating staging schema...");
  await sql.unsafe(buildSchemaDDL(stagingSchema));

  const duckSql = [
    "INSTALL postgres; LOAD postgres;",
    "INSTALL spatial; LOAD spatial;",
    `ATTACH '${databaseUrl}' AS pg (TYPE postgres);`,
    `INSERT INTO pg."${stagingSchema}".places`,
    `  (gers_id, name, names, basic_category, taxonomy, openmapx_category, geom, h3_r8,`,
    `   addresses, country_code, websites, socials, emails, phones, brand, opening_hours,`,
    `   confidence, operating_status, sources, release)`,
    `SELECT`,
    `  id AS gers_id,`,
    `  COALESCE(names.primary, '') AS name,`,
    `  to_json(names) AS names,`,
    `  categories.primary AS basic_category,`,
    `  categories.alternate AS taxonomy,`,
    `  NULL::TEXT AS openmapx_category,`,
    // Overture GeoParquet exposes a single `geometry` (WKB) column, not
    // longitude/latitude. Emit it as hex-WKB so the Postgres COPY parses it
    // into the geometry column (a raw binary transfer is rejected); DuckDB
    // carries no SRID, so the ALTER below stamps SRID 4326 + the POINT typmod
    // Postgres-side before the swap.
    `  ST_AsHEXWKB(geometry) AS geom,`,
    `  NULL::TEXT AS h3_r8,`,
    `  to_json(addresses) AS addresses,`,
    `  addresses[1].country AS country_code,`,
    `  websites,`,
    `  socials,`,
    `  emails,`,
    `  phones,`,
    `  to_json(brand) AS brand,`,
    `  NULL::TEXT AS opening_hours,`,
    `  confidence,`,
    `  operating_status,`,
    `  to_json(sources) AS sources,`,
    `  '${release}'::TEXT AS release`,
    `FROM read_parquet('${parquetPath}');`,
  ].join("\n");

  opts.onProgress?.("Running DuckDB → PostGIS ingest...");
  await runDuckDb(["-c", duckSql], { stdio: "inherit" });

  opts.onProgress?.("Stamping geometry SRID 4326...");
  await sql.unsafe(
    `ALTER TABLE "${stagingSchema}".places
       ALTER COLUMN geom TYPE geometry(Point, 4326) USING ST_SetSRID(geom, 4326)`,
  );

  opts.onProgress?.("Backfilling h3_r8 and openmapx_category...");
  await backfillDerivedColumns(stagingSchema);

  // Indexes (geom GIST + h3 + openmapx_category btree) are created by
  // buildSchemaDDL; the geom GIST is rebuilt automatically by the SRID ALTER.

  opts.onProgress?.("Atomic swap staging → live...");
  await sql.begin(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await tx.unsafe(`ALTER SCHEMA "${stagingSchema}" RENAME TO "${schema}"`);
  });

  opts.onProgress?.("Ingest complete.");
}
