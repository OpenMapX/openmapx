import { join } from "node:path";
import { itemAt } from "@openmapx/core/item-at";
import { assertSupportedOvertureContributors } from "@openmapx/core/places/overtureSource";
import { resolveDatabaseUrl } from "@openmapx/core/service-secret-files";
import type postgres from "postgres";
import {
  type LockRetry,
  PUBLICATION_LOCK_RETRY,
  previousName,
  publishSchemaSwap,
} from "../publish-schema-swap.js";
import { assertOverturePostgresCapacity, estimateOvertureIngestBytes } from "./capacity.js";
import { duckDbSqlLiteral, runDuckDbScript } from "./duckdb.js";
import { validateOvertureQuality } from "./eval/quality-gate.js";
import { inspectOvertureLocalInputs } from "./local-inputs.js";
import { regionSlug, resolveOvertureRelease } from "./pull.js";
import { assertValidOvertureSchema, buildPlacesIndexesDDL, buildSchemaDDL } from "./schema.js";
import { readOverturePullContract } from "./stac.js";

export interface IngestOvertureOptions {
  sql: postgres.Sql;
  region: string;
  dataDir: string;
  release?: string;
  onProgress?: (msg: string) => void;
}

/**
 * Builds the single-pass DuckDB → PostGIS ingest SQL. Geometry CRS is validated
 * against OGC:CRS84 before relabeling to EPSG:4326 so PostGIS receives typed
 * `geometry(Point, 4326)` and `h3_r8` directly without post-load table rewrites.
 */
export function buildOvertureIngestSql(opts: {
  databaseUrl: string;
  stagingSchema: string;
  parquetPath: string;
  release: string;
}): string {
  assertValidOvertureSchema(opts.stagingSchema);
  return [
    "LOAD postgres;",
    "LOAD spatial;",
    "LOAD h3;",
    `ATTACH ${duckDbSqlLiteral(opts.databaseUrl)} AS pg (TYPE postgres);`,
    `INSERT INTO pg."${opts.stagingSchema}".places`,
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
    // Overture GeoParquet carries GEOMETRY('OGC:CRS84'), which shares WGS 84
    // (lon, lat) axis order with PostGIS SRID 4326. Cast to OGC:CRS84 first so
    // an unexpected CRS fails at bind time before ST_SetCRS relabels it to
    // EPSG:4326 for the typed PostGIS geometry(Point, 4326) column.
    `  ST_SetCRS(geometry::GEOMETRY('OGC:CRS84'), 'EPSG:4326') AS geom,`,
    // h3_latlng_to_cell returns a UBIGINT. A valid cell's top bit is reserved
    // and always 0, so it is below 2^63 and the cast to the bigint column
    // cannot overflow; an out-of-range value would fail the cast loudly.
    `  CAST(h3_latlng_to_cell(ST_Y(geometry), ST_X(geometry), 8) AS BIGINT) AS h3_r8,`,
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
    `  ${duckDbSqlLiteral(opts.release)}::TEXT AS release`,
    `FROM read_parquet(${duckDbSqlLiteral(opts.parquetPath)});`,
  ].join("\n");
}

/**
 * Verifies that every contributor in the staged release has an explicit
 * OpenMapX attribution entry. This must run before the atomic schema swap.
 */
