import type { TripLeg } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { legToMergedDeparture } from "./legDeparture";

const leg = {
  mode: "rail",
  from: {
    name: "Aachen Hbf",
    lat: 50.77,
    lng: 6.09,
    stopId: "ms:aachen",
    platformCode: "7",
    scheduledPlatformCode: "6",
  },
  to: { name: "Düren", lat: 50.8, lng: 6.48, stopId: "ms:dueren" },
  startTime: "2026-10-31T10:04:00Z",
  scheduledStartTime: "2026-10-31T10:00:00Z",
  endTime: "2026-10-31T10:30:00Z",
  headsign: "Köln Hbf",
  tripId: "ms:trip",
  routeId: "ms:ln:re1",
  route: { shortName: "RE1", longName: "Rhein-Express" },
  occupancy: "high",
} as unknown as TripLeg;

describe("legToMergedDeparture", () => {
  it("shows the vehicle's headsign, planned time, realtime change and boarding platform", () => {
    expect(legToMergedDeparture(leg, "ms")).toMatchObject({
      tripId: "ms:trip",
      headsign: "Köln Hbf",
      scheduledAt: "2026-10-31T10:00:00Z",
      expectedAt: "2026-10-31T10:04:00Z",
      delaySeconds: 240,
      platform: "7",
      scheduledPlatform: "6",
      occupancy: "high",
      providers: ["ms"],
    });
  });

  it("keeps an on-time leg without a realtime change and falls back to the alighting stop", () => {
    const onTime = { ...leg, headsign: undefined, scheduledStartTime: undefined, cancelled: true };
    const departure = legToMergedDeparture(onTime as TripLeg);
    expect(departure).toMatchObject({
      headsign: "Düren",
      scheduledAt: "2026-10-31T10:04:00Z",
      canceled: true,
    });
    expect(departure).not.toHaveProperty("expectedAt");
    expect(departure).not.toHaveProperty("delaySeconds");
  });
});
