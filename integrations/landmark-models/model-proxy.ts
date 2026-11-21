import { gunzipSync } from "node:zlib";
import type {
  IntegrationContext,
  LandmarkModelProvider,
  RouteHandler,
} from "@openmapx/integration-framework";
import type { MergedIndex } from "./merge";
import { type LandmarkIndexSource, landmarkProviders } from "./routes";

export interface ModelProxyOptions {
  /** Verified gzip bytes kept per API replica. */
  cacheBytes?: number;
  /** Upstream model fetches running at once, for the whole process. */
  maxConcurrent?: number;
  /** Fetches allowed to wait for a free slot before requests are refused. */
  maxQueue?: number;
  /** Upstream model bytes per rolling minute before requests are refused. */
  maxBytesPerMinute?: number;
  /** How long an upstream failure is remembered. */
  negativeTtlMs?: number;
  now?: () => number;
}

export interface ModelProxyStats {
  hits: number;
  misses: number;
  upstreamBytes: number;
  rejected: number;
}

const MIB = 1024 * 1024;
const MINUTE = 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_MODEL_BYTES = 4 * MIB;
const FETCH_TIMEOUT_MS = 30_000;
const ADMISSION_WINDOW_MS = 10 * MINUTE;
const ADMIT_FREELY_BELOW = 0.75;
const STATS_INTERVAL_MS = 10 * MINUTE;

/** `<provider-id>:<sha256>` of every model a shown asset uses, per merged index. */
const servedModelsByIndex = new WeakMap<MergedIndex, ReadonlySet<string>>();

function servedModels(index: MergedIndex): ReadonlySet<string> {
  let served = servedModelsByIndex.get(index);
  if (!served) {
    const keys = new Set<string>();
    for (const assets of index.cells.values()) {
      for (const { providerId, asset } of assets) {
        keys.add(`${providerId}:${asset.lods.low.sha256}`);
        if (asset.lods.detail) keys.add(`${providerId}:${asset.lods.detail.sha256}`);
      }
    }
    served = keys;
    servedModelsByIndex.set(index, served);
  }
  return served;
}

type Reply = Parameters<RouteHandler>[1];
type Outcome = { kind: "ok"; gzip: Uint8Array } | { kind: "missing" } | { kind: "failed" };

class Busy extends Error {}

function sendError(reply: Reply, status: number, error: string, code: string, retryAfter?: number) {
  reply.header("Cache-Control", "no-store");
  if (retryAfter !== undefined) reply.header("Retry-After", String(retryAfter));
  reply.status(status).send({ error, code });
}

/**
 * Serves landmark GLBs to browsers so they never contact a provider's host.
 * Only models of assets the merged index shows can be requested, so hidden
 * assets and disallowed sources stay unreachable here too. Bodies are
 * verified by the provider, and process-wide limits keep one client from
 * turning the proxy into an upstream traffic amplifier.
 */
