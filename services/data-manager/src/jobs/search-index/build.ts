import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { StateStore } from "../../state.js";
import { extractSearchPlaces, type SearchPlaceRecord } from "./extract.js";
import { createSearchIndexOperationLock, type SearchIndexOperationLock } from "./operation-lock.js";
import { buildSearchIndexIndexesDDL, buildSearchIndexSchemaDDL } from "./schema.js";
import { fingerprintDataset, resolveOsmDataset, type SearchIndexRuntimeState } from "./state.js";

export type SearchIndexBuildStage =
  | "resolve"
  | "extract"
  | "insert"
  | "index"
  | "validate"
  | "publish"
  | "complete";

export interface SearchIndexBuildProgress {
  stage: SearchIndexBuildStage;
  message: string;
  placeCount?: number;
  termCount?: number;
}

export interface SearchIndexBuildResult {
  region: string;
  epoch: string;
  sourceFingerprint: string;
  placeCount: number;
  termCount: number;
}

interface SearchIndexCounts {
  places: number;
  terms: number;
  orphans: number;
  invalid: number;
}

export function validateSearchIndexCounts(counts: SearchIndexCounts): void {
  if (counts.places <= 0) throw new Error("search index contains no places");
  if (counts.terms <= 0) throw new Error("search index contains no terms");
  if (counts.orphans > 0) throw new Error(`search index contains ${counts.orphans} orphan terms`);
  if (counts.invalid > 0) throw new Error(`search index contains ${counts.invalid} invalid rows`);
}

interface BuildDependencies {
  extract: typeof extractSearchPlaces;
}

export function deduplicateSearchPlaces(records: SearchPlaceRecord[]): SearchPlaceRecord[] {
  const bySource = new Map<string, SearchPlaceRecord>();
  for (const record of records) {
    const terms = new Map<string, SearchPlaceRecord["terms"][number]>();
    for (const term of record.terms) {
      const primaryKey = `${term.kind}:${term.normalizedTerm}`;
      if (!terms.has(primaryKey)) terms.set(primaryKey, term);
    }
    bySource.set(`${record.osmType}:${record.osmId}`, { ...record, terms: [...terms.values()] });
  }
  return [...bySource.values()];
}

export interface BuildOsmSearchIndexOptions {
  region: string;
  dataDir: string;
  store: StateStore;
  sql: postgres.Sql;
  runtimeState: SearchIndexRuntimeState;
  operationLock?: SearchIndexOperationLock;
  onProgress?: (progress: SearchIndexBuildProgress) => void;
  onCheckpoint?: (placeCount: number) => Promise<void>;
  dependencies?: Partial<BuildDependencies>;
}

async function insertSearchPlaces(
  sql: postgres.Sql,
  records: SearchPlaceRecord[],
): Promise<{ places: number; terms: number }> {
  if (records.length === 0) return { places: 0, terms: 0 };
  records = deduplicateSearchPlaces(records);
  const osmTypes = records.map((record) => record.osmType);
  const osmIds = records.map((record) => record.osmId);
  const names = records.map((record) => record.name);
  const lats = records.map((record) => record.lat);
  const lngs = records.map((record) => record.lng);
  const categories = records.map((record) => record.category);
  const tags = records.map((record) => JSON.stringify(record.tags));
  const importance = records.map((record) => record.importance);
  await sql.unsafe(
    `INSERT INTO osm_search__staging.places
       (osm_type, osm_id, name, lat, lng, category, tags, importance)
     SELECT * FROM UNNEST($1::TEXT[], $2::BIGINT[], $3::TEXT[], $4::DOUBLE PRECISION[],
       $5::DOUBLE PRECISION[], $6::TEXT[], $7::JSONB[], $8::DOUBLE PRECISION[])
     ON CONFLICT (osm_type, osm_id) DO UPDATE SET
       name = EXCLUDED.name, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       category = EXCLUDED.category, tags = EXCLUDED.tags, importance = EXCLUDED.importance`,
    [osmTypes, osmIds, names, lats, lngs, categories, tags, importance],
  );
  const terms = records.flatMap((record) => record.terms.map((term) => ({ record, term })));
  if (terms.length > 0) {
    await sql.unsafe(
      `INSERT INTO osm_search__staging.terms
         (osm_type, osm_id, normalized_term, display_value, kind, namespace)
       SELECT * FROM UNNEST($1::TEXT[], $2::BIGINT[], $3::TEXT[], $4::TEXT[], $5::TEXT[], $6::TEXT[])
       ON CONFLICT (osm_type, osm_id, kind, normalized_term) DO UPDATE SET
         display_value = EXCLUDED.display_value, namespace = EXCLUDED.namespace`,
      [
        terms.map(({ record }) => record.osmType),
        terms.map(({ record }) => record.osmId),
        terms.map(({ term }) => term.normalizedTerm),
        terms.map(({ term }) => term.displayValue),
        terms.map(({ term }) => term.kind),
        terms.map(({ term }) => term.namespace),
      ],
    );
  }
  return { places: records.length, terms: terms.length };
}

async function noteLiveFailure(sql: postgres.Sql, message: string): Promise<void> {
  try {
    const rows = await sql.unsafe<{ exists: boolean }[]>(
      `SELECT to_regclass('osm_search.index_state') IS NOT NULL AS exists`,
    );
    if (rows[0]?.exists) {
      await sql.unsafe(
        `UPDATE osm_search.index_state SET last_error = $1, updated_at = NOW() WHERE singleton = 1`,
        [message],
      );
    }
  } catch {
    // Preserve the original build failure when failure diagnostics cannot be written.
  }
}

