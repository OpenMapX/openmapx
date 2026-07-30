import { statSync } from "node:fs";
import { join } from "node:path";
import { assertSupportedOvertureContributors } from "@openmapx/core/utils/overtureSource";
import { latLngToCell } from "h3-js";
import { sql } from "../../db/index.js";
import { assertOverturePostgresCapacity, estimateOvertureIngestBytes } from "./capacity.js";
import { duckDbSqlLiteral, runDuckDbScript } from "./duckdb.js";
import { validateOvertureQuality } from "./eval/quality-gate.js";
import { regionSlug, resolveOvertureRelease } from "./pull.js";
import { assertValidOvertureSchema, buildPlacesIndexesDDL, buildSchemaDDL } from "./schema.js";
import { readOverturePullContract } from "./stac.js";

/**
 * Backfills the local H3 acceleration column. Category hierarchy and
 * generalisation come directly from Overture and are never materialised into
 * an OpenMapX-owned taxonomy.
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
}

export interface IngestOvertureOptions {
  region: string;
  dataDir: string;
  release?: string;
  onProgress?: (msg: string) => void;
}

/**
 * Verifies that every contributor in the staged release has an explicit
 * OpenMapX attribution entry. This must run before the atomic schema swap.
 */
export async function validateOvertureContributors(schema: string): Promise<string[]> {
  assertValidOvertureSchema(schema);
  const rows = await sql.unsafe<{ dataset: string }[]>(
    `SELECT DISTINCT source->>'dataset' AS dataset
     FROM "${schema}".places AS place
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(place.sources) = 'array' THEN place.sources ELSE '[]'::jsonb END
     ) AS source
     WHERE NULLIF(BTRIM(source->>'dataset'), '') IS NOT NULL
     ORDER BY dataset`,
    [],
  );
  // PostgreSQL ORDER BY follows the database collation, while pull contracts
  // are canonicalized with JavaScript's code-point sort. Normalize here too so
  // activation compares contributor sets deterministically across locales.
  const datasets = rows.map((row) => row.dataset).sort();
  assertSupportedOvertureContributors(datasets);
  return datasets;
}

/**
 * Atomically activates a fully validated Places schema. When a live schema is
 * present, its release-independent OSM snapshot is moved into the staging
 * schema and its extraction fingerprint is carried forward. This is an O(1)
 * catalog operation; no country-scale OSM table copy is performed.
 */
export async function activateOvertureStagingSchema(
  schema: string,
  stagingSchema: string,
): Promise<void> {
  assertValidOvertureSchema(schema);
  assertValidOvertureSchema(stagingSchema);
  const [existingOsmSnapshot] = await sql.unsafe<{ exists: boolean }[]>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`${schema}.osm_pois`],
  );
  await sql.begin(async (tx) => {
    if (existingOsmSnapshot?.exists) {
      // `rebuildOvertureLinks` verifies this fingerprint against the current
      // on-disk PBF before reuse and restarts extraction if it changed.
      await tx.unsafe(`DROP TABLE "${stagingSchema}".osm_pois CASCADE`);
      await tx.unsafe(`ALTER TABLE "${schema}".osm_pois SET SCHEMA "${stagingSchema}"`);
      await tx.unsafe(
        `UPDATE "${stagingSchema}".conflation_state AS target
         SET phase = 'score', source_fingerprint = source.source_fingerprint,
             emitted_count = source.emitted_count, extracted_count = source.extracted_count,
             processed_count = 0, candidate_count = 0,
             score_cursor_h3 = NULL, score_cursor_type = '', score_cursor_id = 0
         FROM "${schema}".conflation_state AS source
         WHERE target.singleton = 1 AND source.singleton = 1
           AND source.region = target.region
           AND source.source_fingerprint IS NOT NULL
           AND source.extracted_count IS NOT NULL`,
      );
    }
    await tx.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await tx.unsafe(`ALTER SCHEMA "${stagingSchema}" RENAME TO "${schema}"`);
  });
}

