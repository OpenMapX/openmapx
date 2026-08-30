import { cpus } from "node:os";
import { setup } from "../integrations/air-quality/index.js";
import { MemoryUpstreamRuntime } from "../integrations/overlay-air-quality/test-helpers.js";
import { observationId } from "../packages/air-quality/src/ids.js";
import type { ProviderEvidence } from "../packages/air-quality/src/index.js";
import type {
  AirQualityProvider,
  IntegrationContext,
  LoadedIntegration,
  RouteHandler,
} from "../packages/integration-framework/src/index.js";
import { createMockIntegrationContext } from "../packages/integration-framework/src/testing/index.js";

const MAXIMUM_JSON_BYTES = 2 * 1_024 * 1_024;

export interface BenchmarkResult {
  name: string;
  samples: number;
  concurrency: number;
  p50Ms: number;
  p95Ms: number;
  maximumMs: number;
  maximumPayloadBytes: number;
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new RangeError("Cannot calculate a percentile without samples");
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1)
    throw new RangeError("Percentile quantile must be between zero and one");
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[rank] ?? sorted[sorted.length - 1] ?? 0;
}

export async function runBenchmark(input: {
  name: string;
  requests: number;
  warmups: number;
  concurrency: number;
  maximumPayloadBytes?: number;
  inject: () => Promise<{ statusCode: number; payloadBytes: number }>;
}): Promise<BenchmarkResult> {
  for (const [name, value, minimum] of [
    ["requests", input.requests, 1],
    ["warmups", input.warmups, 0],
    ["concurrency", input.concurrency, 1],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum) throw new RangeError(`${name} is invalid`);
  }
  const payloadLimit = input.maximumPayloadBytes ?? MAXIMUM_JSON_BYTES;
  const validate = (response: { statusCode: number; payloadBytes: number }) => {
    if (response.statusCode !== 200)
      throw new Error(`${input.name} returned unexpected status ${response.statusCode}`);
    if (response.payloadBytes > payloadLimit)
      throw new Error(
        `${input.name} exceeded payload limit: ${response.payloadBytes} > ${payloadLimit}`,
      );
    return response;
  };
  for (let index = 0; index < input.warmups; index += 1) validate(await input.inject());

  const durations = Array<number>(input.requests);
  const payloads = Array<number>(input.requests);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(input.concurrency, input.requests) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= input.requests) return;
        const startedAt = performance.now();
        const response = validate(await input.inject());
        durations[index] = performance.now() - startedAt;
        payloads[index] = response.payloadBytes;
      }
    }),
  );
  return {
    name: input.name,
    samples: durations.length,
    concurrency: input.concurrency,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maximumMs: Math.max(...durations),
    maximumPayloadBytes: Math.max(...payloads),
  };
}

function fixtureEvidence(at: string, forecast = false): ProviderEvidence {
  const spatialSupportId = "benchmark-station";
  const id = observationId({
    sourceId: "benchmark-source",
    originRecordId: `${spatialSupportId}:${at}:${forecast}`,
    spatialSupportId,
    modelRunId: null,
    evaluatedAt: at,
  });
  return {
    observationId: id,
    providerId: "benchmark-provider",
    sourceIds: ["benchmark-source"],
    dataAuthority: "official-agency",
    qualityStatus: "preliminary",
    basis: "ground",
    originRecords: [{ sourceId: "benchmark-source", recordId: `${spatialSupportId}:${at}` }],
    modelRunId: null,
    verticalLevel: null,
    series: (["pm25", "no2", "o3"] as const).map((pollutant) => ({
      seriesId: `${spatialSupportId}:${pollutant}:${at}`,
      coherenceKey: spatialSupportId,
      pollutant,
      sensorId: `${spatialSupportId}:${pollutant}`,
      spatialSupportId,
      cadenceMinutes: 60,
      originalUnit: "µg/m³",
      samples: Array.from({ length: 24 }, (_, index) => {
        const end = Date.parse(at) - index * 3_600_000;
        return {
          startAt: new Date(end - 3_600_000).toISOString(),
          endAt: new Date(end).toISOString(),
          value: 12,
          unit: "ug/m3" as const,
          valid: true,
          estimated: false,
          gapFilled: false,
        };
      }),
    })),
    publishedIndices: [],
    observedAt: forecast ? null : at,
    forecastFor: forecast ? at : null,
    publishedAt: null,
    validUntil: new Date(Date.parse(at) + 3_600_000).toISOString(),
    spatial: {
      kind: "station",
      id: spatialSupportId,
      name: "Benchmark station",
      coordinates: [13.405, 52.52],
      timeZone: "Europe/Berlin",
      distanceMeters: 500,
      stationClass: "reference",
      mobile: false,
      coversRequestedPoint: true,
      coverageMethod: "nearest-station",
    },
    sources: [
      {
        sourceId: "benchmark-source",
        name: "Deterministic benchmark fixture",
        url: null,
        owner: "OpenMapX",
        license: null,
        methodologyUrl: null,
        attribution: "OpenMapX benchmark fixture",
      },
    ],
  };
}