export async function buildOsmSearchIndex(
  opts: BuildOsmSearchIndexOptions,
): Promise<SearchIndexBuildResult> {
  const dataset = resolveOsmDataset(opts.store, opts.region);
  const lock = opts.operationLock ?? createSearchIndexOperationLock(opts.sql);
  return lock.run(async () => {
    const startedAt = new Date();
    let stage: SearchIndexBuildStage = "resolve";
    let placeCount = 0;
    let termCount = 0;
    opts.runtimeState.building = true;
    opts.runtimeState.failure = null;
    const progress = (next: SearchIndexBuildStage, message: string): void => {
      stage = next;
      opts.onProgress?.({ stage, message, placeCount, termCount });
    };
    try {
      progress("resolve", `Resolving OSM snapshot for ${opts.region}`);
      const sourceFingerprint = await fingerprintDataset(dataset);
      await opts.sql.unsafe(buildSearchIndexSchemaDDL("osm_search__staging"));
      const epoch = randomUUID();
      await opts.sql.unsafe(
        `INSERT INTO osm_search__staging.index_state
          (region, source_path, source_fingerprint, current_fingerprint, epoch, status,
           place_count, term_count, started_at, updated_at)
         VALUES ($1,$2,$3,$3,$4,'building',0,0,$5,$5)`,
        [opts.region, dataset.path, sourceFingerprint, epoch, startedAt],
      );
      progress("extract", "Streaming named OSM features");
      const extract = opts.dependencies?.extract ?? extractSearchPlaces;
      await extract({
        dataDir: opts.dataDir,
        region: opts.region,
        pbfPath: dataset.path,
        onBatch: async (records) => {
          progress("insert", `Inserting ${records.length} search places`);
          const inserted = await insertSearchPlaces(opts.sql, records);
          placeCount += inserted.places;
          termCount += inserted.terms;
          await opts.onCheckpoint?.(placeCount);
        },
      });
      progress("index", "Building exact, prefix, and proximity indexes");
      await opts.sql.unsafe(buildSearchIndexIndexesDDL("osm_search__staging"));
      progress("validate", "Validating staged search snapshot");
      const rows = await opts.sql.unsafe<
        {
          places: string;
          terms: string;
          orphans: string;
          invalid: string;
        }[]
      >(`
        SELECT
          (SELECT COUNT(*) FROM osm_search__staging.places)::TEXT AS places,
          (SELECT COUNT(*) FROM osm_search__staging.terms)::TEXT AS terms,
          (SELECT COUNT(*) FROM osm_search__staging.terms t LEFT JOIN osm_search__staging.places p
             USING (osm_type, osm_id) WHERE p.osm_id IS NULL)::TEXT AS orphans,
          ((SELECT COUNT(*) FROM osm_search__staging.places
             WHERE lat NOT BETWEEN -90 AND 90 OR lng NOT BETWEEN -180 AND 180
                OR importance NOT BETWEEN 0 AND 1) +
           (SELECT COUNT(*) FROM osm_search__staging.terms
             WHERE kind NOT IN ('authoritative_code','explicit_reference','explicit_alias','generated_acronym')
                OR (kind = 'generated_acronym' AND display_value !~ '^[[:alnum:]]{2,8}$')))::TEXT AS invalid
      `);
      const counts = {
        places: Number(rows[0]?.places ?? 0),
        terms: Number(rows[0]?.terms ?? 0),
        orphans: Number(rows[0]?.orphans ?? 0),
        invalid: Number(rows[0]?.invalid ?? 0),
      };
      validateSearchIndexCounts(counts);
      placeCount = counts.places;
      termCount = counts.terms;
      progress("publish", "Publishing the validated search snapshot");
      const live = await opts.sql.unsafe<{ exists: boolean }[]>(
        `SELECT to_regnamespace('osm_search') IS NOT NULL AS exists`,
      );
      await opts.sql.begin(async (transaction) => {
        await transaction.unsafe(
          `UPDATE osm_search__staging.index_state
              SET status='ready', place_count=$1, term_count=$2, published_at=NOW(), updated_at=NOW(), last_error=NULL
            WHERE singleton=1`,
          [placeCount, termCount],
        );
        await transaction.unsafe(`DROP SCHEMA IF EXISTS osm_search__previous CASCADE`);
        if (live[0]?.exists)
          await transaction.unsafe(`ALTER SCHEMA osm_search RENAME TO osm_search__previous`);
        await transaction.unsafe(`ALTER SCHEMA osm_search__staging RENAME TO osm_search`);
        await transaction.unsafe(`DROP SCHEMA IF EXISTS osm_search__previous CASCADE`);
      });
      progress("complete", `Published ${placeCount} places and ${termCount} terms`);
      return { region: opts.region, epoch, sourceFingerprint, placeCount, termCount };
    } catch (error) {
      const message = `[${stage}] ${(error as Error).message}`;
      try {
        await opts.sql.unsafe(`DROP SCHEMA IF EXISTS osm_search__staging CASCADE`);
      } catch {
        /* keep original error */
      }
      await noteLiveFailure(opts.sql, message);
      opts.runtimeState.failure = {
        region: opts.region,
        error: message,
        at: new Date().toISOString(),
      };
      throw new Error(message, { cause: error });
    } finally {
      opts.runtimeState.building = false;
    }
  });
}