export async function ingestOverture(opts: IngestOvertureOptions): Promise<void> {
  const release = await resolveOvertureRelease(opts.release);
  const slug = regionSlug(opts.region);
  const parquetPath = join(opts.dataDir, "overture", release, `${slug}.parquet`);
  const schema = "overture_places";
  const stagingSchema = `${schema}__staging`;

  assertValidOvertureSchema(schema);
  assertValidOvertureSchema(stagingSchema);

  opts.onProgress?.("Verifying Overture STAC pull contract...");
  const pullContract = readOverturePullContract(opts.dataDir, release, opts.region);

  await assertOverturePostgresCapacity({
    schema,
    stage: "PostGIS staging ingest",
    workingBytes: (activeSchemaBytes) =>
      estimateOvertureIngestBytes(statSync(parquetPath).size, activeSchemaBytes),
  });

  const databaseUrl =
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@postgis:5432/openmapx";

  opts.onProgress?.("Creating staging schema...");
  await sql.unsafe(buildSchemaDDL(stagingSchema, { deferPlacesIndexes: true }));

  const duckSql = [
    "INSTALL postgres; LOAD postgres;",
    "INSTALL spatial; LOAD spatial;",
    `ATTACH ${duckDbSqlLiteral(databaseUrl)} AS pg (TYPE postgres);`,
    `INSERT INTO pg."${stagingSchema}".places`,
    `  (gers_id, name, names, basic_category, taxonomy_primary, taxonomy_hierarchy,`,
    `   taxonomy_alternates, geom, h3_r8,`,
    `   addresses, country_code, websites, socials, emails, phones, brand,`,
    `   confidence, operating_status, sources, release)`,
    `SELECT`,
    `  id AS gers_id,`,
    `  COALESCE(names.primary, '') AS name,`,
    `  to_json(names) AS names,`,
    `  basic_category,`,
    `  taxonomy.primary AS taxonomy_primary,`,
    `  taxonomy.hierarchy AS taxonomy_hierarchy,`,
    `  taxonomy.alternates AS taxonomy_alternates,`,
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
    `  confidence,`,
    `  operating_status,`,
    `  to_json(sources) AS sources,`,
    `  ${duckDbSqlLiteral(release)}::TEXT AS release`,
    `FROM read_parquet(${duckDbSqlLiteral(parquetPath)});`,
  ].join("\n");

  opts.onProgress?.("Running DuckDB → PostGIS ingest...");
  await runDuckDbScript(duckSql);

  opts.onProgress?.("Stamping geometry SRID 4326...");
  await sql.unsafe(
    `ALTER TABLE "${stagingSchema}".places
       ALTER COLUMN geom TYPE geometry(Point, 4326) USING ST_SetSRID(geom, 4326)`,
  );

  opts.onProgress?.("Backfilling h3_r8...");
  await backfillDerivedColumns(stagingSchema);
  await sql.unsafe(`ALTER TABLE "${stagingSchema}".places ALTER COLUMN h3_r8 SET NOT NULL`);

  opts.onProgress?.("Building Overture Places indexes after bulk load...");
  await sql.unsafe(buildPlacesIndexesDDL(stagingSchema));
  await sql.unsafe(`ANALYZE "${stagingSchema}".places`);

  opts.onProgress?.("Validating contributor attribution coverage...");
  const contributors = await validateOvertureContributors(stagingSchema);
  if (contributors.join("\0") !== pullContract.contributors.join("\0")) {
    throw new Error("Ingested Overture contributors do not match the pull contract");
  }
  const [{ count }] = await sql.unsafe<{ count: number }[]>(
    `SELECT COUNT(*)::INTEGER AS count FROM "${stagingSchema}".places`,
    [],
  );
  if (count !== pullContract.rowCount) {
    throw new Error(
      `Ingested Overture row count ${count} does not match pull contract ${pullContract.rowCount}`,
    );
  }

  opts.onProgress?.("Running labeled regional quality regression gate...");
  const quality = await validateOvertureQuality(stagingSchema, opts.region);
  opts.onProgress?.(`Quality gate passed (${quality.applicableCases} applicable cases).`);

  await sql.unsafe(
    `INSERT INTO "${stagingSchema}".conflation_state
       (release, region, place_count, status)
     VALUES ($1, $2, $3, 'pending')`,
    [release, opts.region, count],
  );

  opts.onProgress?.("Atomic swap staging → live...");
  await activateOvertureStagingSchema(schema, stagingSchema);

  opts.onProgress?.("Ingest complete.");
}
