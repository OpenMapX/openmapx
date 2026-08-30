import type {
  AirQualityProvider,
  IntegrationContext,
  ProviderHealthSnapshot,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryUpstreamRuntime } from "../../overlay-air-quality/test-helpers.js";
import { setup } from "../index.js";
import { evidence, fakeReply, integration } from "./fixtures.js";

const now = "2026-08-30T12:00:00.000Z";

function provider(getCurrent: AirQualityProvider["getCurrent"]): AirQualityProvider {
  return {
    id: "fixture-provider",
    sourceIds: ["fixture-source"],
    priority: 10,
    capabilities: new Set(["current", "pollutants"]),
    coverage: { bbox: [-180, -90, 180, 90] },
    getCurrent,
  };
}

function context(value: AirQualityProvider) {
  const ctx = createMockIntegrationContext({ id: "air-quality" });
  Object.assign(ctx, { getIntegrationsByDomain: () => [integration(value)] });
  return ctx as typeof ctx & IntegrationContext;
}

async function invoke(ctx: ReturnType<typeof context>, query: Record<string, string>) {
  setup(ctx);
  const handler = ctx.registered.routes.find(({ path }) => path === "/current")?.handler;
  if (!handler) throw new Error("current route missing");
  const output = fakeReply();
  await handler({ query, params: {}, body: undefined, headers: {} }, output.reply);
  return output.state;
}

afterEach(() => vi.useRealTimers());

