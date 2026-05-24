import type { PoiRow } from "@openmapx/poi-source-registry";
import type { PoiIngestStageResult, PoiJobContext } from "../types.js";
import { stagingIndexName, stagingTableName, tableName } from "./swap.js";

const BATCH_SIZE = 500;

function nowIso(ctx: PoiJobContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

async function createStagingTable(ctx: PoiJobContext): Promise<void> {
  const sourceId = ctx.source.id;
  // Call tableName() first to validate the id before any DDL runs.
  tableName(sourceId);
  const staging = stagingTableName(sourceId);
  const stagingIdx = stagingIndexName(sourceId);

  await ctx.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS poi_ingest`);
  await ctx.sql.unsafe(`DROP TABLE IF EXISTS poi_ingest."${staging}" CASCADE`);
  await ctx.sql.unsafe(
    `CREATE TABLE poi_ingest."${staging}" (
      poi_id text PRIMARY KEY,
      payload jsonb NOT NULL,
      geom geography(POINT, 4326) NOT NULL,
      ingested_at timestamptz NOT NULL DEFAULT now()
    )`,
  );
  await ctx.sql.unsafe(`CREATE INDEX "${stagingIdx}" ON poi_ingest."${staging}" USING GIST (geom)`);
}

async function insertBatch(ctx: PoiJobContext, batch: readonly PoiRow[]): Promise<void> {
  const staging = stagingTableName(ctx.source.id);
  // The staging name was sanitized by tableName(); row payloads / coordinates
  // flow through positional params so values can never be reinterpreted as SQL.
  // postgres-js auto-encodes plain objects passed as params into jsonb when
  // the column type matches, so we pass payload directly.
  const params: unknown[] = [];
  const tuples = batch.map((row) => {
    const baseIdx = params.length;
    params.push(row.poiId);
    params.push(JSON.stringify(row.payload));
    params.push(row.lng);
    params.push(row.lat);
    return `($${baseIdx + 1}, $${baseIdx + 2}::jsonb, ST_SetSRID(ST_MakePoint($${baseIdx + 3}, $${baseIdx + 4}), 4326)::geography)`;
  });
  const query = `INSERT INTO poi_ingest."${staging}" (poi_id, payload, geom) VALUES ${tuples.join(", ")}`;
  await ctx.sql.unsafe(query, params as never[]);
}

export async function run(ctx: PoiJobContext): Promise<PoiIngestStageResult> {
  const startedAt = nowIso(ctx);
  const startMs = Date.now();

  try {
    const rows = ctx.state.staticRows;
    if (!rows) {
      throw new Error("upsert-static: no staticRows in ctx.state — parse stage must run first");
    }

    // Bundled hash short-circuit: if the source emits a deterministic change
    // key and it matches the previous run's hash, skip the swap entirely.
    // This avoids churning the live table (and dropping its plan cache /
    // statistics) when upstream returned identical data.
    if (ctx.kind === "bundled" && ctx.source.bundled?.staticChangeKey) {
      const hash = ctx.source.bundled.staticChangeKey(rows);
      ctx.state.staticHash = hash;
      if (ctx.lastStaticHash && ctx.lastStaticHash === hash) {
        ctx.state.skippedStaticSwap = true;
        const finishedAt = nowIso(ctx);
        return {
          stage: "upsert-static",
          status: "skipped",
          startedAt,
          finishedAt,
          durationMs: Date.now() - startMs,
          message: "static unchanged",
          artifacts: { rowCount: rows.length, hash },
        };
      }
    }

    await createStagingTable(ctx);

    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const slice = rows.slice(i, i + BATCH_SIZE);
      if (slice.length === 0) continue;
      await insertBatch(ctx, slice);
      inserted += slice.length;
    }

    const finishedAt = nowIso(ctx);
    return {
      stage: "upsert-static",
      status: "ok",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      artifacts: {
        rowCount: inserted,
        stagingTable: stagingTableName(ctx.source.id),
        hash: ctx.state.staticHash,
      },
    };
  } catch (err) {
    const error = err as Error;
    const finishedAt = nowIso(ctx);
    return {
      stage: "upsert-static",
      status: "error",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      message: error.message,
      error: { message: error.message, stack: error.stack },
    };
  }
}
