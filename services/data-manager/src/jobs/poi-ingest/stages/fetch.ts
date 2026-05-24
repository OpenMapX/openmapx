import type {
  BundledPoiSpec,
  LivePoiSpec,
  PoiFetchSpec,
  PoiSource,
  StaticPoiSpec,
} from "@openmapx/poi-source-registry";
import type { PoiIngestKind, PoiIngestStageResult, PoiJobContext } from "../types.js";

type FetchableSpec = StaticPoiSpec | LivePoiSpec | BundledPoiSpec;

/**
 * Pick the spec for the given pipeline kind. Throws (synchronously) for
 * mismatches — e.g. `kind="bundled"` on a static-only source. The pipeline
 * catches this and turns it into a stage error.
 */
export function getSpec(source: PoiSource, kind: PoiIngestKind): FetchableSpec {
  if (kind === "static") {
    if (!source.static) {
      throw new Error(`source "${source.id}" has no static spec (kind=static requested)`);
    }
    return source.static;
  }
  if (kind === "live") {
    if (!source.live) {
      throw new Error(`source "${source.id}" has no live spec (kind=live requested)`);
    }
    return source.live;
  }
  if (!source.bundled) {
    throw new Error(`source "${source.id}" has no bundled spec (kind=bundled requested)`);
  }
  return source.bundled;
}

function nowIso(ctx: PoiJobContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

async function resolveUrl(spec: FetchableSpec, ctx: PoiJobContext): Promise<string> {
  if (spec.resolveUrl) {
    const dynamic = await spec.resolveUrl(ctx.logger);
    if (dynamic) return dynamic;
  }
  const url = (spec.fetch as PoiFetchSpec).url;
  if (!url) {
    throw new Error(`source "${ctx.source.id}": neither resolveUrl nor fetch.url produced a URL`);
  }
  return url;
}

export async function run(ctx: PoiJobContext): Promise<PoiIngestStageResult> {
  const startedAt = nowIso(ctx);
  const startMs = Date.now();

  try {
    const spec = getSpec(ctx.source, ctx.kind);
    const fetchSpec = spec.fetch;
    const url = await resolveUrl(spec, ctx);
    const fetchImpl = ctx.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("no fetch implementation available (globalThis.fetch is undefined)");
    }

    const timeoutMs = fetchSpec.timeoutMs ?? 60_000;
    // Compose timeout with the caller's abort signal so an external cancel
    // also tears down the in-flight HTTP request.
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const composed =
      typeof AbortSignal.any === "function"
        ? AbortSignal.any([ctx.abortSignal, timeoutSignal])
        : ctx.abortSignal.aborted
          ? ctx.abortSignal
          : timeoutSignal;

    const response = await fetchImpl(url, {
      headers: fetchSpec.headers,
      signal: composed,
    });

    if (!response.ok) {
      throw new Error(`fetch ${url} failed: HTTP ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    ctx.state.fetched = buffer;

    const finishedAt = nowIso(ctx);
    return {
      stage: "fetch",
      status: "ok",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      artifacts: {
        bytes: buffer.byteLength,
        statusCode: response.status,
        url,
      },
    };
  } catch (err) {
    const error = err as Error;
    const finishedAt = nowIso(ctx);
    return {
      stage: "fetch",
      status: "error",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      message: error.message,
      error: { message: error.message, stack: error.stack },
    };
  }
}
