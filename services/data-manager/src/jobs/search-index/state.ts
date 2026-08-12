import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type postgres from "postgres";
import type { DatasetMetadata, StateStore } from "../../state.js";

export interface SearchIndexRuntimeState {
  building: boolean;
  failure: { region: string; error: string; at: string } | null;
}

export function createSearchIndexRuntimeState(): SearchIndexRuntimeState {
  return { building: false, failure: null };
}

export interface SearchIndexStatus {
  region: string;
  sourcePath: string | null;
  sourceFingerprint: string | null;
  currentFingerprint: string | null;
  epoch: string | null;
  status: "building" | "ready" | "failed";
  placeCount: number;
  termCount: number;
  startedAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
  lastError: string | null;
  stale: boolean;
  building: boolean;
}

export async function fingerprintDataset(dataset: DatasetMetadata): Promise<string> {
  if (dataset.sha256) return `sha256:${dataset.sha256.toLowerCase()}`;
  if (dataset.md5) return `md5:${dataset.md5.toLowerCase()}`;
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(dataset.path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
    stream.on("error", reject);
  });
}

export function resolveOsmDataset(store: StateStore, region: string): DatasetMetadata {
  const matches = store
    .getAll()
    .filter((dataset) => dataset.type === "osm-pbf" && (dataset.region ?? dataset.id) === region);
  if (matches.length === 0) throw new Error(`no registered OSM PBF for region ${region}`);
  if (matches.length > 1) throw new Error(`multiple registered OSM PBFs for region ${region}`);
  return matches[0];
}

export async function updateCurrentSearchIndexFingerprint(
  sql: postgres.Sql,
  region: string,
  fingerprint: string,
): Promise<void> {
  const rows = await sql.unsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('osm_search.index_state') IS NOT NULL AS exists`,
  );
  if (!rows[0]?.exists) return;
  await sql.unsafe(
    `UPDATE osm_search.index_state
        SET current_fingerprint = $2, updated_at = NOW()
      WHERE singleton = 1 AND region = $1`,
    [region, fingerprint],
  );
}

interface IndexStateRow {
  region: string;
  source_path: string;
  source_fingerprint: string;
  current_fingerprint: string;
  epoch: string;
  status: "building" | "ready" | "failed";
  place_count: string | number;
  term_count: string | number;
  started_at: Date | string;
  published_at: Date | string | null;
  updated_at: Date | string;
  last_error: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getSearchIndexStatus(opts: {
  dataDir: string;
  store: StateStore;
  sql: postgres.Sql;
  runtimeState: SearchIndexRuntimeState;
}): Promise<SearchIndexStatus | null> {
  const existence = await opts.sql.unsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('osm_search.index_state') IS NOT NULL AS exists`,
  );
  if (!existence[0]?.exists) {
    const failure = opts.runtimeState.failure;
    if (!failure) return null;
    return {
      region: failure.region,
      sourcePath: null,
      sourceFingerprint: null,
      currentFingerprint: null,
      epoch: null,
      status: "failed",
      placeCount: 0,
      termCount: 0,
      startedAt: null,
      publishedAt: null,
      updatedAt: failure.at,
      lastError: failure.error,
      stale: false,
      building: opts.runtimeState.building,
    };
  }
  const rows = await opts.sql.unsafe<IndexStateRow[]>(
    `SELECT * FROM osm_search.index_state WHERE singleton = 1`,
  );
  const row = rows[0];
  if (!row) return null;
  let currentFingerprint = row.current_fingerprint;
  const currentDataset = opts.store
    .getAll()
    .find((dataset) => dataset.type === "osm-pbf" && (dataset.region ?? dataset.id) === row.region);
  if (currentDataset) {
    try {
      currentFingerprint = await fingerprintDataset(currentDataset);
    } catch {
      /* stored evidence remains useful */
    }
  }
  return {
    region: row.region,
    sourcePath: row.source_path,
    sourceFingerprint: row.source_fingerprint,
    currentFingerprint,
    epoch: row.epoch,
    status: row.status,
    placeCount: Number(row.place_count),
    termCount: Number(row.term_count),
    startedAt: iso(row.started_at),
    publishedAt: iso(row.published_at),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
    lastError: row.last_error,
    stale: currentFingerprint !== row.source_fingerprint,
    building: opts.runtimeState.building,
  };
}
