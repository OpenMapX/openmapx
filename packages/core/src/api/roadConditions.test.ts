import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import {
  fetchRoadConditions,
  fetchRoadConditionsWithStatus,
  fetchRouteFlow,
} from "./roadConditions";

describe("fetchRoadConditions", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns parsed events with an explicit success status", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      features: [
        {
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
          properties: { id: "status:1", type: "roadworks" },
        },
      ],
    } as never);

    await expect(fetchRoadConditionsWithStatus([13, 52, 14, 53])).resolves.toMatchObject({
      ok: true,
      events: [{ id: "status:1", type: "roadworks" }],
    });
  });

  it("returns a failed status without throwing when the request fails (transport throw)", async () => {
    vi.spyOn(apiClient, "get").mockRejectedValue(new Error("network"));

    await expect(fetchRoadConditionsWithStatus([13, 52, 14, 53])).resolves.toEqual({
      ok: false,
      events: [],
    });
  });

  it("returns a failed status when the server responds non-2xx", async () => {
    // `apiClient.get` throws on `!res.ok`, so this exercises the same catch
    // path as a transport failure — confirmed by reading `client.ts`, not
    // assumed.
    vi.spyOn(apiClient, "get").mockRejectedValue(new Error("API error 503: {}"));

    await expect(fetchRoadConditionsWithStatus([13, 52, 14, 53])).resolves.toEqual({
      ok: false,
      events: [],
    });
  });

  it("reports a genuine empty successful aggregation as ok: true with zero events", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      type: "FeatureCollection",
      features: [],
    } as never);

    await expect(fetchRoadConditionsWithStatus([13, 52, 14, 53])).resolves.toEqual({
      ok: true,
      events: [],
    });
  });

  it("treats a non-object response body as a failure", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue(null as never);

    await expect(fetchRoadConditionsWithStatus([13, 52, 14, 53])).resolves.toEqual({
      ok: false,
      events: [],
    });
  });

  it("treats a `features` field that isn't an array as a failure", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({ features: "nope" } as never);

    await expect(fetchRoadConditionsWithStatus([13, 52, 14, 53])).resolves.toEqual({
      ok: false,
      events: [],
    });
  });

  it("forwards an abort signal without serializing it as a query parameter", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ features: [] } as never);
    const controller = new AbortController();

    await fetchRoadConditionsWithStatus([13, 52, 14, 53], { signal: controller.signal });

    expect(spy).toHaveBeenCalledWith(
      "/api/integrations/road-conditions/events",
      { bbox: "13,52,14,53" },
      { signal: controller.signal },
    );
  });

  it("serializes the bbox + filters and parses the FeatureCollection to events", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
          properties: {
            id: "ndw:1",
            source: "ndw",
            provider: "road-conditions-openconditions",
            type: "accident",
            severity: "high",
            headline: "Accident on A1",
            description: "Two cars",
            groupId: "SITUATION_1",
          },
        },
      ],
    } as never);

    const out = await fetchRoadConditions([13.39, 52.49, 13.41, 52.51], {
      types: ["accident", "roadworks"],
      minSeverity: "medium",
    });

    expect(spy).toHaveBeenCalledWith(
      "/api/integrations/road-conditions/events",
      expect.objectContaining({
        bbox: "13.39,52.49,13.41,52.51",
        types: "accident,roadworks",
        minSeverity: "medium",
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "ndw:1",
      source: "ndw",
      provider: "road-conditions-openconditions",
      type: "accident",
      severity: "high",
      headline: "Accident on A1",
      groupId: "SITUATION_1",
      geometry: { type: "Point", coordinates: [13.4, 52.5] },
    });
  });

  it("reads a numeric delaySeconds off the feature into the event", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      features: [
        {
          geometry: { type: "Point", coordinates: [5, 52] },
          properties: { id: "d:1", delaySeconds: 1500 },
        },
        {
          geometry: { type: "Point", coordinates: [5, 52] },
          properties: { id: "d:2", delaySeconds: null },
        },
      ],
    } as never);
    const out = await fetchRoadConditions([0, 0, 1, 1]);
    expect(out.find((e) => e.id === "d:1")?.delaySeconds).toBe(1500);
    expect(out.find((e) => e.id === "d:2")?.delaySeconds).toBeUndefined();
    expect(out.find((e) => e.id === "d:1")?.groupId).toBeUndefined();
  });

  it("sends horizonDays only when set", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ features: [] } as never);

    await fetchRoadConditions([0, 0, 1, 1], { horizonDays: 7 });
    expect(spy).toHaveBeenLastCalledWith(
      "/api/integrations/road-conditions/events",
      expect.objectContaining({ horizonDays: "7" }),
    );

    // `0` means "active now" — a falsy value that must still be sent.
    await fetchRoadConditions([0, 0, 1, 1], { horizonDays: 0 });
    expect(spy).toHaveBeenLastCalledWith(
      "/api/integrations/road-conditions/events",
      expect.objectContaining({ horizonDays: "0" }),
    );

    await fetchRoadConditions([0, 0, 1, 1]);
    expect(spy).toHaveBeenLastCalledWith(
      "/api/integrations/road-conditions/events",
      expect.not.objectContaining({ horizonDays: expect.anything() }),
    );
  });

  it("parses the planned/forecast flags off the feature", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      features: [
        {
          geometry: { type: "Point", coordinates: [5, 52] },
          properties: { id: "f:1", isForecast: true, isPlanned: true },
        },
        {
          geometry: { type: "Point", coordinates: [5, 52] },
          properties: { id: "f:2", isForecast: null, isPlanned: null },
        },
      ],
    } as never);
    const out = await fetchRoadConditions([0, 0, 1, 1]);
    expect(out.find((e) => e.id === "f:1")).toMatchObject({ isForecast: true, isPlanned: true });
    expect(out.find((e) => e.id === "f:2")?.isForecast).toBeUndefined();
    expect(out.find((e) => e.id === "f:2")?.isPlanned).toBeUndefined();
  });

  it("drops features without an id or geometry", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      features: [
        { geometry: { type: "Point", coordinates: [0, 0] }, properties: { headline: "no id" } },
        { geometry: null, properties: { id: "x" } },
      ],
    } as never);
    const out = await fetchRoadConditions([0, 0, 1, 1]);
    expect(out).toEqual([]);
  });

  it("returns [] on transport error (never throws)", async () => {
    vi.spyOn(apiClient, "get").mockRejectedValue(new Error("network"));
    const out = await fetchRoadConditions([0, 0, 1, 1]);
    expect(out).toEqual([]);
  });
});

