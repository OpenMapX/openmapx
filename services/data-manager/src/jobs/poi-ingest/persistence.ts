import { poiFeedState } from "@openmapx/db-schema";
import { sql as drizzleSql, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { scrubSecrets } from "../../utils/scrub-secrets.js";
import { createJobRow, finalizeJobRow, makePersistingOnStageComplete } from "../persistence.js";
import type {
  PoiIngestKind,
  PoiIngestResult,
  PoiIngestStageResult,
  PoiJobLogger,
} from "./types.js";

export interface CreatePoiJobRowOptions {
  sourceId: string;
  kind: PoiIngestKind;
  triggeredBy?: string | null;
  metadata?: Record<string, unknown>;
}

/** Insert a new `data_manager.jobs` row in `running` state and return its id. */
export async function createPoiJobRow(opts: CreatePoiJobRowOptions): Promise<string> {
  return createJobRow({
    kind: `poi-ingest:${opts.kind}`,
    triggeredBy: opts.triggeredBy,
    metadata: { sourceId: opts.sourceId, ...(opts.metadata ?? {}) },
  });
}

/** Mark the POI ingest job as finished with its aggregated status. */
export async function finalizePoiJobRow(
  jobId: string,
  status: PoiIngestResult["status"],
): Promise<void> {
  await finalizeJobRow(jobId, status);
}

/**
 * Build an `onStageComplete` hook bound to a specific job id. Mirrors the
 * Transitous persistence hook: failures to persist a stage are logged and
 * swallowed so a transient DB outage cannot collapse an otherwise-successful
 * ingest.
 */
export function makePoiPersistingOnStageComplete(
  jobId: string,
  logger: PoiJobLogger,
): (result: PoiIngestStageResult) => Promise<void> {
  return makePersistingOnStageComplete(jobId, logger, "poi-ingest");
}

export interface UpsertPoiFeedStateOptions {
  sourceId: string;
  domain: string;
  result: PoiIngestResult;
  /** Previous static hash, used to preserve fields on a bundled-skip run. */
  previousStaticHash?: string;
  /** Previous static row count paired with previousStaticHash. */
  previousStaticRowCount?: number;
}

/**
 * Upsert `data_manager.poi_feed_state` for the source after an ingest run
 * completes.
 *
 * Field semantics:
 * - `last_static_ingest_at` / `last_static_row_count` / `last_static_hash`
 *   are updated when the static table was actually rewritten — i.e. when
 *   `kind === "static"` OR (`kind === "bundled"` AND
 *   `skippedStaticSwap !== true`). On a bundled-skip run the staging area is
 *   discarded without a swap and the static columns are left untouched —
 *   `last_static_ingest_at` is meant to surface "when the data on disk was
 *   last refreshed", so re-confirming an unchanged hash is intentionally not
 *   a refresh.
 * - `last_live_ingest_at` / `last_live_row_count` are updated when the live
 *   cache was touched — i.e. `kind === "live"` OR `kind === "bundled"`.
 * - `status` flips to `failed` when the run errored, otherwise `active`.
 *   `stale` is reserved for the staleness checker (not used here).
 * - `consecutive_failures` increments server-side on failure (CASE expression
 *   to avoid the SELECT round-trip) and resets to 0 on success.
 * - `last_error` carries `{ message, stack? }` on failure, otherwise NULL.
 */
export async function upsertPoiFeedState(opts: UpsertPoiFeedStateOptions): Promise<void> {
  const { sourceId, domain, result } = opts;
  const touchedStatic =
    result.kind === "static" || (result.kind === "bundled" && result.skippedStaticSwap !== true);
  const touchedLive = result.kind === "live" || result.kind === "bundled";
  const errored = result.status === "error";
  const newStatus = errored ? "failed" : "active";
  const lastError = errored ? buildLastError(result) : null;
  const now = new Date();

  const insertValues: {
    sourceId: string;
    domain: string;
    status: string;
    consecutiveFailures: number;
    lastError: { message: string; stack?: string } | null;
    lastStaticIngestAt?: Date;
    lastStaticRowCount?: number;
    lastStaticHash?: string;
    lastLiveIngestAt?: Date;
    lastLiveRowCount?: number;
  } = {
    sourceId,
    domain,
    status: newStatus,
    consecutiveFailures: errored ? 1 : 0,
    lastError,
  };

  const updatePatch: Record<string, unknown> = {
    domain,
    status: newStatus,
    lastError,
    consecutiveFailures: errored
      ? drizzleSql`${poiFeedState.consecutiveFailures} + 1`
      : drizzleSql`0`,
  };

  if (touchedStatic) {
    const rowCount = result.staticRowCount ?? 0;
    insertValues.lastStaticIngestAt = now;
    insertValues.lastStaticRowCount = rowCount;
    updatePatch.lastStaticIngestAt = now;
    updatePatch.lastStaticRowCount = rowCount;
    if (result.staticHash) {
      insertValues.lastStaticHash = result.staticHash;
      updatePatch.lastStaticHash = result.staticHash;
    }
  } else if (result.kind === "bundled" && result.skippedStaticSwap === true) {
    // Bundled-skip: do NOT bump last_static_ingest_at — the table on disk was
    // not rewritten. The previous hash + row count remain authoritative; we
    // preserve them on the first-INSERT path so the row is internally
    // consistent.
    if (opts.previousStaticHash !== undefined) {
      insertValues.lastStaticHash = opts.previousStaticHash;
    }
    if (opts.previousStaticRowCount !== undefined) {
      insertValues.lastStaticRowCount = opts.previousStaticRowCount;
    }
  }

  if (touchedLive) {
    const rowCount = result.liveRowCount ?? 0;
    insertValues.lastLiveIngestAt = now;
    insertValues.lastLiveRowCount = rowCount;
    updatePatch.lastLiveIngestAt = now;
    updatePatch.lastLiveRowCount = rowCount;
  }

  await db.insert(poiFeedState).values(insertValues).onConflictDoUpdate({
    target: poiFeedState.sourceId,
    set: updatePatch,
  });
}

function buildLastError(result: PoiIngestResult): { message: string; stack?: string } | null {
  if (result.error) {
    return result.error.stack
      ? { message: scrubSecrets(result.error.message), stack: scrubSecrets(result.error.stack) }
      : { message: scrubSecrets(result.error.message) };
  }
  // Fall back to the last failing stage's error payload.
  for (let i = result.stages.length - 1; i >= 0; i--) {
    const stage = result.stages[i];
    if (stage?.status === "error" && stage.error) {
      return stage.error.stack
        ? { message: scrubSecrets(stage.error.message), stack: scrubSecrets(stage.error.stack) }
        : { message: scrubSecrets(stage.error.message) };
    }
  }
  return null;
}

/**
 * Read the last persisted static hash + row count for a source. Returns
 * `undefined` when the source has never been ingested.
 */
export async function getLastPoiFeedState(sourceId: string): Promise<
  | {
      lastStaticHash: string | null;
      lastStaticRowCount: number | null;
      lastStaticIngestAt: Date | null;
      consecutiveFailures: number;
      status: string;
    }
  | undefined
> {
  const rows = await db
    .select({
      lastStaticHash: poiFeedState.lastStaticHash,
      lastStaticRowCount: poiFeedState.lastStaticRowCount,
      lastStaticIngestAt: poiFeedState.lastStaticIngestAt,
      consecutiveFailures: poiFeedState.consecutiveFailures,
      status: poiFeedState.status,
    })
    .from(poiFeedState)
    .where(eq(poiFeedState.sourceId, sourceId))
    .limit(1);
  return rows[0];
}
