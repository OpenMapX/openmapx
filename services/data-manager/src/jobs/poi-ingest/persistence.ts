import { poiFeedState } from "@openmapx/db-schema";
import { sql as drizzleSql, eq } from "drizzle-orm";
import { db, sql as postgresSql } from "../../db/index.js";
import { scrubSecrets } from "../../utils/scrub-secrets.js";
import { createJobRow, finalizeJobRow, makePersistingOnStageComplete } from "../persistence.js";
import { mergePoiRefreshEvidence } from "./evidence.js";
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
  jobId?: string;
  /** Previous static hash, used to preserve fields on a bundled-skip run. */
  previousStaticHash?: string;
  /** Previous static row count paired with previousStaticHash. */
  previousStaticRowCount?: number;
}

/**
 * Upsert `data_manager.poi_feed_state` for the source after an ingest run
 * completes.
 *
 * Only terminal publication stages advance the existing success columns:
 * `swap` for static data and `write-live` for the Redis snapshot. A fetch,
 * parse or import failure therefore preserves the previous known-good
 * publication while refresh evidence records the failed attempt.
 */
export async function upsertPoiFeedState(opts: UpsertPoiFeedStateOptions): Promise<void> {
  const { sourceId, domain, result } = opts;
  const staticStage = result.stages.find((stage) => stage.stage === "swap");
  const liveStage = result.stages.find((stage) => stage.stage === "write-live");
  const staticPublished = staticStage?.status === "ok";
  const livePublished = liveStage?.status === "ok";
  const staticRequested = result.kind === "static" || result.kind === "bundled";
  const liveRequested = result.kind === "live" || result.kind === "bundled";
  const failed = result.status === "error" || result.status === "partial";
  const newStatus = failed ? "failed" : "active";
  const lastError = failed ? buildLastError(result) : null;

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
    consecutiveFailures: failed ? 1 : 0,
    lastError,
  };

  const updatePatch: Record<string, unknown> = {
    domain,
    status: newStatus,
    lastError,
    consecutiveFailures: failed
      ? drizzleSql`${poiFeedState.consecutiveFailures} + 1`
      : drizzleSql`0`,
  };

  if (staticPublished) {
    const rowCount = result.staticRowCount ?? 0;
    const publishedAt = dateFromIso(staticStage?.finishedAt) ?? new Date();
    insertValues.lastStaticIngestAt = publishedAt;
    insertValues.lastStaticRowCount = rowCount;
    updatePatch.lastStaticIngestAt = publishedAt;
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

  if (livePublished) {
    const rowCount = result.liveRowCount ?? 0;
    const publishedAt = dateFromIso(liveStage?.finishedAt) ?? new Date();
    insertValues.lastLiveIngestAt = publishedAt;
    insertValues.lastLiveRowCount = rowCount;
    updatePatch.lastLiveIngestAt = publishedAt;
    updatePatch.lastLiveRowCount = rowCount;
  }

  await db.insert(poiFeedState).values(insertValues).onConflictDoUpdate({
    target: poiFeedState.sourceId,
    set: updatePatch,
  });

  if (staticRequested) {
    const evidence = buildAttemptPatch(result, staticStage, "static", opts);
    await mergePoiRefreshEvidence(postgresSql, {
      sourceId,
      domain,
      stream: "static",
      patch: evidence.patch,
    });
  }
  if (liveRequested) {
    const evidence = buildAttemptPatch(result, liveStage, "live", opts);
    await mergePoiRefreshEvidence(postgresSql, {
      sourceId,
      domain,
      stream: "live",
      patch: evidence.patch,
      ...(evidence.pendingWriteIntentGuard
        ? { pendingWriteIntentGuard: evidence.pendingWriteIntentGuard }
        : {}),
    });
  }
}

function buildAttemptPatch(
  result: PoiIngestResult,
  stage: PoiIngestStageResult | undefined,
  stream: "static" | "live",
  opts: UpsertPoiFeedStateOptions,
): {
  patch: import("./evidence.js").PoiRefreshStreamPatch;
  pendingWriteIntentGuard?: string;
} {
  const outcome = stage
    ? stage.status === "ok"
      ? "succeeded"
      : stage.status === "skipped"
        ? stream === "static"
          ? "unchanged"
          : "skipped"
        : stage.status === "partial"
          ? "partial"
          : "failed"
    : result.status === "partial"
      ? "partial"
      : result.status === "skipped"
        ? "skipped"
        : "failed";
  const at = stage?.finishedAt ?? result.finishedAt;
  const message = stage?.error?.message ?? stage?.message ?? result.error?.message ?? null;
  const patch: import("./evidence.js").PoiRefreshStreamPatch = {
    lastAttempt: {
      at,
      outcome,
      jobId: opts.jobId ?? null,
      message,
    },
  };

  const intentId = stage?.artifacts?.intentId;

  // A validated unchanged static response is a successful check only when
  // the active version is the same change key we just validated.
  if (
    stream === "static" &&
    stage?.status === "skipped" &&
    result.staticHash &&
    opts.previousStaticHash === result.staticHash
  ) {
    patch.lastSuccessfullyCheckedVersion = result.staticHash;
    patch.lastSuccessfulCheckAt = at;
  }

  return {
    patch,
    ...(stream === "live" && typeof intentId === "string" && intentId.length > 0
      ? { pendingWriteIntentGuard: intentId }
      : {}),
  };
}

function dateFromIso(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
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
    if ((stage?.status === "error" || stage?.status === "partial") && stage.error) {
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