export function createModelProxy(
  ctx: IntegrationContext,
  source: LandmarkIndexSource,
  options: ModelProxyOptions = {},
): { handle: RouteHandler; stats(): ModelProxyStats; stop(): void } {
  const now = options.now ?? Date.now;
  const cacheBytes = options.cacheBytes ?? 96 * MIB;
  const maxConcurrent = options.maxConcurrent ?? 4;
  const maxQueue = options.maxQueue ?? 32;
  const maxBytesPerMinute = options.maxBytesPerMinute ?? 64 * MIB;
  const negativeTtlMs = options.negativeTtlMs ?? MINUTE;

  // In-process LRU of verified bodies, separate from the shared integration cache.
  const models = new Map<string, Uint8Array>();
  let cachedBytes = 0;
  const firstSeen = new Map<string, number>();
  const failedUntil = new Map<string, number>();
  const inFlight = new Map<string, Promise<Outcome>>();
  const waiting: (() => void)[] = [];
  let active = 0;
  let windowStart = now();
  let windowBytes = 0;
  const stats: ModelProxyStats = { hits: 0, misses: 0, upstreamBytes: 0, rejected: 0 };

  const statsTimer = setInterval(() => {
    if (stats.hits + stats.misses + stats.rejected === 0) return;
    ctx.log.info("Landmark model proxy", { ...stats, cachedBytes, entries: models.size });
  }, STATS_INTERVAL_MS);
  (statsTimer as { unref?: () => void }).unref?.();

  function readCache(key: string): Uint8Array | undefined {
    const hit = models.get(key);
    if (!hit) return undefined;
    models.delete(key);
    models.set(key, hit);
    return hit;
  }

  function admit(key: string, gzip: Uint8Array): void {
    if (gzip.byteLength > cacheBytes) return;
    const seen = firstSeen.get(key);
    const repeat = seen !== undefined && now() - seen <= ADMISSION_WINDOW_MS;
    if (!repeat && cachedBytes >= cacheBytes * ADMIT_FREELY_BELOW) {
      firstSeen.set(key, now());
      return;
    }
    firstSeen.delete(key);
    models.set(key, gzip);
    cachedBytes += gzip.byteLength;
    for (const [oldest, bytes] of models) {
      if (cachedBytes <= cacheBytes) break;
      models.delete(oldest);
      cachedBytes -= bytes.byteLength;
    }
  }

  async function acquireSlot(): Promise<void> {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    if (waiting.length >= maxQueue) throw new Busy();
    await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
  }

  function releaseSlot(): void {
    active -= 1;
    waiting.shift()?.();
  }

  function withinBudget(): boolean {
    if (now() - windowStart >= MINUTE) {
      windowStart = now();
      windowBytes = 0;
    }
    return windowBytes < maxBytesPerMinute;
  }

  async function fetchUpstream(provider: LandmarkModelProvider, sha256: string, key: string) {
    if (!withinBudget()) throw new Busy();
    await acquireSlot();
    try {
      const result = await provider.fetchModelGzip(sha256, AbortSignal.timeout(FETCH_TIMEOUT_MS));
      if (result.status !== "ok") return { kind: "missing" } as const;
      windowBytes += result.gzip.byteLength;
      stats.upstreamBytes += result.gzip.byteLength;
      admit(key, result.gzip);
      return { kind: "ok", gzip: result.gzip } as const;
    } catch (error) {
      if (error instanceof Busy) throw error;
      failedUntil.set(key, now() + negativeTtlMs);
      ctx.log.warn("Landmark model could not be fetched", { provider: provider.id, sha256 });
      return { kind: "failed" } as const;
    } finally {
      releaseSlot();
    }
  }

  function send(reply: Reply, gzip: Uint8Array, acceptsGzip: boolean): boolean {
    let body: Buffer;
    if (acceptsGzip) {
      body = Buffer.from(gzip);
    } else {
      try {
        body = gunzipSync(gzip, { maxOutputLength: MAX_MODEL_BYTES });
      } catch {
        return false;
      }
    }
    reply.header("Content-Type", "model/gltf-binary");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("Vary", "Accept-Encoding");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    if (acceptsGzip) reply.header("Content-Encoding", "gzip");
    reply.send(body);
    return true;
  }

  const handle: RouteHandler = async (req, reply) => {
    const { provider: providerId, sha256 } = req.params;
    if (!sha256 || !SHA256.test(sha256)) {
      sendError(reply, 400, "Model ids are lower-case sha256 hashes", "INVALID_MODEL_ID");
      return;
    }
    const provider = landmarkProviders(ctx).find((candidate) => candidate.id === providerId);
    if (!provider) {
      sendError(reply, 404, "Unknown landmark model", "UNKNOWN_MODEL");
      return;
    }
    if (!provider.snapshot()) {
      sendError(reply, 503, "Landmark catalogue is loading", "CATALOGUE_LOADING", 30);
      return;
    }
    if (!servedModels(await source.current()).has(`${provider.id}:${sha256}`)) {
      sendError(reply, 404, "Unknown landmark model", "UNKNOWN_MODEL");
      return;
    }
    const encoding = req.headers["accept-encoding"];
    const acceptsGzip = /\bgzip\b/.test(
      Array.isArray(encoding) ? encoding.join(",") : (encoding ?? ""),
    );
    const key = `${provider.id}:${sha256}`;

    const cached = readCache(key);
    if (cached) {
      stats.hits += 1;
      if (!send(reply, cached, acceptsGzip))
        sendError(reply, 502, "Model unavailable", "UPSTREAM_UNAVAILABLE");
      return;
    }
    const until = failedUntil.get(key);
    if (until !== undefined && now() < until) {
      sendError(reply, 502, "Model unavailable", "UPSTREAM_UNAVAILABLE");
      return;
    }
    stats.misses += 1;

    let pending = inFlight.get(key);
    if (!pending) {
      pending = fetchUpstream(provider, sha256, key).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    let outcome: Outcome;
    try {
      outcome = await pending;
    } catch (error) {
      if (!(error instanceof Busy)) throw error;
      stats.rejected += 1;
      sendError(reply, 503, "Too many landmark model requests", "BUSY", 5);
      return;
    }
    if (outcome.kind === "missing") {
      sendError(reply, 404, "Unknown landmark model", "UNKNOWN_MODEL");
      return;
    }
    if (outcome.kind === "failed" || !send(reply, outcome.gzip, acceptsGzip)) {
      sendError(reply, 502, "Model unavailable", "UPSTREAM_UNAVAILABLE");
    }
  };

  return {
    handle,
    stats: () => ({ ...stats }),
    stop: () => clearInterval(statsTimer),
  };
}
