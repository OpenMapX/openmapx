import type { AirQualityProvider, IntegrationContext } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpaqueCursorCodec } from "../../../apps/api/src/services/opaque-cursor.js";
import { MemoryUpstreamRuntime } from "../../overlay-air-quality/test-helpers.js";
import { setup } from "../index.js";
import { webMercatorCell } from "../stations.js";
import { evidence, fakeReply, integration } from "./fixtures.js";

const now = "2026-08-30T12:00:00.000Z";

function context(getStations: AirQualityProvider["getStations"]) {
  const provider: AirQualityProvider = {
    id: "fixture-provider",
    sourceIds: ["fixture-source"],
    priority: 10,
    capabilities: new Set(["stations", "pollutants"]),
    coverage: { bbox: [-180, -90, 180, 90] },
    getStations,
  };
  const ctx = createMockIntegrationContext({ id: "air-quality" });
  Object.assign(ctx, {
    getIntegrationsByDomain: () => [integration(provider)],
    upstreamRuntime: new MemoryUpstreamRuntime(),
    cursorCodec: createOpaqueCursorCodec("a".repeat(32), () => Date.parse(now)),
  });
  return ctx as typeof ctx & IntegrationContext;
}

async function invoke(ctx: ReturnType<typeof context>, query: Record<string, string>) {
  const handler = ctx.registered.routes.find(({ path }) => path === "/stations")?.handler;
  if (!handler) throw new Error("stations route missing");
  const output = fakeReply();
  await handler({ query, params: {}, body: undefined, headers: {} }, output.reply);
  return output.state;
}

afterEach(() => vi.useRealTimers());

describe("canonical station route", () => {
  it("uses zoom+4 cells and an unwrapped antimeridian X", () => {
    expect(webMercatorCell(179.9, 0, 170, -170, 2).split("/")[0]).toBe("6");
    const west = webMercatorCell(179.9, 0, 170, -170, 2);
    const east = webMercatorCell(-179.9, 0, 170, -170, 2);
    expect(Number(east.split("/")[1])).toBeGreaterThanOrEqual(Number(west.split("/")[1]));
  });

  it("thins deterministically and serves immutable cursor pages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let upstream = [
      evidence({ at: now, spatialId: "station-a", longitude: 13.4 }),
      evidence({ at: now, spatialId: "station-b", longitude: 14.4 }),
    ];
    const ctx = context(async () => ({
      evidence: upstream,
      nextCursor: null,
      truncated: false,
      diagnostics: {
        candidateCount: upstream.length,
        servedCount: upstream.length,
        skippedCount: 0,
        quotaDeniedCount: 0,
        failureCount: 0,
      },
    }));
    setup(ctx);
    const query = {
      south: "52",
      west: "13",
      north: "53",
      east: "15",
      zoom: "8",
      pollutant: "pm25",
      limit: "1",
    };
    const first = await invoke(ctx, query);
    expect(first.payload).toMatchObject({
      type: "FeatureCollection",
      features: [{ id: expect.stringMatching(/^stn_1_/) }],
      nextCursor: expect.any(String),
      meta: { candidateCount: 2, servedCount: 1 },
    });
    const firstBody = first.payload as { features: Array<{ id: string }>; nextCursor: string };
    upstream = [evidence({ at: now, spatialId: "changed", longitude: 14.8 })];
    const second = await invoke(ctx, { ...query, cursor: firstBody.nextCursor });
    const secondBody = second.payload as { features: Array<{ id: string }>; nextCursor: null };
    expect(secondBody.features).toHaveLength(1);
    expect(secondBody.features[0]?.id).not.toBe(firstBody.features[0]?.id);
    expect(secondBody.nextCursor).toBeNull();
  });

  it("rejects a cursor bound to a different query", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ctx = context(async () => ({
      evidence: [
        evidence({ at: now, spatialId: "station-a", longitude: 13.4 }),
        evidence({ at: now, spatialId: "station-b", longitude: 14.4 }),
      ],
      nextCursor: null,
      truncated: false,
      diagnostics: {
        candidateCount: 2,
        servedCount: 2,
        skippedCount: 0,
        quotaDeniedCount: 0,
        failureCount: 0,
      },
    }));
    setup(ctx);
    const base = { south: "52", west: "13", north: "53", east: "15", zoom: "8", limit: "1" };
    const first = await invoke(ctx, base);
    const cursor = (first.payload as { nextCursor: string }).nextCursor;
    const invalid = await invoke(ctx, { ...base, pollutant: "pm10", cursor });
    expect(invalid).toMatchObject({ statusCode: 400, payload: { code: "INVALID_QUERY" } });
  });
});
