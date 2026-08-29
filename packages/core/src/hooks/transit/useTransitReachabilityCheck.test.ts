import { describe, expect, it } from "vitest";
import { transitReachabilityDestinationKey } from "./useTransitReachabilityCheck";

describe("transit exact reachability query identity", () => {
  it("keeps ordered IDs and rounds coordinates to five decimals", () => {
    const base = {
      origin: { lng: 13.4, lat: 52.5 },
      queryTime: "2026-08-30T10:00:00.000Z",
      direction: "depart-at" as const,
      thresholdsMinutes: [30],
      walkProfileId: "foot-1.2-cap-900-v1" as const,
    };
    expect(
      transitReachabilityDestinationKey({
        ...base,
        destinations: [
          { id: "b", lng: 13.4123459, lat: 52.5123459 },
          { id: "a", lng: 13.4, lat: 52.5 },
        ],
      }),
    ).toEqual([
      ["b", "13.41235", "52.51235"],
      ["a", "13.40000", "52.50000"],
    ]);
  });
});
