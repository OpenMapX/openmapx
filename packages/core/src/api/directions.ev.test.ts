import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { postEvDirections } from "./directions";

describe("postEvDirections", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("POSTs the request to the ev directions endpoint and returns the parsed result", async () => {
    const result = {
      waypoints: [
        [0, 50],
        [1, 50],
      ],
      routes: [],
      activeRouteIndex: 0,
      stops: [],
      totals: { driveSeconds: 0, chargeSeconds: 0, energyKwh: 0 },
      warnings: [],
    };
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue(result as never);

    const req = {
      waypoints: [
        [0, 50],
        [1, 50],
      ] as [number, number][],
      vehicleId: "vw-id4",
      socStartPct: 80,
    };
    const out = await postEvDirections(req);

    expect(spy).toHaveBeenCalledWith("/api/integrations/routing/directions/ev", req);
    expect(out).toEqual(result);
    expect(out.warnings).toEqual([]);
  });
});
