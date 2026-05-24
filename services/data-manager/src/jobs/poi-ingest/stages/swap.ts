import type { PoiIngestStageResult, PoiJobContext } from "../types.js";

const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Compute the live table name for a source. Mirrored by the A4 reader so
 * both ends agree on `${sourceId.replaceAll("-", "_")}_static`. The regex
 * gate is the same one applied to the registry id; it is the *only* defense
 * against SQL identifier injection here — every callsite must go through
 * this helper rather than interpolating raw ids into SQL.
 */
export function tableName(sourceId: string): string {
  if (!SOURCE_ID_RE.test(sourceId)) {
    throw new Error(`invalid sourceId for SQL table name: "${sourceId}"`);
  }
  return `${sourceId.replace(/-/g, "_")}_static`;
}

export function stagingTableName(sourceId: string): string {
  return `${tableName(sourceId)}__staging`;
}

export function stagingIndexName(sourceId: string): string {
  return `idx_${stagingTableName(sourceId)}_geom`;
}

export function liveIndexName(sourceId: string): string {
  return `idx_${tableName(sourceId)}_geom`;
}

function nowIso(ctx: PoiJobContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

/**
 * Perform the atomic DROP+RENAME swap. Both statements run inside a single
 * `sql.begin(...)` transaction so readers either see the previous table
 * (before COMMIT) or the new one (after COMMIT) — never a window where
 * `poi_ingest.<table>` is missing.
 */
export async function runSwap(ctx: PoiJobContext): Promise<PoiIngestStageResult> {
  const startedAt = nowIso(ctx);
  const startMs = Date.now();
  try {
    const id = ctx.source.id;
    const live = tableName(id);
    const staging = stagingTableName(id);
    const stagingIdx = stagingIndexName(id);
    const liveIdx = liveIndexName(id);

    await ctx.sql.begin(async (tx) => {
      await tx.unsafe(`DROP TABLE IF EXISTS poi_ingest."${live}" CASCADE`);
      await tx.unsafe(`ALTER TABLE poi_ingest."${staging}" RENAME TO "${live}"`);
      await tx.unsafe(`ALTER INDEX poi_ingest."${stagingIdx}" RENAME TO "${liveIdx}"`);
    });

    const finishedAt = nowIso(ctx);
    return {
      stage: "swap",
      status: "ok",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      artifacts: { tableName: live },
    };
  } catch (err) {
    const error = err as Error;
    const finishedAt = nowIso(ctx);
    return {
      stage: "swap",
      status: "error",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      message: error.message,
      error: { message: error.message, stack: error.stack },
    };
  }
}

export const run = runSwap;
