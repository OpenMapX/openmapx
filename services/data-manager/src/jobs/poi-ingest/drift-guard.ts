import { createHash } from "node:crypto";
import { getAllPoiSources } from "@openmapx/poi-source-registry";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_000;

export interface DriftLogger {
  warn(msg: string, extra?: Record<string, unknown>): void;
}

export interface UpstreamCount {
  count: number;
  hash: string;
}

export type DriftStatus = boolean | "unknown";

export interface DriftCheckResult {
  /** true=match, false=drift, "unknown"=could not reach apps/api. */
  registryCountMatchesUpstream: DriftStatus;
  local: { count: number; hash: string };
  upstream: UpstreamCount | null;
  /** Free-text reason when status is "unknown" or false. */
  reason?: string;
}

export interface DriftGuardOptions {
  /** apps/api base URL — typically http://app-api:3001 in compose. */
  appApiBaseUrl: string;
  /** Optional cache override (ms). Default 60s. */
  cacheTtlMs?: number;
  /** Test seam: replace fetch. */
  fetch?: typeof fetch;
  logger?: DriftLogger;
}

interface CacheEntry {
  at: number;
  value: UpstreamCount | null;
}

export interface DriftGuard {
  check(): Promise<DriftCheckResult>;
  /** Test seam: empty the cache. */
  __clearCache(): void;
}

function localSnapshot(): { count: number; hash: string } {
  const ids = getAllPoiSources()
    .map((s) => s.id)
    .sort();
  const hash = createHash("sha256").update(ids.join("\n")).digest("hex");
  return { count: ids.length, hash };
}

export function createDriftGuard(opts: DriftGuardOptions): DriftGuard {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  let cache: CacheEntry | null = null;

  async function loadUpstream(): Promise<UpstreamCount | null> {
    if (cache && Date.now() - cache.at < ttl) return cache.value;
    const url = `${opts.appApiBaseUrl.replace(/\/$/, "")}/api/internal/poi-sources/count`;
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        opts.logger?.warn("poi-drift-guard: upstream returned non-2xx", {
          url,
          status: res.status,
        });
        cache = { at: Date.now(), value: null };
        return null;
      }
      const body = (await res.json()) as { count?: unknown; hash?: unknown };
      if (typeof body.count !== "number" || typeof body.hash !== "string") {
        opts.logger?.warn("poi-drift-guard: upstream payload malformed", { url, body });
        cache = { at: Date.now(), value: null };
        return null;
      }
      const value: UpstreamCount = { count: body.count, hash: body.hash };
      cache = { at: Date.now(), value };
      return value;
    } catch (err) {
      opts.logger?.warn("poi-drift-guard: upstream fetch failed", {
        url,
        err: (err as Error).message,
      });
      cache = { at: Date.now(), value: null };
      return null;
    }
  }

  async function check(): Promise<DriftCheckResult> {
    const local = localSnapshot();
    const upstream = await loadUpstream();
    if (upstream === null) {
      return {
        registryCountMatchesUpstream: "unknown",
        local,
        upstream: null,
        reason: "apps/api unreachable",
      };
    }
    if (local.hash === upstream.hash) {
      return { registryCountMatchesUpstream: true, local, upstream };
    }
    return {
      registryCountMatchesUpstream: false,
      local,
      upstream,
      reason:
        local.count !== upstream.count
          ? `count differs (local=${local.count}, upstream=${upstream.count})`
          : "same count but different source ids",
    };
  }

  return {
    check,
    __clearCache(): void {
      cache = null;
    },
  };
}
