import type { PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";
import type { PoiIngestStageResult, PoiJobContext } from "../types.js";
import { getSpec } from "./fetch.js";

const INVALID_ROW_LIMIT_FRACTION = 0.05;

function nowIso(ctx: PoiJobContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

function isValidRow(row: unknown): row is PoiRow {
  if (!row || typeof row !== "object") return false;
  const candidate = row as Partial<PoiRow>;
  return (
    typeof candidate.poiId === "string" &&
    typeof candidate.lng === "number" &&
    typeof candidate.lat === "number" &&
    Number.isFinite(candidate.lng) &&
    Number.isFinite(candidate.lat) &&
    candidate.payload !== undefined &&
    candidate.payload !== null &&
    typeof candidate.payload === "object"
  );
}

async function collectRows(
  iterable: AsyncIterable<PoiRow> | Iterable<PoiRow>,
  ctx: PoiJobContext,
): Promise<{ rows: PoiRow[]; invalid: number }> {
  const rows: PoiRow[] = [];
  let invalid = 0;
  for await (const candidate of iterable as AsyncIterable<PoiRow>) {
    if (isValidRow(candidate)) {
      rows.push(candidate);
    } else {
      invalid++;
      if (invalid <= 5) {
        ctx.logger.warn("parse: dropped invalid row", { row: candidate });
      }
    }
  }
  return { rows, invalid };
}

function tooManyInvalid(invalid: number, total: number): boolean {
  if (total === 0) return invalid > 0;
  return invalid / total > INVALID_ROW_LIMIT_FRACTION;
}

export async function run(ctx: PoiJobContext): Promise<PoiIngestStageResult> {
  const startedAt = nowIso(ctx);
  const startMs = Date.now();

  try {
    const buffer = ctx.state.fetched;
    if (!buffer) {
      throw new Error("parse: no fetched buffer in ctx.state — fetch stage must run first");
    }

    const spec = getSpec(ctx.source, ctx.kind);
    const log = ctx.logger;

    if (ctx.kind === "live") {
      const liveSpec = spec as { parse: (buf: Buffer, c: { log: typeof log }) => unknown };
      const parsed = await liveSpec.parse(buffer, { log });
      if (!(parsed instanceof Map)) {
        throw new Error("live parser must return a Map<string, PoiLiveState>");
      }
      const liveState = parsed as Map<string, PoiLiveState>;
      ctx.state.liveState = liveState;
      const finishedAt = nowIso(ctx);
      return {
        stage: "parse",
        status: "ok",
        startedAt,
        finishedAt,
        durationMs: Date.now() - startMs,
        artifacts: { rowCount: liveState.size, kind: "live" },
      };
    }

    if (ctx.kind === "static") {
      const staticSpec = spec as {
        parse: (buf: Buffer, c: { log: typeof log }) => AsyncIterable<PoiRow> | Iterable<PoiRow>;
      };
      const iter = staticSpec.parse(buffer, { log });
      const { rows, invalid } = await collectRows(iter, ctx);
      const total = rows.length + invalid;
      if (tooManyInvalid(invalid, total)) {
        throw new Error(
          `parse: too many invalid rows (${invalid} of ${total}, > ${
            INVALID_ROW_LIMIT_FRACTION * 100
          }% threshold)`,
        );
      }
      ctx.state.staticRows = rows;
      const finishedAt = nowIso(ctx);
      return {
        stage: "parse",
        status: "ok",
        startedAt,
        finishedAt,
        durationMs: Date.now() - startMs,
        message: invalid > 0 ? `dropped ${invalid} invalid rows` : undefined,
        artifacts: { rowCount: rows.length, kind: "static", invalidDropped: invalid },
      };
    }

    // bundled
    const bundledSpec = spec as {
      parse: (
        buf: Buffer,
        c: { log: typeof log },
      ) =>
        | Promise<{ static: PoiRow[]; live: Map<string, PoiLiveState> }>
        | { static: PoiRow[]; live: Map<string, PoiLiveState> };
    };
    const parsed = await bundledSpec.parse(buffer, { log });
    const validRows: PoiRow[] = [];
    let invalid = 0;
    for (const candidate of parsed.static) {
      if (isValidRow(candidate)) {
        validRows.push(candidate);
      } else {
        invalid++;
        if (invalid <= 5) ctx.logger.warn("parse: dropped invalid bundled row", { row: candidate });
      }
    }
    const total = validRows.length + invalid;
    if (tooManyInvalid(invalid, total)) {
      throw new Error(
        `parse: too many invalid rows (${invalid} of ${total}, > ${
          INVALID_ROW_LIMIT_FRACTION * 100
        }% threshold)`,
      );
    }
    ctx.state.staticRows = validRows;
    ctx.state.liveState = parsed.live;
    const finishedAt = nowIso(ctx);
    return {
      stage: "parse",
      status: "ok",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      message: invalid > 0 ? `dropped ${invalid} invalid rows` : undefined,
      artifacts: {
        staticRowCount: validRows.length,
        liveRowCount: parsed.live.size,
        invalidDropped: invalid,
      },
    };
  } catch (err) {
    const error = err as Error;
    const finishedAt = nowIso(ctx);
    return {
      stage: "parse",
      status: "error",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      message: error.message,
      error: { message: error.message, stack: error.stack },
    };
  }
}
