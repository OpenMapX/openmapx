import type postgres from "postgres";

export interface PoiFeedStateRow {
  source_id: string;
  domain: string;
  status: string;
  consecutive_failures: number | string;
  last_error: unknown;
  refresh_evidence: unknown;
}

export interface SearchPublicationRow {
  region: string;
  source_fingerprint: string | null;
  current_fingerprint: string | null;
  epoch: string | null;
  status: "building" | "ready" | "failed";
  place_count: number | string;
  term_count: number | string;
  started_at: Date | string | null;
  published_at: Date | string | null;
  updated_at: Date | string | null;
  last_error: string | null;
}

export interface OverturePublicationRow {
  release: string;
  region: string;
  place_count: number | string;
  status: string;
  places_published_at: Date | string | null;
  updated_at: Date | string | null;
}

export interface FeedStateRow {
  region: string;
  name: string;
  last_fetched_at: Date | string | null;
  last_imported_at: Date | string | null;
  hash: string | null;
  validation_status: string | null;
  validation_message: string | null;
  status: string;
}

export type CoverageSql = postgres.Sql;

async function boundedQuery<T extends object[]>(sql: CoverageSql, query: string): Promise<T> {
  const pending = sql.unsafe<T>(query);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void pending.cancel?.();
          reject(new Error("Coverage inventory query timed out"));
        }, 2500);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readPoiFeedStates(sql: CoverageSql): Promise<PoiFeedStateRow[]> {
  return boundedQuery<PoiFeedStateRow[]>(
    sql,
    `SELECT source_id, domain, status, consecutive_failures, last_error,
            refresh_evidence
       FROM data_manager.poi_feed_state
      ORDER BY source_id
      LIMIT 10000`,
  );
}

export async function readSearchPublication(
  sql: CoverageSql,
): Promise<{ exists: boolean; row: SearchPublicationRow | null }> {
  const exists = await boundedQuery<{ exists: boolean }[]>(
    sql,
    `SELECT to_regclass('osm_search.index_state') IS NOT NULL AS exists`,
  );
  if (!exists[0]?.exists) return { exists: false, row: null };
  const rows = await boundedQuery<SearchPublicationRow[]>(
    sql,
    `SELECT region, source_fingerprint, current_fingerprint, epoch, status,
            place_count, term_count, started_at, published_at, updated_at, last_error
       FROM osm_search.index_state
      WHERE singleton = 1
      LIMIT 1`,
  );
  return { exists: true, row: rows[0] ?? null };
}

export async function readOverturePublication(
  sql: CoverageSql,
): Promise<{ exists: boolean; row: OverturePublicationRow | null }> {
  const exists = await boundedQuery<{ exists: boolean }[]>(
    sql,
    `SELECT to_regclass('overture_places.conflation_state') IS NOT NULL AS exists`,
  );
  if (!exists[0]?.exists) return { exists: false, row: null };
  const rows = await boundedQuery<OverturePublicationRow[]>(
    sql,
    `SELECT release, region, place_count, status, places_published_at, updated_at
       FROM overture_places.conflation_state
      WHERE singleton = 1
       LIMIT 1`,
  );
  return { exists: true, row: rows[0] ?? null };
}

export async function readTransitFeedStates(sql: CoverageSql): Promise<FeedStateRow[]> {
  return boundedQuery<FeedStateRow[]>(
    sql,
    `SELECT region, name, last_fetched_at, last_imported_at, hash,
            validation_status, validation_message, status
       FROM data_manager.feed_state
      ORDER BY region, name
      LIMIT 10000`,
  );
}
