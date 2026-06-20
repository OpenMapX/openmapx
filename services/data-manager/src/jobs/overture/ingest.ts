import { join } from "node:path";
import { overtureCategoryToOpenMapX } from "@openmapx/core";
import { execa } from "execa";
import { latLngToCell } from "h3-js";
import { sql } from "../../db/index.js";
import { OVERTURE_RELEASE, regionSlug } from "./pull.js";
import { assertValidOvertureSchema, buildSchemaDDL } from "./schema.js";

export interface IngestOvertureOptions {
  region: string;
  dataDir: string;
  release?: string;
  onProgress?: (msg: string) => void;
}

export async function ingestOverture(opts: IngestOvertureOptions): Promise<void> {
  const release = opts.release ?? OVERTURE_RELEASE;
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
    `SELECT`,
    `  id AS gers_id,`,
    `  COALESCE(names.primary, '') AS name,`,
    `  to_json(names) AS names,`,
    `  categories.primary AS basic_category,`,
    `  categories.alternate AS taxonomy,`,
    `  NULL::TEXT AS openmapx_category,`,
    `  ST_Point(longitude, latitude) AS geom,`,
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
  await execa("duckdb", ["-c", duckSql], { stdio: "inherit" });

  opts.onProgress?.("Backfilling h3_r8...");
  const H3_BATCH = 5_000;
  while (true) {
    const h3Rows = await sql<{ gers_id: string; lat: number; lng: number }[]>`
      SELECT gers_id,
             ST_Y(geom) AS lat,
             ST_X(geom) AS lng
      FROM ${sql(stagingSchema)}.places
      WHERE h3_r8 IS NULL
      LIMIT ${H3_BATCH}
    `;
    if (h3Rows.length === 0) break;

    const gersIds = h3Rows.map((row) => row.gers_id);
    const h3Values = h3Rows.map((row) => latLngToCell(row.lat, row.lng, 8));

    await sql.unsafe(
      `UPDATE "${stagingSchema}".places AS p
       SET h3_r8 = v.h3
       FROM (SELECT UNNEST($1::TEXT[]) AS gers_id, UNNEST($2::TEXT[]) AS h3) AS v
       WHERE p.gers_id = v.gers_id`,
      [gersIds, h3Values],
    );
  }

  opts.onProgress?.("Backfilling openmapx_category...");
  const CAT_BATCH = 5_000;
  while (true) {
    const catRows = await sql<
      {
        gers_id: string;
        basic_category: string | null;
        taxonomy: string[] | null;
      }[]
    >`
      SELECT gers_id, basic_category, taxonomy
      FROM ${sql(stagingSchema)}.places
      WHERE openmapx_category IS NULL
        AND (basic_category IS NOT NULL OR taxonomy IS NOT NULL)
      LIMIT ${CAT_BATCH}
    `;
    if (catRows.length === 0) break;

    const updates: Array<{ gers_id: string; category: string }> = [];
    for (const row of catRows) {
      const candidates = [row.basic_category, ...(row.taxonomy ?? [])].filter(Boolean) as string[];
      let matched: string | undefined;
      for (const leaf of candidates) {
        matched = overtureCategoryToOpenMapX(leaf);
        if (matched) break;
      }
      if (matched) {
        updates.push({ gers_id: row.gers_id, category: matched });
      }
    }

    if (updates.length > 0) {
      await sql.unsafe(
        `UPDATE "${stagingSchema}".places AS p
         SET openmapx_category = v.category
         FROM (SELECT UNNEST($1::TEXT[]) AS gers_id, UNNEST($2::TEXT[]) AS category) AS v
         WHERE p.gers_id = v.gers_id`,
        [updates.map((u) => u.gers_id), updates.map((u) => u.category)],
      );
    } else {
      break;
    }
  }

  opts.onProgress?.("Building indexes...");
  await sql.unsafe(`CREATE INDEX ON "${stagingSchema}".places USING GIST (geom)`);
  await sql.unsafe(`CREATE INDEX ON "${stagingSchema}".places (h3_r8)`);
  await sql.unsafe(`CREATE INDEX ON "${stagingSchema}".places (openmapx_category)`);

  opts.onProgress?.("Atomic swap staging → live...");
  await sql.begin(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await tx.unsafe(`ALTER SCHEMA "${stagingSchema}" RENAME TO "${schema}"`);
  });

  opts.onProgress?.("Ingest complete.");
}
