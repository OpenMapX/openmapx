/**
 * Overture changelog delta application.
 *
 * The S3 changelog partition path
 * (`s3://overturemaps-us-west-2/changelog/<release>/theme=places/**`) is
 * unconfirmed as of plan §7 — Overture's changelog coverage for the Places
 * theme may differ from this layout. `applyOvertureChangelog` attempts the
 * delta path via DuckDB; on any error it falls back to a full region
 * re-ingest so the monthly cron is always self-healing.
 */
import { conflateOverture } from "./conflate.js";
import { runDuckDb } from "./duckdb.js";
import { extractOsmPois } from "./extract-osm-pois.js";
import { backfillDerivedColumns, ingestOverture } from "./ingest.js";
import { assertValidRegion, pullOverture } from "./pull.js";

export function buildInsertSql(schema: string): string {
  return [
    `INSERT INTO "${schema}".places`,
    `  (gers_id, name, names, basic_category, taxonomy_primary, taxonomy_hierarchy,`,
    `   taxonomy_alternates, geom,`,
    `   h3_r8, addresses, country_code, websites, socials, emails, phones, brand,`,
    `   confidence, operating_status, sources, release)`,
    `SELECT`,
    `  id AS gers_id,`,
    `  COALESCE(names.primary, '') AS name,`,
    `  to_json(names) AS names,`,
    `  basic_category,`,
    `  taxonomy.primary AS taxonomy_primary,`,
    `  taxonomy.hierarchy AS taxonomy_hierarchy,`,
    `  taxonomy.alternates AS taxonomy_alternates,`,
    `  ST_Point(longitude, latitude) AS geom,`,
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
    `  release`,
    `FROM changelog_data`,
    `WHERE change_type = 'added'`,
    `ON CONFLICT (gers_id) DO NOTHING`,
  ].join("\n");
}

export function buildUpdateSql(schema: string): string {
  return [
    `UPDATE "${schema}".places AS p SET`,
    `  name = COALESCE(c.names.primary, ''),`,
    `  names = to_json(c.names),`,
    `  basic_category = c.basic_category,`,
    `  taxonomy_primary = c.taxonomy.primary,`,
    `  taxonomy_hierarchy = c.taxonomy.hierarchy,`,
    `  taxonomy_alternates = c.taxonomy.alternates,`,
    `  geom = ST_Point(c.longitude, c.latitude),`,
    `  addresses = to_json(c.addresses),`,
    `  country_code = c.addresses[1].country,`,
    `  websites = c.websites,`,
    `  socials = c.socials,`,
    `  emails = c.emails,`,
    `  phones = c.phones,`,
    `  brand = to_json(c.brand),`,
    `  confidence = c.confidence,`,
    `  operating_status = c.operating_status,`,
    `  sources = to_json(c.sources),`,
    `  release = c.release`,
    `FROM changelog_data AS c`,
    `WHERE c.change_type = 'data_changed'`,
    `  AND p.gers_id = c.id`,
  ].join("\n");
}

export function buildDeleteSql(schema: string): string {
  return [
    `DELETE FROM "${schema}".places AS p`,
    `USING changelog_data AS c`,
    `WHERE c.change_type = 'removed'`,
    `  AND p.gers_id = c.id`,
  ].join("\n");
}

export interface ApplyOvertureChangelogOptions {
  region: string;
  release: string;
  dataDir: string;
  onProgress?: (msg: string) => void;
  schema?: string;
}

export async function applyOvertureChangelog(opts: ApplyOvertureChangelogOptions): Promise<{
  added: number;
  updated: number;
  removed: number;
}> {
  const { region, release, dataDir, onProgress, schema = "overture_places" } = opts;
  assertValidRegion(region);
  const databaseUrl =
    process.env.DATABASE_URL || "postgresql://postgres:postgres@postgis:5432/openmapx";

  const changelogPath = `s3://overturemaps-us-west-2/changelog/${release}/theme=places/**`;

  const insertSql = buildInsertSql(schema);
  const updateSql = buildUpdateSql(schema);
  const deleteSql = buildDeleteSql(schema);

  const deltaScript = [
    "INSTALL httpfs; LOAD httpfs;",
    "INSTALL postgres; LOAD postgres;",
    "INSTALL spatial; LOAD spatial;",
    "SET s3_region='us-west-2';",
    `ATTACH '${databaseUrl}' AS pg (TYPE postgres);`,
    `WITH changelog_data AS (`,
    `  SELECT * FROM read_parquet('${changelogPath}')`,
    `)`,
    `${insertSql};`,
    `WITH changelog_data AS (`,
    `  SELECT * FROM read_parquet('${changelogPath}')`,
    `)`,
    `${updateSql};`,
    `WITH changelog_data AS (`,
    `  SELECT * FROM read_parquet('${changelogPath}')`,
    `)`,
    `${deleteSql};`,
  ].join("\n");

  const countScript = [
    "INSTALL httpfs; LOAD httpfs;",
    "SET s3_region='us-west-2';",
    `SELECT change_type, COUNT(*) AS n`,
    `FROM read_parquet('${changelogPath}')`,
    `GROUP BY change_type;`,
  ].join("\n");

  let added = 0;
  let updated = 0;
  let removed = 0;

  try {
    onProgress?.(`Counting Overture changelog rows for ${release}…`);
    const countResult = await runDuckDb(["-csv", "-c", countScript], { stdio: "pipe" });
    const stdout = typeof countResult.stdout === "string" ? countResult.stdout : "";
    for (const line of stdout.split("\n").slice(1)) {
      const parts = line.trim().split(",");
      if (parts.length < 2) continue;
      const changeType = parts[0].trim();
      const count = parseInt(parts[1].trim(), 10);
      if (changeType === "added") added = count;
      else if (changeType === "data_changed") updated = count;
      else if (changeType === "removed") removed = count;
    }
    onProgress?.(`Changelog: ${added} added, ${updated} updated, ${removed} removed.`);
  } catch {
    onProgress?.("Could not count changelog rows — proceeding with delta apply.");
  }

  try {
    onProgress?.(`Trying Overture changelog delta for ${release}…`);
    await runDuckDb(["-c", deltaScript], { stdio: "pipe" });
    onProgress?.("Backfilling derived columns for changelog rows…");
    await backfillDerivedColumns(schema);
    onProgress?.("Changelog delta applied. Extracting OSM POIs…");
    try {
      await extractOsmPois({ region, dataDir, onProgress });
    } catch {
      onProgress?.(
        `overture: OSM PBF for ${region} not found; run 'data download osm ${region}' to enable link precomputation`,
      );
    }
    onProgress?.("Running conflation…");
    const conflateResult = await conflateOverture({ region, release, schema });
    onProgress?.(`Conflation complete: ${conflateResult.linked} links.`);
    return { added, updated, removed };
  } catch (err) {
    onProgress?.(
      `Changelog path unavailable (${(err as Error).message}); falling back to full re-ingest…`,
    );
    await pullOverture({ region, dataDir, release, onProgress });
    await ingestOverture({ region, dataDir, release, onProgress });
    try {
      await extractOsmPois({ region, dataDir, onProgress });
    } catch {
      onProgress?.(
        `overture: OSM PBF for ${region} not found; run 'data download osm ${region}' to enable link precomputation`,
      );
    }
    await conflateOverture({ region, release, schema });
    onProgress?.("Full re-ingest complete.");
    // Full re-ingest replaces all rows; meaningful per-operation counts are
    // not available from this path. Return -1 as a sentinel meaning
    // "full reingest, row-level counts N/A".
    return { added: -1, updated: -1, removed: -1 };
  }
}
