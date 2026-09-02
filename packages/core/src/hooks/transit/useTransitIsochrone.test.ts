import { TRANSIT_WALK_PROFILE } from "@openmapx/mobility-core/transit-reachability";
import { describe, expect, it } from "vitest";
import { transitIsochroneKey } from "./useTransitIsochrone";

describe("transit isochrone query identity", () => {
  const request = {
    origin: { lng: 13.4, lat: 52.5 },
    queryTime: "2026-09-01T08:00:00.000Z",
    direction: "depart-at" as const,
    thresholdsMinutes: [15, 30],
    walkProfileId: TRANSIT_WALK_PROFILE.id,
    bbox: [13.3, 52.45, 13.5, 52.55] as [number, number, number, number],
  };

  it("keys on the sampled area as well as the departure minute", () => {
    expect(transitIsochroneKey(request)).toEqual([
      "transit-isochrone",
      expect.objectContaining({
        queryTime: "2026-09-01T08:00:00.000Z",
        bbox: [13.3, 52.45, 13.5, 52.55],
      }),
    ]);
  });

  it("separates a different viewport into its own cache entry", () => {
    const moved = { ...request, bbox: [13.31, 52.45, 13.51, 52.55] as const };
    expect(transitIsochroneKey(request)).not.toEqual(transitIsochroneKey(moved as typeof request));
  });

  it("has a null key when there is nothing to request", () => {
    expect(transitIsochroneKey(null)).toEqual(["transit-isochrone", null]);
  });
});