describe("canonical current route", () => {
  it("returns deterministic evidence and a local computed index", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const result = await invoke(context(provider(async () => [evidence({ at: now, value: 55 })])), {
      lat: "52.52",
      lng: "13.405",
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers["Cache-Control"]).toBe("private, max-age=0");
    expect(result.payload).toMatchObject({
      status: "ok",
      jurisdiction: { countryCode: "DE", localStandardId: "eu-eea-current" },
      primaryEvidenceId: expect.stringMatching(/^obs_1_/),
      primaryIndexId: expect.stringMatching(/^idx_1_/),
      evidence: [{ sources: [{ sourceId: "fixture-source" }] }],
      meta: { providersCandidate: ["fixture-provider"], providersServed: ["fixture-provider"] },
    });
  });

  it("marks secondary-only evidence partial, including when that evidence is stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const secondary = evidence({
      at: "2026-08-30T09:00:00.000Z",
      providerId: "eccc-aqhi",
      sourceId: "eccc-aqhi-geomet",
      spatialId: "ECCC-FCWYG",
    });
    secondary.series = [];
    secondary.publishedIndices = [
      {
        indexId: "idx_1_1234567890123456789012345678901234567890123",
        methodId: "eccc-geomet-aqhi-observation-method-unspecified",
        methodRevision: "eccc-geomet-aqhi-collections-2026-08-30",
        claimedStandardId: null,
        value: 2.7,
        displayValue: "2.7",
        categoryId: "eccc-published-aqhi-method-unspecified",
        dominantPollutants: [],
      },
    ];
    secondary.spatial = {
      kind: "community",
      id: "ECCC-FCWYG",
      name: "Toronto Downtown",
      coordinates: [-79.3969444, 43.6758333],
      timeZone: null,
      distanceMeters: 1_200,
      stationClass: null,
      mobile: null,
      coversRequestedPoint: false,
      coverageMethod: "nearest-community",
    };

    const result = await invoke(context(provider(async () => [secondary])), {
      lat: "43.67",
      lng: "-79.39",
      country: "CA",
    });

    expect(result.payload).toMatchObject({
      status: "partial",
      primaryEvidenceId: null,
      primaryIndexId: null,
      evidence: [{ freshness: "stale" }],
      meta: { warnings: expect.arrayContaining(["stale_evidence"]) },
    });
  });

  it("uses HTTP 200 unavailable for valid no-data and reports policy exclusion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ctx = context(provider(async () => []));
    Object.assign(ctx, {
      getDisallowedSourceIds: async () => new Set(["fixture-source"]),
    });
    const result = await invoke(ctx, { lat: "52.52", lng: "13.405" });
    expect(result.statusCode).toBe(200);
    expect(result.payload).toMatchObject({
      status: "unavailable",
      primaryEvidenceId: null,
      primaryIndexId: null,
      evidence: [],
      meta: {
        providersPolicyExcluded: ["fixture-provider"],
        warnings: ["policy_excluded"],
      },
    });
  });

  it("returns closed exact errors for invalid input and disabled domain", async () => {
    const invalid = await invoke(context(provider(async () => [])), { lat: "NaN", lng: "0" });
    expect(invalid).toMatchObject({
      statusCode: 400,
      payload: { code: "INVALID_QUERY", details: { parameter: "lat" } },
    });
    const ctx = context(provider(async () => []));
    Object.assign(ctx, { config: { enabled: false } });
    const disabled = await invoke(ctx, { lat: "0", lng: "0" });
    expect(disabled).toMatchObject({
      statusCode: 503,
      payload: { code: "DOMAIN_DISABLED" },
    });
  });

  it("reselects cached evidence and reports stale-if-error without changing its timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let fail = false;
    const call = vi.fn(async () => {
      if (fail) throw new Error("offline");
      return [evidence({ at: now, value: 55 })];
    });
    let runtimeNow = Date.parse(now);
    const ctx = context(provider(call));
    Object.assign(ctx, { upstreamRuntime: new MemoryUpstreamRuntime(() => runtimeNow) });
    const first = await invoke(ctx, { lat: "52.52", lng: "13.405" });
    expect(first.payload).toMatchObject({ meta: { cache: "miss" } });

    fail = true;
    const fresh = await invoke(ctx, { lat: "52.52", lng: "13.405" });
    expect(fresh.payload).toMatchObject({ status: "ok", meta: { cache: "fresh" } });
    expect(call).toHaveBeenCalledTimes(1);

    runtimeNow += 20 * 60_000;
    vi.setSystemTime(runtimeNow);
    const stale = await invoke(ctx, { lat: "52.52", lng: "13.405" });
    expect(stale.payload).toMatchObject({
      status: "partial",
      evidence: [{ observedAt: now, freshness: "fresh" }],
      meta: {
        cache: "stale",
        warnings: expect.arrayContaining(["stale_cache", "partial_providers"]),
      },
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("reuses a fresh point response when the provider circuit opens after caching", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const call = vi.fn(async () => [evidence({ at: now, value: 55 })]);
    const ctx = context(provider(call));
    let circuitOpen = false;
    const snapshot = (): ProviderHealthSnapshot => ({
      state: circuitOpen ? "open" : "healthy",
      successCount: 0,
      failureCount: 0,
      countedFailureCount: 0,
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      windowFailureRate: null,
      emaLatencyMs: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureOutcome: null,
      lastOperatorMessage: null,
      retryAt: null,
      ownsHalfOpenProbe: false,
    });
    Object.assign(ctx, {
      upstreamRuntime: new MemoryUpstreamRuntime(() => Date.parse(now)),
      providerHealth: {
        getSnapshot: vi.fn(async () => snapshot()),
        recordSuccess: vi.fn(async () => undefined),
        recordFailure: vi.fn(async () => undefined),
      },
    });

    const first = await invoke(ctx, { lat: "52.52", lng: "13.405" });
    circuitOpen = true;
    const cached = await invoke(ctx, { lat: "52.52", lng: "13.405" });

    expect(call).toHaveBeenCalledTimes(1);
    expect(first.payload).toMatchObject({ status: "ok", meta: { cache: "miss" } });
    expect(cached.payload).toMatchObject({
      status: "partial",
      primaryEvidenceId: expect.stringMatching(/^obs_1_/),
      meta: {
        cache: "fresh",
        providersFailed: [{ providerId: "fixture-provider", code: "provider_unhealthy" }],
        warnings: expect.arrayContaining(["partial_providers"]),
      },
    });
    expect(cached.payload).not.toMatchObject({ meta: { warnings: ["stale_cache"] } });
  });
});
