import type { BBox } from "@openmapx/core";
import { describe, expect, test, vi } from "vitest";
import type { HazardAlert, HazardsProvider } from "../contracts/hazards-provider.js";
import { createHazardsOrchestrator } from "../hazards-orchestrator";
import { createMockIntegrationContext } from "../testing/index.js";

const ALEUTIANS: BBox = [170, 50, -170, 60];

function alert(id: string, sources = ["us-nws-alerts"]): HazardAlert {
  return {
    id,
    type: "wind",
    geometry: { type: "Point", coordinates: [0, 0] },
    event: "High Wind Warning",
    severity: "Severe",
    urgency: "Expected",
    certainty: "Likely",
    sent: "2026-10-09T00:00:00Z",
    sources,
    attributions: [],
    notices: [],
  };
}

function provider(over: Partial<HazardsProvider> = {}): HazardsProvider {
  return {
    id: "test",
    coverage: { all: true },
    getAlerts: async () => ({ alerts: [] }),
    getNaturalHazards: async () => ({ hazards: [] }),
    getFirePixels: async () => ({ pixels: [] }),
    getFireDensity: async () => ({ cells: [], sources: [] }),
    ...over,
  };
}

function orchestratorOver(providers: HazardsProvider[], disallowed?: string[]) {
  const ctx = createMockIntegrationContext();
  const host = {
    ...ctx,
    getIntegrationsByDomain: (domain: string) =>
      domain === "hazards"
        ? providers.map((p) => ({ id: p.id, providers: new Map([["hazards", [p]]]) }))
        : [],
    getDisallowedSourceIds: disallowed ? async () => new Set(disallowed) : undefined,
  };
  return createHazardsOrchestrator(
    host as unknown as Parameters<typeof createHazardsOrchestrator>[0],
  );
}

describe("registerHazardsProvider", () => {
  test("stores the provider under hazards", () => {
    const ctx = createMockIntegrationContext();
    const registered = provider();
    ctx.registerHazardsProvider(registered);
    expect(ctx.registered.hazards).toEqual([registered]);
  });
});

describe("hazards orchestrator", () => {
  test("splits a view across the antimeridian and returns one copy of an item both halves answered", async () => {
    const getAlerts = vi.fn<HazardsProvider["getAlerts"]>(async () => ({
      alerts: [alert("shared"), alert("edge")],
    }));
    const hazards = orchestratorOver([provider({ getAlerts })]);

    const answer = await hazards.alerts(ALEUTIANS);

    expect(getAlerts.mock.calls.map((call) => call[0])).toEqual([
      [170, 50, 180, 60],
      [-180, 50, -170, 60],
    ]);
    expect(answer.alerts.map((a) => a.id)).toEqual(["shared", "edge"]);
  });

  test("an ordinary view is one read", async () => {
    const getAlerts = vi.fn(async () => ({ alerts: [] }));
    await orchestratorOver([provider({ getAlerts })]).alerts([5, 45, 15, 55]);
    expect(getAlerts).toHaveBeenCalledTimes(1);
  });

  test("with no hazards provider, every read is unavailable, not empty", async () => {
    const hazards = orchestratorOver([]);
    expect(await hazards.alerts([-180, -90, 180, 90])).toEqual({
      alerts: [],
      partial: "unavailable",
    });
    expect(await hazards.naturalHazards([-180, -90, 180, 90], { types: ["volcano"] })).toEqual({
      hazards: [],
      partial: "unavailable",
    });
    expect(
      await hazards.firePixels([5, 45, 15, 55], {
        since: "2026-10-08T00:00:00Z",
        instrument: "viirs",
        limit: 10,
      }),
    ).toEqual({ pixels: [], partial: "unavailable" });
    expect(
      await hazards.fireDensity([5, 45, 15, 55], {
        since: "2026-10-08T00:00:00Z",
        instrument: "viirs",
        cellDeg: 1,
      }),
    ).toEqual({ cells: [], sources: [], partial: "unavailable" });
  });

  test("a provider that covers only part of the world leaves the rest unavailable", async () => {
    const getAlerts = vi.fn<HazardsProvider["getAlerts"]>(async () => ({ alerts: [alert("a")] }));
    const europe = provider({ getAlerts, coverage: { bbox: [-25, 34, 45, 72] } });
    const hazards = orchestratorOver([europe]);
    expect(await hazards.alerts([-120, 30, -70, 50])).toEqual({
      alerts: [],
      partial: "unavailable",
    });
    expect((await hazards.alerts([5, 45, 15, 55])).partial).toBeUndefined();
  });

  test("merges the halves' partial reasons, area winning", async () => {
    const getAlerts = vi
      .fn<HazardsProvider["getAlerts"]>()
      .mockResolvedValueOnce({ alerts: [], partial: "unavailable" })
      .mockResolvedValueOnce({ alerts: [], partial: "area" });
    expect((await orchestratorOver([provider({ getAlerts })]).alerts(ALEUTIANS)).partial).toBe(
      "area",
    );
  });

  test("density cells concatenate across the halves and their sources union", async () => {
    const getFireDensity = vi
      .fn<HazardsProvider["getFireDensity"]>()
      .mockResolvedValueOnce({
        cells: [{ point: [175, 55], count: 2, frpSumMW: 3, frpMaxMW: 2 }],
        sources: ["nasa-firms-viirs-fires"],
      })
      .mockResolvedValueOnce({
        cells: [{ point: [-175, 55], count: 1, frpSumMW: 1, frpMaxMW: 1 }],
        sources: ["nasa-firms-viirs-fires", "nasa-firms-modis-fires"],
      });
    const answer = await orchestratorOver([provider({ getFireDensity })]).fireDensity(ALEUTIANS, {
      since: "2026-10-08T00:00:00Z",
      instrument: "viirs",
      cellDeg: 1,
    });

    expect(answer.cells.map((c) => c.point)).toEqual([
      [175, 55],
      [-175, 55],
    ]);
    expect(answer.sources).toEqual(["nasa-firms-viirs-fires", "nasa-firms-modis-fires"]);
  });

  test("drops an alert naming a disallowed source and pushes the exclusion", async () => {
    const getAlerts = vi.fn<HazardsProvider["getAlerts"]>(async () => ({
      alerts: [alert("ok"), alert("gated", ["us-nws-alerts", "eu-meteoalarm-alerts"])],
    }));
    const answer = await orchestratorOver(
      [provider({ getAlerts })],
      ["eu-meteoalarm-alerts"],
    ).alerts([5, 45, 15, 55]);

    expect(answer.alerts.map((a) => a.id)).toEqual(["ok"]);
    expect(getAlerts.mock.calls[0][1]).toEqual({ excludedSourceIds: ["eu-meteoalarm-alerts"] });
  });

  test("passes the language and the other query fields to the providers unchanged", async () => {
    const getAlerts = vi.fn<HazardsProvider["getAlerts"]>(async () => ({ alerts: [] }));
    const getNaturalHazards = vi.fn<HazardsProvider["getNaturalHazards"]>(async () => ({
      hazards: [],
    }));
    const hazards = orchestratorOver([provider({ getAlerts, getNaturalHazards })]);

    await hazards.alerts([5, 45, 15, 55], { lang: "de", simplifyDeg: 0.01 });
    await hazards.naturalHazards([5, 45, 15, 55], { types: ["volcano"], lang: "de-AT" });

    expect(getAlerts.mock.calls[0][1]).toEqual({ lang: "de", simplifyDeg: 0.01 });
    expect(getNaturalHazards.mock.calls[0][1]).toEqual({ types: ["volcano"], lang: "de-AT" });
  });
});

