import { randomUUID } from "node:crypto";
import { type PoiLiveState, poiLiveHashKey } from "@openmapx/poi-source-registry";
import { mergePoiRefreshEvidence } from "../evidence.js";
import type { PoiIngestStageResult, PoiJobContext } from "../types.js";

const DEFAULT_LIVE_TTL_SECONDS = 600;

function nowIso(ctx: PoiJobContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

function resolveTtl(ctx: PoiJobContext): number {
  if (ctx.kind === "live") {
    return ctx.source.live?.ttlSeconds ?? DEFAULT_LIVE_TTL_SECONDS;
  }
  if (ctx.kind === "bundled") {
    return ctx.source.bundled?.liveTtlSeconds ?? DEFAULT_LIVE_TTL_SECONDS;
  }
  return DEFAULT_LIVE_TTL_SECONDS;
}

function upstreamEvidence(liveState: Map<string, PoiLiveState>): {
  upstreamAsOf: string | null;
  upstreamAsOfMin: string | null;
  upstreamAsOfMax: string | null;
} {
  const values = Array.from(liveState.values())
    .map((value) => value.asOf)
    .filter(
      (value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)),
    )
    .map((value) => new Date(value).toISOString())
    .sort();
  const min = values[0] ?? null;
  const max = values.at(-1) ?? null;
  return { upstreamAsOf: min, upstreamAsOfMin: min, upstreamAsOfMax: max };
}

function redisExecutionError(execution: unknown, expectedCommands: number): Error | undefined {
  if (execution === null) return new Error("Redis MULTI execution returned no result");
  if (!Array.isArray(execution))
    return new Error("Redis MULTI execution returned an invalid result");
  if (execution.length !== expectedCommands)
    return new Error("Redis MULTI returned an incomplete result");
  for (const command of execution) {
    if (!Array.isArray(command) || command.length !== 2)
      return new Error("Redis MULTI returned a malformed command result");
    if (Array.isArray(command) && command[0] instanceof Error) return command[0];
  }
  if (expectedCommands === 3 && execution[2][1] !== 1)
    return new Error("Redis live snapshot TTL was not applied");
  return undefined;
}

export async function run(ctx: PoiJobContext): Promise<PoiIngestStageResult> {
  const startedAt = nowIso(ctx);
  const startMs = Date.now();

  try {
    if (!ctx.redis) {
      // Test seam — a null redis means "don't write live state" rather than
      // an error, so unit tests can drive the rest of the pipeline.
      const finishedAt = nowIso(ctx);
      return {
        stage: "write-live",
        status: "skipped",
        startedAt,
        finishedAt,
        durationMs: Date.now() - startMs,
        message: "no redis client",
      };
    }

    const liveState = ctx.state.liveState;
    if (!liveState) {
      throw new Error("write-live: no liveState in ctx.state — parse stage must run first");
    }

    if (typeof ctx.sql.unsafe !== "function") {
      throw new Error("write-live: cannot record durable write intent without Postgres");
    }

    const key = poiLiveHashKey(ctx.source.id);
    const ttl = resolveTtl(ctx);
    const intentId = randomUUID();
    await mergePoiRefreshEvidence(ctx.sql, {
      sourceId: ctx.source.id,
      domain: ctx.source.domain,
      stream: "live",
      patch: {
        activeAssociation: "unknown",
        pendingWriteIntentId: intentId,
        lastAttempt: {
          at: startedAt,
          outcome: "running",
          jobId: ctx.jobId,
        },
      },
    });

    const pipeline = ctx.redis.multi();
    // Always DEL the key first so removed entries don't linger as stale
    // hash fields. The full snapshot is then rebuilt in one round-trip.
    pipeline.del(key);

    let fieldCount = 0;
    if (liveState.size > 0) {
      const hashEntries: Record<string, string> = {};
      for (const [field, value] of liveState as Map<string, PoiLiveState>) {
        hashEntries[field] = JSON.stringify(value);
        fieldCount++;
      }
      pipeline.hset(key, hashEntries);
      pipeline.expire(key, ttl);
    }

    let execution: unknown;
    try {
      execution = await pipeline.exec();
      const executionError = redisExecutionError(execution, fieldCount > 0 ? 3 : 1);
      if (executionError) throw executionError;
    } catch (err) {
      // The intent is already durable. Best effort resolution keeps the
      // current association explicitly unknown when Redis rejected or
      // partially executed the batch; historical successful evidence remains
      // untouched by this patch.
      try {
        await mergePoiRefreshEvidence(ctx.sql, {
          sourceId: ctx.source.id,
          domain: ctx.source.domain,
          stream: "live",
          patch: {
            activeAssociation: "unknown",
            pendingWriteIntentId: null,
            lastAttempt: {
              at: nowIso(ctx),
              outcome: "failed",
              jobId: ctx.jobId,
              message: (err as Error).message,
            },
          },
          pendingWriteIntentGuard: intentId,
        });
      } catch (evidenceErr) {
        ctx.logger.warn("poi-ingest: failed to resolve live write intent", {
          sourceId: ctx.source.id,
          jobId: ctx.jobId,
          err: (evidenceErr as Error).message,
        });
      }
      throw err;
    }

    const finishedAt = nowIso(ctx);
    const publicationVersion = `live:${intentId}`;
    const upstream = upstreamEvidence(liveState);
    const expiresAt = Number.isFinite(Date.parse(startedAt))
      ? new Date(
          Math.min(
            Date.parse(startedAt),
            upstream.upstreamAsOf ? Date.parse(upstream.upstreamAsOf) : Infinity,
          ) +
            ttl * 1_000,
        ).toISOString()
      : null;
    try {
      await mergePoiRefreshEvidence(ctx.sql, {
        sourceId: ctx.source.id,
        domain: ctx.source.domain,
        stream: "live",
        patch: {
          activeVersion: publicationVersion,
          lastSuccessfullyCheckedVersion: publicationVersion,
          lastSuccessfulCheckAt: finishedAt,
          lastPublishedVersion: publicationVersion,
          lastPublishedAt: finishedAt,
          rowCount: fieldCount,
          ...upstream,
          expiresAt,
          activeAssociation: "known",
          pendingWriteIntentId: null,
          lastAttempt: {
            at: finishedAt,
            outcome: "succeeded",
            jobId: ctx.jobId,
          },
        },
        pendingWriteIntentGuard: intentId,
      });
    } catch (err) {
      // Redis has changed, but the durable association could not be resolved.
      // Leave the intent pending in the database and return partial rather
      // than claiming a trustworthy publication.
      return {
        stage: "write-live",
        status: "partial",
        startedAt,
        finishedAt,
        durationMs: Date.now() - startMs,
        message: "Redis live cache write succeeded but publication evidence could not be recorded",
        error: { message: (err as Error).message, stack: (err as Error).stack },
        artifacts: { fieldCount, key, ttlSeconds: fieldCount > 0 ? ttl : 0, intentId },
      };
    }
    ctx.state.livePublicationVersion = publicationVersion;
    ctx.state.livePublishedAt = finishedAt;

    return {
      stage: "write-live",
      status: "ok",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      artifacts: { fieldCount, key, ttlSeconds: fieldCount > 0 ? ttl : 0 },
    };
  } catch (err) {
    const error = err as Error;
    const finishedAt = nowIso(ctx);
    return {
      stage: "write-live",
      status: "error",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      message: error.message,
      error: { message: error.message, stack: error.stack },
    };
  }
}
