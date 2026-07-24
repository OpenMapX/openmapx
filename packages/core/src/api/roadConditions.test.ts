import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { fetchRoadConditions } from "./roadConditions";

describe("fetchRoadConditions", () => {
  beforeEach(() => vi.restoreAllMocks());

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
