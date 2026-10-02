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

    // Unlike historical bundled keys, static reuse is opt-in and verified
    // against durable publication evidence on every run (API, cron, restart).
    if (ctx.kind === "static" && ctx.source.static?.staticChangeKey) {
      const hash = ctx.source.static.staticChangeKey(rows);
      ctx.state.staticHash = hash;
      const live = tableName(ctx.source.id);
      const [previous] = await ctx.sql.unsafe<
        {
          last_static_hash: string | null;
          last_static_row_count: number | null;
          last_static_ingest_at: Date | string | null;
          table_exists: boolean;
          table_oid: string | null;
          refresh_evidence: {
            version?: number;
            static?: {
              activeVersion?: string;
              lastPublishedVersion?: string;
              lastPublishedAt?: string;
              rowCount?: number;
              tableOid?: string;
              activeAssociation?: string;
              pendingWriteIntentId?: string | null;
            };
          } | null;
        }[]
      >(
        `SELECT last_static_hash, last_static_row_count, last_static_ingest_at,
                refresh_evidence, to_regclass($2::text) IS NOT NULL AS table_exists,
                to_regclass($2::text)::oid::text AS table_oid
         FROM data_manager.poi_feed_state WHERE source_id = $1`,
        [ctx.source.id, `poi_ingest."${live}"`],
      );
      const evidence = previous?.refresh_evidence?.static;
      if (
        previous?.table_exists === true &&
        previous.last_static_hash === hash &&
        previous.last_static_row_count === rows.length &&
        previous.last_static_ingest_at != null &&
        Number.isFinite(new Date(previous.last_static_ingest_at).getTime()) &&
        previous.refresh_evidence?.version === 1 &&
        evidence?.activeAssociation === "known" &&
        evidence.pendingWriteIntentId === null &&
        typeof previous.table_oid === "string" &&
        evidence.tableOid === previous.table_oid &&
        evidence.activeVersion === hash &&
        evidence.lastPublishedVersion === hash &&
        evidence.rowCount === rows.length &&
        typeof evidence.lastPublishedAt === "string" &&
        Number.isFinite(new Date(evidence.lastPublishedAt).getTime())
      ) {
        ctx.state.skippedStaticSwap = true;
        ctx.state.staticPublicationVersion = hash;
        ctx.state.staticPublishedAt = evidence.lastPublishedAt;
        return {
          stage: "upsert-static",
          status: "skipped",
          startedAt,
          finishedAt: nowIso(ctx),
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
