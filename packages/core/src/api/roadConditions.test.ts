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
