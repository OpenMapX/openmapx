import type { PoiValidateFn } from "@openmapx/poi-source-registry";
import type { PoiIngestStageResult, PoiJobContext } from "../types.js";

function nowIso(ctx: PoiJobContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

export async function run(ctx: PoiJobContext): Promise<PoiIngestStageResult> {
  const startedAt = nowIso(ctx);
  const startMs = Date.now();

  try {
    const rows = ctx.state.staticRows;
    if (!rows) {
      throw new Error("validate: no staticRows in ctx.state — parse stage must run first");
    }

    let validateFn: PoiValidateFn | undefined;
    let minRowCount = 1;
    if (ctx.kind === "static" && ctx.source.static) {
      validateFn = ctx.source.static.validate;
      minRowCount = ctx.source.static.minRowCount ?? 1;
    } else if (ctx.kind === "bundled" && ctx.source.bundled) {
      validateFn = ctx.source.bundled.staticValidate;
      minRowCount = ctx.source.bundled.staticMinRowCount ?? 1;
    } else {
      throw new Error(`validate: unexpected kind ${ctx.kind} for source ${ctx.source.id}`);
    }

    if (rows.length < minRowCount) {
      throw new Error(
        `validate: ${rows.length} rows below minRowCount=${minRowCount} for source "${ctx.source.id}"`,
      );
    }

    if (validateFn) {
      const verdict = validateFn(rows);
      if (!verdict.ok) {
        throw new Error(`validate: source validator rejected rows: ${verdict.error}`);
      }
    }

    const finishedAt = nowIso(ctx);
    return {
      stage: "validate",
      status: "ok",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      artifacts: { rowCount: rows.length, minRowCount, ranSourceValidator: Boolean(validateFn) },
    };
  } catch (err) {
    const error = err as Error;
    const finishedAt = nowIso(ctx);
    return {
      stage: "validate",
      status: "error",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      message: error.message,
      error: { message: error.message, stack: error.stack },
    };
  }
}