describe("fetchRouteFlow", () => {
  it("keys the spans by the submitted route id", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({
      routes: [
        {
          id: "r0",
          spans: [{ startMeters: 10, endMeters: 90, los: "queuing", confidence: "measured" }],
        },
      ],
    });
    const result = await fetchRouteFlow([
      {
        id: "r0",
        geometry: [
          [8, 50],
          [8, 50.01],
        ],
      },
    ]);
    expect(result.r0[0].los).toBe("queuing");
    post.mockRestore();
  });

  it("returns an empty map on any failure — traffic must never break the route", async () => {
    const post = vi.spyOn(apiClient, "post").mockRejectedValue(new Error("boom"));
    expect(
      await fetchRouteFlow([
        {
          id: "r0",
          geometry: [
            [8, 50],
            [8, 50.01],
          ],
        },
      ]),
    ).toEqual({});
    post.mockRestore();
  });

  it("skips the request entirely when there is nothing to ask about", async () => {
    const post = vi.spyOn(apiClient, "post");
    expect(await fetchRouteFlow([])).toEqual({});
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  });
});

describe("road-condition restriction transport", () => {
  beforeEach(() => vi.restoreAllMocks());

  const mockGet = {
    mockResolvedValueOnce(value: unknown) {
      vi.spyOn(apiClient, "get").mockResolvedValue(value as never);
    },
  };

  const details = {
    schemaVersion: 1,
    vehicleScope: "specific",
    completeness: "complete",
    issues: [],
    source: {
      sourceId: "fi-digitraffic",
      recordId: "GUID50465935",
      recordVersion: "31",
      sourceUpdatedAt: "2026-08-28T04:18:02.629Z",
      feedUrls: ["https://tie.digitraffic.fi/api/traffic-message/v2/roadworks"],
      publisher: "Fintraffic / Digitraffic",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "Fintraffic / Digitraffic",
      modificationNotice:
        "Normalized by OpenConditions; source units and structure may be transformed.",
    },
    facts: [
      {
        id: "GUID50465935:GUID50469933:roadwork_phase:restrictions[2]",
        kind: "dimension",
        dimension: "gross_weight",
        meaning: "maximum_permitted",
        value: 26000,
        unit: "kg",
        operator: "lte",
        state: "active",
        scope: {
          kind: "roadwork_phase",
          phaseId: "GUID50469933",
          locationDescription: "Tie 104, Raasepori",
          sourceLocationRefs: { scheme: "digitraffic_road_address", road: 104 },
          restrictionBinding: "not_established",
        },
        direction: { basis: "road_reference", value: "both", description: null },
        validFrom: "2026-07-19T21:00:00.000Z",
        validTo: "2026-12-14T21:59:59.999Z",
        sourceTokens: { type: "vehicle gross weight limit", quantity: 26, unit: "t" },
        context: {
          restrictionsLiftable: false,
          compliance: "unknown",
          operatorActionStatus: null,
          validityStatus: null,
        },
      },
    ],
    evaluatedAt: "2026-09-12T07:14:00.000Z",
    sourceCheckedAt: "2026-09-12T07:13:00.000Z",
    freshUntil: "2026-09-12T07:23:00.000Z",
    nextTransitionAt: "2026-12-14T21:59:59.999Z",
    isStale: false,
  };

  function feature(properties: Record<string, unknown>) {
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [23.5, 60.1] },
      properties: {
        id: "fi-digitraffic:GUID50465935",
        source: "fi-digitraffic",
        provider: "road-conditions-openconditions",
        type: "restriction",
        severity: "high",
        headline: "Tie 104, Raasepori. Tietyö.",
        ...properties,
      },
    };
  }

  it("carries a valid envelope through unchanged and deep-equal", async () => {
    mockGet.mockResolvedValueOnce({
      type: "FeatureCollection",
      features: [feature({ restrictionDetails: details, subtype: "road construction" })],
    });
    const result = await fetchRoadConditionsWithStatus([19, 59, 32, 71]);
    expect(result.ok).toBe(true);
    expect(result.events[0]!.restrictionDetails).toEqual(details);
    expect(result.events[0]!.subtype).toBe("road construction");
    expect(result.events[0]!.restrictionDetailsUnsupported).toBeUndefined();
  });

  it("keeps a mixed response, marking only the malformed envelope unsupported", async () => {
    mockGet.mockResolvedValueOnce({
      type: "FeatureCollection",
      features: [
        feature({ id: "old:1" }),
        feature({ id: "new:ok", restrictionDetails: details }),
        feature({ id: "new:bad", restrictionDetails: { schemaVersion: 9 } }),
      ],
    });
    const result = await fetchRoadConditionsWithStatus([19, 59, 32, 71]);
    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(3);
    const byId = new Map(result.events.map((e) => [e.id, e]));
    expect(byId.get("old:1")!.restrictionDetails).toBeUndefined();
    expect(byId.get("old:1")!.restrictionDetailsUnsupported).toBeUndefined();
    expect(byId.get("new:ok")!.restrictionDetails).toEqual(details);
    expect(byId.get("new:bad")!.restrictionDetailsUnsupported).toBe(true);
    expect(byId.get("new:bad")!.restrictionDetails).toBeUndefined();
  });

  it("reads an empty collection as a successful empty result", async () => {
    mockGet.mockResolvedValueOnce({ type: "FeatureCollection", features: [] });
    expect(await fetchRoadConditionsWithStatus([19, 59, 32, 71])).toEqual({
      ok: true,
      events: [],
    });
  });
});
