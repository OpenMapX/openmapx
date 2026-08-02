import { assertFeedUrlAllowed, privateFeedHostAllowlist } from "@openmapx/core/utils/safe-download";
import type {
  BundledPoiSpec,
  LivePoiSpec,
  PoiFetchSpec,
  RegisteredPoiSource,
  StaticPoiSpec,
} from "@openmapx/poi-source-registry";
import type { PoiIngestKind, PoiIngestStageResult, PoiJobContext } from "../types.js";

type FetchableSpec = StaticPoiSpec | LivePoiSpec | BundledPoiSpec;

/**
 * Ceiling for one POI feed download. National registries are the largest thing
 * that flows through here (tens of megabytes), so this leaves several times
 * the headroom while bounding what one feed can make the daemon allocate.
 * Raise it for a specific source with `fetch.maxBytes` rather than globally.
 */
const DEFAULT_MAX_FETCH_BYTES = 256 * 1024 * 1024;

async function readBounded(response: Response, maxBytes: number, url: string): Promise<Buffer> {
  if (!response.body) {
    // Test doubles and some runtimes hand back a bodyless Response; fall back
    // to the buffered read, still bounded by the check above.
    const fallback = Buffer.from(await response.arrayBuffer());
    if (fallback.byteLength > maxBytes) {
      throw new Error(`fetch ${url} exceeded max ${maxBytes} bytes`);
    }
    return fallback;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`fetch ${url} exceeded max ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/**
 * Pick the spec for the given pipeline kind. Throws (synchronously) for
 * mismatches — e.g. `kind="bundled"` on a static-only source. The pipeline
 * catches this and turns it into a stage error.
 */
export function getSpec(source: RegisteredPoiSource, kind: PoiIngestKind): FetchableSpec {
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
    if (dynamic) {
      // A dynamic URL is scraped from a remote page or read out of a remote
      // API response, so the target host is chosen by third-party content.
      // Static `fetch.url` values are constants in this repository and are
      // deliberately left alone.
      await assertFeedUrlAllowed(dynamic, privateFeedHostAllowlist());
      return dynamic;
    }
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

    // Static `headers` first, then async `resolveHeaders` — letting the
    // resolved values win on conflict so per-source env-based auth (UTMC
    // Basic, DB BahnPark, NSW) can override a placeholder declared in the
    // PoiSource manifest. A resolveHeaders throw surfaces as a fetch-stage
    // error via the outer try/catch — same path as URL resolution failures.
    const headers: Record<string, string> = { ...(fetchSpec.headers ?? {}) };
    if (fetchSpec.resolveHeaders) {
      const resolved = await fetchSpec.resolveHeaders(ctx.logger);
      Object.assign(headers, resolved);
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
      headers,
      signal: composed,
    });

    if (!response.ok) {
      throw new Error(`fetch ${url} failed: HTTP ${response.status} ${response.statusText}`);
    }

    const maxBytes = fetchSpec.maxBytes ?? DEFAULT_MAX_FETCH_BYTES;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(
        `fetch ${url} refused: declared Content-Length ${declaredLength} exceeds max ${maxBytes} bytes`,
      );
    }
    const buffer = await readBounded(response, maxBytes, url);
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
