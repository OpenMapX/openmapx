import type { NotablePlacesStatus as CanonicalNotablePlacesStatus } from "@openmapx/core/data-manager-contracts";
import { NOTABLE_PLACES_SCHEMA_VERSION } from "@openmapx/core/published-data";
import type postgres from "postgres";

export interface NotablePlacesRuntimeState {
  building: boolean;
  failure: { error: string; at: string } | null;
}

export function createNotablePlacesRuntimeState(): NotablePlacesRuntimeState {
  return { building: false, failure: null };
}

export type NotablePlacesStatus = Omit<CanonicalNotablePlacesStatus, "ok">;

interface IndexStateRow {
  source: string;
  min_sitelinks: number;
  epoch: string;
  status: "building" | "ready" | "failed";
  place_count: string | number;
  name_count: string | number;
  started_at: Date | string;
  published_at: Date | string | null;
  updated_at: Date | string;
  last_error: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Whether a snapshot is published, i.e. whether searches can use the index. */
export async function hasPublishedNotablePlaces(sql: postgres.Sql): Promise<boolean> {
  const rows = await sql.unsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('notable_places.index_state') IS NOT NULL AS exists`,
  );
  return rows[0]?.exists === true;
}

/** Whether the published snapshot, if any, was written by the current builder. */
export async function hasCurrentNotablePlaces(sql: postgres.Sql): Promise<boolean> {
  if (!(await hasPublishedNotablePlaces(sql))) return false;
  const rows = await sql.unsafe<{ schema_version: number }[]>(
    `SELECT schema_version FROM notable_places.index_state WHERE singleton = 1`,
  );
  return rows[0]?.schema_version === NOTABLE_PLACES_SCHEMA_VERSION;
}

export async function getNotablePlacesStatus(opts: {
  sql: postgres.Sql;
  runtimeState: NotablePlacesRuntimeState;
}): Promise<NotablePlacesStatus | null> {
  if (!(await hasPublishedNotablePlaces(opts.sql))) {
    const failure = opts.runtimeState.failure;
    if (!failure && !opts.runtimeState.building) return null;
    return {
      source: null,
      minSitelinks: null,
      epoch: null,
      status: failure ? "failed" : "building",
      placeCount: 0,
      nameCount: 0,
      startedAt: null,
      publishedAt: null,
      updatedAt: failure?.at ?? new Date().toISOString(),
      lastError: failure?.error ?? null,
      building: opts.runtimeState.building,
    };
  }
  const rows = await opts.sql.unsafe<IndexStateRow[]>(
    `SELECT * FROM notable_places.index_state WHERE singleton = 1`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    source: row.source,
    minSitelinks: Number(row.min_sitelinks),
    epoch: row.epoch,
    status: row.status,
    placeCount: Number(row.place_count),
    nameCount: Number(row.name_count),
    startedAt: iso(row.started_at),
    publishedAt: iso(row.published_at),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
    lastError: row.last_error,
    building: opts.runtimeState.building,
  };
}
