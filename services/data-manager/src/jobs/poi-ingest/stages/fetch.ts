import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeDownload } from "@openmapx/core/utils/safe-download";
import type {
  BundledPoiSpec,
  LivePoiSpec,
  PoiFetchSpec,
  RegisteredPoiSource,
  StaticPoiSpec,
} from "@openmapx/poi-source-registry";
import { scrubSecrets, scrubSecretsOptional } from "../../../utils/scrub-secrets.js";
import type { PoiIngestKind, PoiIngestStageResult, PoiJobContext } from "../types.js";

type FetchableSpec = StaticPoiSpec | LivePoiSpec | BundledPoiSpec;

/**
 * Ceiling for one POI feed download. National registries are the largest thing
 * that flows through here (tens of megabytes), so this leaves several times
 * the headroom while bounding what one feed can make the daemon allocate.
 * Raise it for a specific source with `fetch.maxBytes` rather than globally.
 */
const DEFAULT_MAX_FETCH_BYTES = 256 * 1024 * 1024;
const HARD_MAX_FETCH_BYTES = 2 * 1024 * 1024 * 1024;

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
  let downloadDirectory: string | undefined;

  try {
    const spec = getSpec(ctx.source, ctx.kind);
    const fetchSpec = spec.fetch;
    const url = await resolveUrl(spec, ctx);
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

    const maxBytes = fetchSpec.maxBytes ?? DEFAULT_MAX_FETCH_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error(`source "${ctx.source.id}": compressed-byte limit must be positive`);
    }
    if (maxBytes > HARD_MAX_FETCH_BYTES) {
      throw new Error(
        `source "${ctx.source.id}": compressed-byte limit exceeds 2 GiB hard maximum`,
      );
    }

    const timeoutMs = fetchSpec.timeoutMs ?? 60_000;
    downloadDirectory = await mkdtemp(join(tmpdir(), "openmapx-poi-download-"));
    const destination = join(downloadDirectory, "payload");
    const downloader = ctx.download ?? safeDownload;
    const result = await downloader({
      url: new URL(url),
      destination,
      headers,
      timeoutMs,
      maxBytes,
      allowedContentTypes: [],
      credentialPolicy: Object.keys(headers).length > 0 ? "same-origin" : "none",
      signal: ctx.abortSignal,
    });
    const buffer = await readFile(destination);
    ctx.state.fetched = buffer;

    const finishedAt = nowIso(ctx);
    const durationMs = Date.now() - startMs;
    const audit = {
      sourceKind: "poi",
      hostname: result.finalUrl.hostname,
      bytes: result.bytesWritten,
      durationMs,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
    ctx.logger.info("poi-ingest: safe remote acquisition complete", audit);
    return {
      stage: "fetch",
      status: "ok",
      startedAt,
      finishedAt,
      durationMs,
      artifacts: audit,
    };
  } catch (err) {
    const error = err as Error;
    const message = scrubSecrets(error.message);
    const stack = scrubSecretsOptional(error.stack);
    const finishedAt = nowIso(ctx);
    return {
      stage: "fetch",
      status: "error",
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      message,
      error: stack ? { message, stack } : { message },
    };
  } finally {
    if (downloadDirectory) {
      await rm(downloadDirectory, { recursive: true, force: true });
    }
  }
}
