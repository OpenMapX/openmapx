import type { TripLeg } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { nextTransferFor } from "./transitConnection";

function transitLeg(shortName: string): TripLeg {
  return {
    mode: "rail",
    startTime: "",
    endTime: "",
    from: { name: "A", lat: 0, lng: 0 },
    to: { name: "B", lat: 0, lng: 0 },
    route: { shortName, longName: "", color: undefined },
    geometry: { type: "LineString", coordinates: [] },
  };
}

function walkLeg(durationSeconds: number): TripLeg {
  return {
    mode: "walking",
    startTime: "",
    endTime: "",
    from: { name: "A", lat: 0, lng: 0 },
    to: { name: "B", lat: 0, lng: 0 },
    geometry: { type: "LineString", coordinates: [] },
    durationSeconds,
  };
}

describe("nextTransferFor", () => {
  it("finds the next transit leg across an intervening walk and sums the walk time", () => {
    const legs = [transitLeg("RE1"), walkLeg(180), transitLeg("S12")];
    const transfer = nextTransferFor(legs, 0);
    expect(transfer?.nextLeg.route?.shortName).toBe("S12");
    expect(transfer?.walkSeconds).toBe(180);
  });

  it("returns a zero walk when the next transit leg is adjacent (interlined)", () => {
    const legs = [transitLeg("RE1"), transitLeg("RB33")];
    expect(nextTransferFor(legs, 0)).toEqual({
      nextLeg: expect.objectContaining({ route: expect.objectContaining({ shortName: "RB33" }) }),
      walkSeconds: 0,
    });
  });

  it("returns null when the current leg is the last ride", () => {
    const legs = [transitLeg("RE1"), walkLeg(120)];
    expect(nextTransferFor(legs, 0)).toBeNull();
  });
});
