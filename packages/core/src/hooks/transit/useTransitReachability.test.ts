import { TRANSIT_WALK_PROFILE } from "@openmapx/mobility-core/transit-reachability";
import { describe, expect, it } from "vitest";
import { transitReachabilitySurfaceKey } from "./useTransitReachability";

describe("transit surface query identity", () => {
  it("includes the captured departure minute and fixed walk profile", () => {
    const request = {
      origin: { lng: 13.4, lat: 52.5 },
      queryTime: "2026-08-30T10:12:00.000Z",
      direction: "depart-at" as const,
      thresholdsMinutes: [30],
      walkProfileId: TRANSIT_WALK_PROFILE.id,
    };

    expect(transitReachabilitySurfaceKey(request)).toEqual([
      "transit-reachability-surface",
      expect.objectContaining({
        queryTime: "2026-08-30T10:12:00.000Z",
        walkProfileId: "foot-1.2-cap-900-v1",
      }),
    ]);
  });
});
