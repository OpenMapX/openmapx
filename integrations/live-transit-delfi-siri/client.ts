import { randomUUID } from "node:crypto";
import type { IntegrationContext, UpstreamRuntime } from "@openmapx/integration-framework";
import { SOURCE_ID } from "./match";
import { MAX_BYTES, parseSiriEt, type SiriJourney } from "./siri-et-stream";

export const FEED_URL =
  "https://stc.traines.eu/mirror/german-delfi-siri/rhein-ruhr/latest-rhein-ruhr.siri.xml";
const PREFIX = "delfi-siri:rhein-ruhr";
const MANIFEST = `${PREFIX}:manifest`;
const LEASE = `${PREFIX}:refresh`;
const TTL = { softMs: 300_000, hardMs: 600_000, staleIfErrorMs: 600_000 };
interface Manifest {
  generation: string;
  fetchedAt: string;
  responseTimestamp: string;
  etag?: string;
  lastModified?: string;
  journeyCount: number;
}

function bucket(date: string, number: string) {
  let hash = 2166136261;
  for (const c of `${date}|${number}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  return hash % 64;
}
const key = (generation: string, index: number) => `${PREFIX}:${generation}:b${index}`;
function usable(value: Manifest, now: number) {
  return (
    /^[a-f0-9-]{36}$/.test(value.generation) &&
    Number.isFinite(Date.parse(value.responseTimestamp)) &&
    now - Date.parse(value.responseTimestamp) <= 1_800_000 &&
    Date.parse(value.responseTimestamp) <= now + 120_000
  );
}

/** Bulk acquisition is detached from journey latency and fail-closed on shared-store failure. */
export function createSiriClient(ctx: IntegrationContext, now: () => number = Date.now) {
  const runtime = ctx.upstreamRuntime;
  const allowed = async () => !(await ctx.getDisallowedSourceIds?.())?.has(SOURCE_ID);
  let flight: Promise<void> | undefined;
  let stopped = false;
  const abort = new AbortController();
  ctx.onShutdown(async () => {
    stopped = true;
    abort.abort();
    await flight?.catch(() => {});
  });

  async function manifest(store: UpstreamRuntime) {
    const cached = await store.read<Manifest>(MANIFEST, now());
    return cached.state !== "miss" &&
      cached.state !== "stale-if-error" &&
      usable(cached.value, now())
      ? cached
      : undefined;
  }
  async function runRefresh() {
    if (!runtime || stopped || !(await allowed())) return;
    const lease = await runtime.acquireLease(LEASE, 60_000);
    if (!lease) return;
    try {
      const previous = await manifest(runtime);
      if (previous?.state === "fresh") return;
      const quota = await runtime.consumeQuota({
        bucket: PREFIX,
        cost: 1,
        windows: [
          { id: "4m", limit: 1, durationMs: 240_000 },
          { id: "1h", limit: 15, durationMs: 3_600_000 },
        ],
      });
      if (!quota.allowed || stopped || !(await allowed())) return;
      const response = await ctx.http.getStream(FEED_URL, {
        maxBytes: MAX_BYTES,
        contentTypes: ["text/xml", "application/xml"],
        timeoutMs: 30_000,
        signal: abort.signal,
        redirect: "error",
        discardErrorBody: true,
        headers: {
          "User-Agent": "OpenMapX/1.0 (+https://openmapx.org)",
          ...(previous?.value.etag ? { "If-None-Match": previous.value.etag } : {}),
          ...(previous?.value.lastModified
            ? { "If-Modified-Since": previous.value.lastModified }
            : {}),
        },
        responseHeaders: ["etag", "last-modified"],
      });
      let groups: SiriJourney[][];
      let responseTimestamp: string;
      if (response.status === 304 && previous) {
        await response.stream.cancel();
        const old = await Promise.all(
          Array.from({ length: 64 }, (_, i) =>
            runtime.read<SiriJourney[]>(key(previous.value.generation, i), now()),
          ),
        );
        if (old.some((b) => b.state === "miss" || b.state === "stale-if-error")) return;
        groups = old.map((b) => (b.state === "miss" ? [] : b.value));
        responseTimestamp = previous.value.responseTimestamp;
      } else {
        if (response.status !== 200) {
          await response.stream.cancel();
          throw new Error("SIRI feed unavailable");
        }
        const parsed = await parseSiriEt(response.stream, now());
        responseTimestamp = parsed.responseTimestamp;
        groups = Array.from({ length: 64 }, () => []);
        for (const record of parsed.journeys)
          groups[bucket(record.serviceDate, record.trainNumber)].push(record);
      }
      if (stopped || !(await allowed()) || now() - Date.parse(responseTimestamp) > 1_800_000)
        return;
      const generation = randomUUID();
      // Publish only after every bucket exists. Readers pin one generation.
      for (let i = 0; i < 64; i++) {
        if (stopped || !(await allowed())) return;
        await runtime.write(key(generation, i), groups[i], {
          ...TTL,
          hardMs: TTL.hardMs + 60_000,
          staleIfErrorMs: TTL.hardMs + 60_000,
        });
      }
      if (stopped || !(await allowed())) return;
      await runtime.write(
        MANIFEST,
        {
          generation,
          fetchedAt: new Date(now()).toISOString(),
          responseTimestamp,
          journeyCount: groups.reduce((sum, g) => sum + g.length, 0),
          etag:
            response.headers.etag ?? (response.status === 304 ? previous?.value.etag : undefined),
          lastModified:
            response.headers["last-modified"] ??
            (response.status === 304 ? previous?.value.lastModified : undefined),
        } satisfies Manifest,
        TTL,
      );
    } finally {
      await runtime.releaseLease(LEASE, lease.token);
    }
  }
  function refresh() {
    if (!flight)
      flight = runRefresh().finally(() => {
        flight = undefined;
      });
    return flight;
  }
  return {
    refresh,
    async get(
      serviceDate: string,
      trainNumber: string,
    ): Promise<{ records: SiriJourney[]; fetchedAt: string } | undefined> {
      if (!runtime || stopped || !(await allowed())) return;
      try {
        const current = await manifest(runtime);
        if (current?.state !== "fresh")
          void refresh().catch(() => ctx.log.warn("DELFI SIRI refresh unavailable"));
        if (!current) return;
        const cached = await runtime.read<SiriJourney[]>(
          key(current.value.generation, bucket(serviceDate, trainNumber)),
          now(),
        );
        if (
          cached.state === "miss" ||
          cached.state === "stale-if-error" ||
          stopped ||
          !(await allowed())
        )
          return;
        return { records: cached.value, fetchedAt: current.value.fetchedAt };
      } catch {
        return;
      }
    },
  };
}
