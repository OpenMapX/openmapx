import type {
  QuotaDecision,
  UpstreamCacheRead,
  UpstreamRuntime,
} from "@openmapx/integration-framework";
import {
  type IntegrationContext,
  QueryValidationError,
  runWithProviderDeadline,
  scalarQuery,
} from "@openmapx/integration-framework";
import { projectLegacyStations } from "./compatibility.js";
import { createOpenAQClient, OpenAQClientError } from "./openaq-client.js";
import { createOpenAQProvider } from "./provider.js";

const SUNSET = "Mon, 01 Mar 2027 00:00:00 GMT";
const SUCCESSOR = '</api/integrations/air-quality/stations>; rel="successor-version"';
const MAX_BBOX_SPAN = 15;

// A missing distributed runtime may never turn into an ungoverned upstream call.
const unavailableRuntime: UpstreamRuntime = {
  async read<T>(): Promise<UpstreamCacheRead<T>> {
    return { state: "miss", diagnostic: "store_unavailable" };
  },
  async write(): Promise<void> {
    throw new Error("Distributed upstream runtime is unavailable");
  },
  async acquireLease(): Promise<null> {
    return null;
  },
  async releaseLease(): Promise<void> {},
  async consumeQuota(): Promise<QuotaDecision> {
    return { allowed: false, remaining: {}, retryAt: null, diagnostic: "store_unavailable" };
  },
};

function numberQuery(query: Parameters<typeof scalarQuery>[0], key: string): number {
  const raw = scalarQuery(query, key);
  if (raw === undefined || raw.trim() === "") throw new QueryValidationError(key, "is required");
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new QueryValidationError(key, "must be finite");
  return value;
}

export function parseLegacyBbox(query: Parameters<typeof scalarQuery>[0]): {
  south: number;
  west: number;
  north: number;
  east: number;
} {
  const south = numberQuery(query, "south");
  const west = numberQuery(query, "west");
  const north = numberQuery(query, "north");
  const east = numberQuery(query, "east");
  if (
    south < -90 ||
    north > 90 ||
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south >= north
  )
    throw new QueryValidationError("bbox", "is outside WGS84 bounds");
  const longitudeSpan = west <= east ? east - west : 180 - west + (east + 180);
  if (north - south > MAX_BBOX_SPAN || longitudeSpan > MAX_BBOX_SPAN)
    throw new QueryValidationError("bbox", "is too large");
  return { south, west, north, east };
}

function deprecationHeaders(reply: { header: (name: string, value: string) => void }): void {
  reply.header("Deprecation", "true");
  reply.header("Sunset", SUNSET);
  reply.header("Link", SUCCESSOR);
}

export function setup(ctx: IntegrationContext): void {
  const apiKey = ctx.config.openAqApiKey as string | undefined;
  const client = apiKey
    ? createOpenAQClient({
        http: ctx.http,
        upstreamRuntime: ctx.upstreamRuntime ?? unavailableRuntime,
        apiKey,
      })
    : null;
  const provider = client ? createOpenAQProvider(ctx, client) : null;
  if (provider) ctx.registerAirQualityProvider(provider);

  ctx.registerRoute("GET", "/air-quality/stations", async (req, reply) => {
    deprecationHeaders(reply);
    if (!provider) {
      reply.status(503).send({ message: "Air quality is not configured" });
      return;
    }

    let bbox: ReturnType<typeof parseLegacyBbox>;
    try {
      bbox = parseLegacyBbox(req.query);
    } catch (error) {
      if (error instanceof QueryValidationError) {
        reply.status(400).send({ message: "Invalid bbox coordinates" });
        return;
      }
      throw error;
    }

    const startedAt = Date.now();
    try {
      const page = await runWithProviderDeadline(
        (call) =>
          provider.getStations?.({ ...bbox, zoom: 8, pollutant: "pm25", limit: 100 }, call) ??
          Promise.resolve({
            evidence: [],
            nextCursor: null,
            truncated: false,
            diagnostics: {
              candidateCount: 0,
              servedCount: 0,
              skippedCount: 0,
              quotaDeniedCount: 0,
              failureCount: 0,
            },
          }),
        { signal: req.signal, timeoutMs: provider.timeoutMs ?? 3_000 },
      );
      const stations = projectLegacyStations(page.evidence);
      const quotaTruncated = page.diagnostics.quotaDeniedCount > 0;
      if (quotaTruncated) reply.header("X-OpenMapX-Air-Quality-Status", "quota-truncated");
      else if (page.diagnostics.failureCount > 0)
        reply.header("X-OpenMapX-Air-Quality-Status", "upstream-unavailable");
      else if (page.truncated) reply.header("X-OpenMapX-Air-Quality-Status", "coverage-truncated");
      ctx.metricsRecorder?.recordAirQuality?.({
        method: "stations",
        outcome: page.truncated ? "partial" : stations.length > 0 ? "ok" : "empty",
        cacheResult: "bypass",
        headlineClass: stations.length > 0 ? "raw-ground" : "none",
        rejectionCode: quotaTruncated ? "quota" : "none",
        compatibilityUse: "legacy-openaq",
        quotaTruncated,
        evidenceCount: page.evidence.length,
        latencyMs: Date.now() - startedAt,
      });
      reply.send(stations);
    } catch (error) {
      const quota = error instanceof OpenAQClientError && error.code === "quota_exhausted";
      ctx.metricsRecorder?.recordAirQuality?.({
        method: "stations",
        outcome: quota ? "unavailable" : "error",
        cacheResult: "miss",
        headlineClass: "none",
        rejectionCode: quota ? "quota" : "none",
        compatibilityUse: "legacy-openaq",
        quotaTruncated: quota,
        evidenceCount: 0,
        latencyMs: Date.now() - startedAt,
      });
      reply.status(quota ? 429 : 502).send({
        message: quota
          ? "Air quality request quota is exhausted"
          : "Upstream air quality API error",
      });
    }
  });
}
