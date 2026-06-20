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
import { execa } from "execa";
import { conflateOverture } from "./conflate.js";
import { ingestOverture } from "./ingest.js";
import { OVERTURE_RELEASE, pullOverture } from "./pull.js";

export function buildInsertSql(schema: string): string {
  return [
    `INSERT INTO "${schema}".places`,
    `  (gers_id, name, names, basic_category, taxonomy, openmapx_category, geom,`,
    `   h3_r8, addresses, country_code, websites, socials, emails, phones, brand,`,
    `   opening_hours, confidence, operating_status, sources, release)`,
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
    `  basic_category = c.categories.primary,`,
    `  taxonomy = c.categories.alternate,`,
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

  try {
    onProgress?.(`Trying Overture changelog delta for ${release}…`);
    await execa("duckdb", ["-c", deltaScript], { stdio: "pipe" });
    onProgress?.("Changelog delta applied. Running conflation…");
    const conflateResult = await conflateOverture({ region, release, schema });
    onProgress?.(`Conflation complete: ${conflateResult.linked} links.`);
    return { added: 0, updated: 0, removed: 0 };
  } catch (err) {
    onProgress?.(
      `Changelog path unavailable (${(err as Error).message}); falling back to full re-ingest…`,
    );
    const fallbackRelease = release ?? OVERTURE_RELEASE;
    await pullOverture({ region, dataDir, release: fallbackRelease, onProgress });
    await ingestOverture({ region, dataDir, release: fallbackRelease, onProgress });
    await conflateOverture({ region, release: fallbackRelease, schema });
    onProgress?.("Full re-ingest complete.");
    return { added: 0, updated: 0, removed: 0 };
  }
}
