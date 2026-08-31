import type { TripLeg } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { journeysToTripPlan } from "../src/fptf-journey.js";

interface RawLeg {
  id: string;
  walking?: boolean;
  distance?: number;
}

function leg(id: string, startTime: string, endTime: string, route = true): TripLeg {
  return {
    mode: route ? "RAIL" : "WALK",
    startTime,
    endTime,
    from: { name: `${id}-from`, lat: 1, lng: 2 },
    to: { name: `${id}-to`, lat: 3, lng: 4 },
    route: route ? { shortName: id, longName: id } : undefined,
    geometry: { type: "LineString", coordinates: [] },
  };
}

const ENDPOINTS = {
  fromLat: 10,
  fromLng: 11,
  toLat: 12,
  toLng: 13,
};

describe("journeysToTripPlan", () => {
  it("maps legs and derives itinerary duration, transfers, and walking distance", () => {
    const rawLegs: RawLeg[] = [
      { id: "rail-1" },
      { id: "walk", walking: true, distance: 400.6 },
      { id: "rail-2" },
    ];
    const mapped = [
      leg("rail-1", "2026-08-31T10:00:00Z", "2026-08-31T10:05:00Z"),
      leg("walk", "2026-08-31T10:05:00Z", "2026-08-31T10:10:00Z", false),
      leg("rail-2", "2026-08-31T10:10:00Z", "2026-08-31T10:20:00Z"),
    ];
    const mapLeg = vi.fn((raw: RawLeg) => mapped[rawLegs.indexOf(raw)]);

    const plan = journeysToTripPlan([{ legs: rawLegs }], ENDPOINTS, mapLeg);

    expect(mapLeg.mock.calls.map(([raw]) => raw.id)).toEqual(["rail-1", "walk", "rail-2"]);
    expect(plan.itineraries[0]).toEqual({
      duration: 1_200,
      startTime: "2026-08-31T10:00:00Z",
      endTime: "2026-08-31T10:20:00Z",
      transfers: 1,
      walkDistance: 401,
      legs: mapped,
    });
    expect(plan.from).toEqual({ name: "rail-1-from", lat: 1, lng: 2 });
    expect(plan.to).toEqual({ name: "rail-2-to", lat: 3, lng: 4 });
  });

  it("uses request coordinates when the first journey has no legs", () => {
    const plan = journeysToTripPlan<RawLeg>([{ legs: [] }], ENDPOINTS, vi.fn());

    expect(plan).toEqual({
      from: { name: "", lat: 10, lng: 11 },
      to: { name: "", lat: 12, lng: 13 },
      itineraries: [
        {
          duration: 0,
          startTime: "",
          endTime: "",
          transfers: 0,
          walkDistance: 0,
          legs: [],
        },
      ],
    });
  });
});