export async function validateOvertureContributors(
  sql: postgres.Sql,
  schema: string,
): Promise<string[]> {
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
 * Activates a fully validated Places schema without making readers wait.
 * When a live schema is present, its release-independent OSM snapshot moves
 * into the new live schema and its extraction fingerprint is carried forward.
 * Moving the table is a catalog operation; no country-scale OSM table copy is
 * performed, but it waits for the snapshot's readers, at most a second per
 * attempt.
 */
export async function activateOvertureStagingSchema(
  sql: postgres.Sql,
  schema: string,
  stagingSchema: string,
  placesPublishedAt: string,
  retry: LockRetry = PUBLICATION_LOCK_RETRY,
): Promise<void> {
  assertValidOvertureSchema(schema);
  assertValidOvertureSchema(stagingSchema);
  assertValidOvertureSchema(previousName(schema));
  await publishSchemaSwap(sql, {
    live: schema,
    staging: stagingSchema,
    retry,
    carryOver: async (tx, previous) => {
      const [existingOsmSnapshot] = previous
        ? await tx.unsafe<{ exists: boolean }[]>(`SELECT to_regclass($1) IS NOT NULL AS exists`, [
            `"${previous}".osm_pois`,
          ])
        : [];
      if (previous && existingOsmSnapshot?.exists) {
        // `rebuildOvertureLinks` verifies this fingerprint against the current
        // on-disk PBF before reuse and restarts extraction if it changed.
        await tx.unsafe(`DROP TABLE "${schema}".osm_pois CASCADE`);
        await tx.unsafe(`ALTER TABLE "${previous}".osm_pois SET SCHEMA "${schema}"`);
        await tx.unsafe(
          `UPDATE "${schema}".conflation_state AS target
         SET phase = 'score', source_fingerprint = source.source_fingerprint,
             emitted_count = source.emitted_count, extracted_count = source.extracted_count,
             processed_count = 0, candidate_count = 0,
             score_cursor_h3 = NULL, score_cursor_type = '', score_cursor_id = 0
         FROM "${previous}".conflation_state AS source
         WHERE target.singleton = 1 AND source.singleton = 1
           AND source.region = target.region
           AND source.source_fingerprint IS NOT NULL
           AND source.extracted_count IS NOT NULL`,
        );
      }
      await tx.unsafe(
        `UPDATE "${schema}".conflation_state
       SET places_published_at = $1
       WHERE singleton = 1`,
        [placesPublishedAt],
      );
    },
  });
}

export async function ingestOverture(opts: IngestOvertureOptions): Promise<void> {
  const { sql } = opts;
  const local = opts.release ? null : inspectOvertureLocalInputs(opts.dataDir, opts.region);
  if (local?.catalogueRefusal) throw Error(local.catalogueRefusal);
  const localRelease = opts.release ?? local?.downloadedRelease;
  if (!localRelease)
    throw Error(
      "Download a completed local Overture partition for this region before ingesting it.",
    );
  const release = await resolveOvertureRelease(localRelease);
  const slug = regionSlug(opts.region);
  const parquetPath = join(opts.dataDir, "overture", release, `${slug}.parquet`);
  const schema = "overture_places";
  const stagingSchema = `${schema}__staging`;

  assertValidOvertureSchema(schema);
  assertValidOvertureSchema(stagingSchema);

  opts.onProgress?.("Verifying Overture STAC pull contract...");
  const pullContract = readOverturePullContract(opts.dataDir, release, opts.region);

  await assertOverturePostgresCapacity({
    sql,
    schema,
    stage: "PostGIS staging ingest",
    workingBytes: (activeSchemaBytes) =>
      estimateOvertureIngestBytes(pullContract.rowCount, activeSchemaBytes),
  });

  const databaseUrl = resolveDatabaseUrl(
    "postgresql://postgres:postgres@openmapx-postgis:5432/openmapx",
  );

  opts.onProgress?.("Creating staging schema...");
  await sql.unsafe(buildSchemaDDL(stagingSchema, { deferPlacesIndexes: true }));

  const duckSql = buildOvertureIngestSql({
    databaseUrl,
    stagingSchema,
    parquetPath,
    release,
  });

  opts.onProgress?.("Running DuckDB → PostGIS ingest...");
  await runDuckDbScript(duckSql);

  opts.onProgress?.("Building Overture Places indexes after bulk load...");
  await sql.unsafe(buildPlacesIndexesDDL(stagingSchema));
  await sql.unsafe(`ANALYZE "${stagingSchema}".places`);

  opts.onProgress?.("Validating contributor attribution coverage...");
  const contributors = await validateOvertureContributors(sql, stagingSchema);
  if (contributors.join("\0") !== pullContract.contributors.join("\0")) {
    throw new Error("Ingested Overture contributors do not match the pull contract");
  }
  const { count } = itemAt(
    await sql.unsafe<{ count: number }[]>(
      `SELECT COUNT(*)::INTEGER AS count FROM "${stagingSchema}".places`,
      [],
    ),
    0,
    "row from the ingested Overture row count query",
  );
  if (count !== pullContract.rowCount) {
    throw new Error(
      `Ingested Overture row count ${count} does not match pull contract ${pullContract.rowCount}`,
    );
  }

  opts.onProgress?.("Running labeled regional quality regression gate...");
  const quality = await validateOvertureQuality(sql, stagingSchema, opts.region);
  opts.onProgress?.(`Quality gate passed (${quality.applicableCases} applicable cases).`);

  await sql.unsafe(
    `INSERT INTO "${stagingSchema}".conflation_state
       (release, region, place_count, status, sources_catalogue)
     VALUES ($1, $2, $3, 'pending', $4::TEXT::JSONB)`,
    [release, opts.region, count, JSON.stringify(pullContract.sourcesCatalogue)],
  );

  opts.onProgress?.("Atomic swap staging → live...");
  await activateOvertureStagingSchema(sql, schema, stagingSchema, new Date().toISOString());

  opts.onProgress?.("Ingest complete.");
}
