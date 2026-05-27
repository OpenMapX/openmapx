import { type PoiLiveState, poiLiveHashKey } from "@openmapx/poi-source-registry";
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

    const key = poiLiveHashKey(ctx.source.id);
    const ttl = resolveTtl(ctx);
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

    await pipeline.exec();

    const finishedAt = nowIso(ctx);
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