function fixtureIntegration(provider: AirQualityProvider): LoadedIntegration {
  return {
    id: "benchmark-provider-integration",
    manifest: {
      id: "benchmark-provider-integration",
      version: "1.0.0",
      domains: ["air-quality"],
      dataSources: [{ sourceId: "benchmark-source", name: "Benchmark", url: null }],
    } as LoadedIntegration["manifest"],
    config: {},
    directory: "/benchmark",
    isBuiltIn: true,
    enabled: true,
    providers: new Map([["air-quality", [provider]]]),
    strings: {},
    shutdownHandlers: [],
  };
}

function replyCapture() {
  const state: { statusCode: number; payload: unknown } = { statusCode: 200, payload: null };
  const reply = {
    send(payload: unknown) {
      state.payload = payload;
    },
    status(statusCode: number) {
      state.statusCode = statusCode;
      return { send: (payload: unknown) => (state.payload = payload) };
    },
    header() {},
    type() {},
  } as unknown as Parameters<RouteHandler>[1];
  return { state, reply };
}

function createCanonicalInjector() {
  const now = Date.now();
  const currentAt = new Date(now).toISOString();
  const provider: AirQualityProvider = {
    id: "benchmark-provider",
    sourceIds: ["benchmark-source"],
    priority: 1,
    capabilities: new Set(["current", "forecast", "stations", "pollutants"]),
    coverage: { bbox: [-180, -90, 180, 90] },
    async getCurrent() {
      return [fixtureEvidence(currentAt)];
    },
    async getForecast(query) {
      return Array.from({ length: Math.min(query.hours, 24) }, (_, index) =>
        fixtureEvidence(
          new Date(Date.parse(query.evaluatedAt) + index * 3_600_000).toISOString(),
          true,
        ),
      );
    },
    async getStations() {
      return {
        evidence: [fixtureEvidence(currentAt)],
        nextCursor: null,
        truncated: false,
        diagnostics: {
          candidateCount: 1,
          servedCount: 1,
          skippedCount: 0,
          quotaDeniedCount: 0,
          failureCount: 0,
        },
      };
    },
  };
  const ctx = createMockIntegrationContext({ id: "air-quality" });
  Object.assign(ctx, {
    getIntegrationsByDomain: () => [fixtureIntegration(provider)],
    upstreamRuntime: new MemoryUpstreamRuntime(() => now),
  });
  setup(ctx as typeof ctx & IntegrationContext);
  const routes = new Map(ctx.registered.routes.map((route) => [route.path, route.handler]));
  return async (path: "/current" | "/forecast" | "/stations") => {
    const handler = routes.get(path);
    if (!handler) throw new Error(`Missing benchmark route ${path}`);
    const query =
      path === "/stations"
        ? { south: "52", west: "13", north: "53", east: "14", zoom: "8", pollutant: "pm25" }
        : {
            lat: "52.52",
            lng: "13.405",
            countryCode: "DE",
            ...(path === "/forecast" ? { hours: "24" } : {}),
          };
    const output = replyCapture();
    await handler({ query, params: {}, body: undefined, headers: {} }, output.reply);
    return {
      statusCode: output.state.statusCode,
      payloadBytes: Buffer.byteLength(JSON.stringify(output.state.payload)),
    };
  };
}

async function main(): Promise<void> {
  const inject = createCanonicalInjector();
  const results = [
    await runBenchmark({
      name: "cached-current",
      requests: 1_000,
      warmups: 20,
      concurrency: 20,
      inject: () => inject("/current"),
    }),
    await runBenchmark({
      name: "forecast-24h",
      requests: 100,
      warmups: 5,
      concurrency: 10,
      inject: () => inject("/forecast"),
    }),
    await runBenchmark({
      name: "stations-page",
      requests: 100,
      warmups: 5,
      concurrency: 10,
      inject: () => inject("/stations"),
    }),
  ];
  const current = results[0];
  if (!current || current.p95Ms >= 250)
    throw new Error(`Cached current p95 gate failed: ${current?.p95Ms ?? "missing"} ms`);
  console.log(
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        environment: {
          node: process.version,
          cpu: cpus()[0]?.model ?? "unknown",
          runtime: "in-process canonical route handlers with warm MemoryUpstreamRuntime",
          schemaRevision: "canonical-air-quality-v1",
        },
        thresholds: { cachedCurrentP95Ms: 250, maximumJsonBytes: MAXIMUM_JSON_BYTES },
        results,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1]?.endsWith("bench-air-quality.ts")) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
