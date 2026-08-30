import type { AirQualityProvider, IntegrationContext } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setup } from "../index.js";
import { evidence, fakeReply, integration } from "./fixtures.js";

const now = "2026-08-30T12:00:00.000Z";

function context(getForecast: AirQualityProvider["getForecast"]) {
  const provider: AirQualityProvider = {
    id: "fixture-provider",
    sourceIds: ["fixture-source"],
    priority: 10,
    capabilities: new Set(["forecast", "pollutants"]),
    coverage: { bbox: [-180, -90, 180, 90] },
    getForecast,
  };
  const ctx = createMockIntegrationContext({ id: "air-quality" });
  Object.assign(ctx, { getIntegrationsByDomain: () => [integration(provider)] });
  return ctx as typeof ctx & IntegrationContext;
}

afterEach(() => vi.useRealTimers());

describe("canonical forecast route", () => {
  it("groups provider-declared intervals into stable frames and series", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ctx = context(async () => [
      evidence({ at: now, forecast: true, value: 55 }),
      evidence({ at: "2026-08-30T13:00:00.000Z", forecast: true, value: 40 }),
    ]);
    setup(ctx);
    const handler = ctx.registered.routes.find(({ path }) => path === "/forecast")?.handler;
    if (!handler) throw new Error("forecast route missing");
    const output = fakeReply();
    await handler(
      {
        query: { lat: "52.52", lng: "13.405", hours: "2" },
        params: {},
        body: undefined,
        headers: {},
      },
      output.reply,
    );

    expect(output.state.statusCode).toBe(200);
    expect(output.state.payload).toMatchObject({
      status: "ok",
      window: { startAt: now, endAt: "2026-08-30T14:00:00.000Z", requestedHours: 2 },
      evidence: [{ forecastFor: now }, { forecastFor: "2026-08-30T13:00:00.000Z" }],
      series: [{ providerId: "fixture-provider", evidenceIds: expect.any(Array) }],
      frames: [
        { frameAt: now, status: "ok", primary: { indexId: expect.stringMatching(/^idx_1_/) } },
        {
          frameAt: "2026-08-30T13:00:00.000Z",
          status: "ok",
          primary: { indexId: expect.stringMatching(/^idx_1_/) },
        },
      ],
    });
  });

  it("marks provider failures unavailable without inventing frames", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ctx = context(async () => {
      throw new Error("offline");
    });
    setup(ctx);
    const handler = ctx.registered.routes.find(({ path }) => path === "/forecast")?.handler;
    const output = fakeReply();
    await handler?.(
      {
        query: { lat: "52.52", lng: "13.405", hours: "2" },
        params: {},
        body: undefined,
        headers: {},
      },
      output.reply,
    );
    expect(output.state.payload).toMatchObject({
      status: "unavailable",
      evidence: [],
      frames: [{ frameAt: now, status: "unavailable", primary: null }],
      meta: { warnings: ["partial_providers"] },
    });
  });

  it("marks a frame partial when it contains valid secondary evidence but no headline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const secondary = evidence({
      at: now,
      forecast: true,
      providerId: "eccc-aqhi",
      sourceId: "eccc-aqhi-geomet",
      spatialId: "ECCC-FCWYG",
    });
    secondary.series = [];
    secondary.publishedIndices = [
      {
        indexId: "idx_1_1234567890123456789012345678901234567890123",
        methodId: "eccc-geomet-aqhi-forecast-method-unspecified",
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
    const ctx = context(async () => [secondary]);
    setup(ctx);
    const handler = ctx.registered.routes.find(({ path }) => path === "/forecast")?.handler;
    const output = fakeReply();
    await handler?.(
      {
        query: { lat: "43.67", lng: "-79.39", hours: "2", country: "CA" },
        params: {},
        body: undefined,
        headers: {},
      },
      output.reply,
    );

    expect(output.state.payload).toMatchObject({
      status: "partial",
      evidence: [{ spatial: { coversRequestedPoint: false } }],
      frames: [{ frameAt: now, status: "partial", primary: null }],
    });
  });
});