describe("hazard receipts", () => {
  test("duplicates retain the winning record receipt without crediting the discarded supplier", async () => {
    const a = { sourceId: "a", name: "Captured A" };
    const b = { sourceId: "b", name: "Captured B" };
    const hazards = orchestratorOver([
      provider({
        id: "a",
        getAlerts: async () => ({ alerts: [{ ...alert("same", ["a"]), attributions: [a] }] }),
      }),
      provider({
        id: "b",
        getAlerts: async () => ({ alerts: [{ ...alert("same", ["b"]), attributions: [b] }] }),
      }),
    ]);
    const result = await hazards.alerts([0, 0, 1, 1]);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]?.contributors).toEqual([a]);
    a.name = "Current metadata";
    expect(result.alerts[0]?.contributors?.[0]?.name).toBe("Captured A");
  });

  test("mixed density cells keep their own receipts and legacy cells never inherit collection suppliers", async () => {
    const a = { sourceId: "a", name: "A" };
    const b = { sourceId: "b", name: "B" };
    const cells = [
      {
        point: [0, 0] as [number, number],
        count: 1,
        frpSumMW: 1,
        frpMaxMW: 1,
        sources: ["a"],
        contributors: [a],
      },
      {
        point: [1, 1] as [number, number],
        count: 1,
        frpSumMW: 2,
        frpMaxMW: 2,
        sources: ["b"],
        contributors: [b],
      },
      { point: [2, 2] as [number, number], count: 1, frpSumMW: 3, frpMaxMW: 3 },
    ];
    const hazards = orchestratorOver([
      provider({ getFireDensity: async () => ({ cells, sources: ["a", "b", "offscreen"] }) }),
    ]);
    const result = await hazards.fireDensity([0, 0, 3, 3], {
      since: "2026-10-09",
      instrument: "viirs",
      cellDeg: 1,
    });
    expect(result.cells.map((cell) => cell.contributors)).toEqual([[a], [b], []]);
    expect(result.cells.map((cell) => cell.sources)).toEqual([["a"], ["b"], []]);
  });
});

test("filters exact native density suppliers per cell without dropping A-only cells for a globally named B", async () => {
  const a = { sourceId: "parent-a", name: "Captured A" };
  const b = { sourceId: "parent-b", name: "Captured B" };
  const hazards = orchestratorOver(
    [
      provider({
        getFireDensity: async () => ({
          sources: ["child-a", "child-b"],
          cells: [
            {
              point: [0, 0],
              count: 1,
              frpSumMW: 1,
              frpMaxMW: 1,
              sources: ["parent-a"],
              contributors: [a],
              nativeSources: ["child-a"],
            },
            {
              point: [1, 1],
              count: 2,
              frpSumMW: 3,
              frpMaxMW: 2,
              sources: ["parent-a", "parent-b"],
              contributors: [a, b],
              nativeSources: ["child-a", "child-b"],
            },
          ],
        }),
      }),
    ],
    ["child-b"],
  );
  const answer = await hazards.fireDensity([0, 0, 2, 2], {
    since: "2026-10-09",
    instrument: "viirs",
    cellDeg: 1,
  });
  expect(answer.cells).toHaveLength(1);
  expect(answer.cells[0]?.contributors).toEqual([a]);
  expect(answer.sources).toEqual(["child-a"]);
});
