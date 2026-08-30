import type { UpstreamCacheTtl, UpstreamRuntime } from "@openmapx/integration-framework";

export const OPENAQ_METADATA_TTL: UpstreamCacheTtl = {
  softMs: 6 * 60 * 60 * 1_000,
  hardMs: 24 * 60 * 60 * 1_000,
  staleIfErrorMs: 7 * 24 * 60 * 60 * 1_000,
};

export const OPENAQ_SERIES_TTL: UpstreamCacheTtl = {
  softMs: 10 * 60 * 1_000,
  hardMs: 30 * 60 * 1_000,
  staleIfErrorMs: 3 * 60 * 60 * 1_000,
};

export type OpenAQCacheState = "fresh" | "stale" | "stale-if-error" | "miss";

export class OpenAQCacheUnavailableError extends Error {
  readonly code = "quota_exhausted";

  constructor() {
    super("Distributed OpenAQ cache/lease runtime is unavailable");
    this.name = "OpenAQCacheUnavailableError";
  }
}

export async function loadOpenAQCached<T>(input: {
  runtime: UpstreamRuntime;
  key: string;
  ttl: UpstreamCacheTtl;
  signal: AbortSignal;
  refresh: () => Promise<T>;
}): Promise<{ value: T; state: OpenAQCacheState }> {
  const cached = await input.runtime.read<T>(input.key);
  if (cached.state === "fresh") return { value: cached.value, state: "fresh" };
  if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");

  const leaseKey = `refresh:${input.key}`;
  const lease = await input.runtime.acquireLease(leaseKey, 15_000);
  if (!lease) {
    if (cached.state !== "miss") return { value: cached.value, state: cached.state };
    throw new OpenAQCacheUnavailableError();
  }

  const refreshWithLease = async (): Promise<T> => {
    try {
      if (input.signal.aborted)
        throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
      const value = await input.refresh();
      if (input.signal.aborted)
        throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
      await input.runtime.write(input.key, value, input.ttl);
      return value;
    } finally {
      await input.runtime.releaseLease(leaseKey, lease.token);
    }
  };

  if (cached.state === "stale") {
    // Serve soft-stale evidence immediately. The lease ensures only one process refreshes.
    void refreshWithLease().catch(() => undefined);
    return { value: cached.value, state: "stale" };
  }

  try {
    const value = await refreshWithLease();
    return { value, state: "miss" };
  } catch (error) {
    if (cached.state !== "miss") return { value: cached.value, state: "stale-if-error" };
    throw error;
  }
}
