import { getAllPoiSources, type PoiSource } from "@openmapx/poi-source-registry";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import type { PoiIngestMetricsSink } from "./metrics.js";
import { createPoiJobRow, getLastPoiFeedState } from "./persistence.js";
import { runOneAndPersist } from "./runner.js";
import type { PoiSingleFlight } from "./single-flight.js";
import type { PoiIngestKind, PoiJobLogger } from "./types.js";

export interface BootstrapOptions {
  sql: Sql;
  redis: Redis;
  singleFlight: PoiSingleFlight;
  metricsSink: PoiIngestMetricsSink;
  logger: PoiJobLogger;
  /** Defaults to the live registry snapshot. Override for tests. */
  sources?: readonly PoiSource[];
}

export interface BootstrapResult {
  scanned: number;
  triggered: number;
  skipped: number;
  errors: number;
}

interface KindDecision {
  kind: PoiIngestKind;
  reason: "cold-static" | "cold-bundled" | "cold-live";
}

/**
 * Decide which kinds need a first ingest given the persisted feed state.
 *
 * - `static`-only: trigger static when `lastStaticIngestAt == null`
 * - `bundled`-only: trigger bundled when `lastStaticIngestAt == null` (the
 *   bundled pipeline writes both sides in one run)
 * - `static+live`: trigger static when static is null, trigger live when live
 *   has never been written. Sequenced static-first so the live merge has a
 *   table to merge into.
 *
 * The `lastLiveIngestAt` check is done by the caller (we don't return it
 * inside this helper because the persistence row only carries the static
 * timestamp; live triggering is decided from the absence of a successful
 * static run for static+live sources, mirroring the cron's bootstrap-only
 * contract — first deploy = run everything once).
 */
function decideKindsToTrigger(
  source: PoiSource,
  lastStaticIngestAt: Date | null | undefined,
): KindDecision[] {
  const decisions: KindDecision[] = [];
  const hasStatic = (source as { static?: unknown }).static !== undefined;
  const hasBundled = (source as { bundled?: unknown }).bundled !== undefined;
  const hasLive = (source as { live?: unknown }).live !== undefined;
  const coldStatic = lastStaticIngestAt == null;

  if (hasBundled && coldStatic) {
    decisions.push({ kind: "bundled", reason: "cold-bundled" });
    return decisions;
  }
  if (hasStatic && coldStatic) {
    decisions.push({ kind: "static", reason: "cold-static" });
  }
  if (hasLive && coldStatic) {
    decisions.push({ kind: "live", reason: "cold-live" });
  }
  return decisions;
}

function cronExpressionFor(source: PoiSource, kind: PoiIngestKind): string {
  if (kind === "static") return (source as { static: { cron: string } }).static.cron;
  if (kind === "live") return (source as { live: { cron: string } }).live.cron;
  return (source as { bundled: { cron: string } }).bundled.cron;
}

/**
 * For every registered source, check whether it has ever been successfully
 * ingested. Trigger an immediate sync for sources that haven't (gated by
 * env `POI_INGEST_BOOTSTRAP=true` at the caller). Runs sequentially so we
 * don't slam upstream APIs on first deploy with 28 concurrent fetches.
 *
 * Resilience: errors are logged + counted, never thrown. The bootstrap is
 * best-effort — the regular cron will catch up anything we miss.
 */
export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { sql, redis, singleFlight, metricsSink, logger } = opts;
  const sources = opts.sources ?? getAllPoiSources();

  const result: BootstrapResult = {
    scanned: sources.length,
    triggered: 0,
    skipped: 0,
    errors: 0,
  };

  for (const source of sources) {
    let prevState: Awaited<ReturnType<typeof getLastPoiFeedState>>;
    try {
      prevState = await getLastPoiFeedState(source.id);
    } catch (err) {
      // A persistence read failure is non-fatal — count it and move on so
      // one bad row can't block the rest of the bootstrap.
      result.errors += 1;
      logger.warn("poi-ingest-bootstrap: feed-state read failed", {
        sourceId: source.id,
        err: (err as Error).message,
      });
      continue;
    }

    const decisions = decideKindsToTrigger(source, prevState?.lastStaticIngestAt ?? null);
    if (decisions.length === 0) {
      result.skipped += 1;
      continue;
    }

    for (const { kind, reason } of decisions) {
      const acquire = singleFlight.tryAcquire(source.id, kind);
      if (!acquire.ok) {
        result.skipped += 1;
        logger.info("poi-ingest-bootstrap: skipped — single-flight busy", {
          sourceId: source.id,
          kind,
          reason: acquire.reason,
        });
        continue;
      }

      let jobId: string;
      try {
        jobId = await createPoiJobRow({
          sourceId: source.id,
          kind,
          triggeredBy: "bootstrap",
          metadata: { schedule: cronExpressionFor(source, kind), bootstrapReason: reason },
        });
      } catch (err) {
        // Mirrors the scheduler's behaviour: an audit-row failure leaks the
        // lock unless we release it explicitly here.
        singleFlight.release(source.id, kind);
        result.errors += 1;
        logger.error("poi-ingest-bootstrap: createPoiJobRow failed", {
          sourceId: source.id,
          kind,
          err: (err as Error).message,
        });
        continue;
      }

      try {
        const runResult = await runOneAndPersist({
          source,
          kind,
          jobId,
          sql,
          redis,
          singleFlight,
          metricsSink,
          logger,
          triggerLabel: "bootstrap",
          logPrefix: "poi-ingest-bootstrap",
        });
        if (runResult.status === "error") {
          result.errors += 1;
        } else {
          result.triggered += 1;
        }
      } catch (err) {
        // `runOneAndPersist` already swallows downstream failures and
        // synthesises an error result, but if the call itself throws we
        // still need to count it.
        result.errors += 1;
        logger.error("poi-ingest-bootstrap: runOneAndPersist threw", {
          sourceId: source.id,
          kind,
          err: (err as Error).message,
        });
      }
    }
  }

  return result;
}
