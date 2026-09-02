import type { TemporalCapabilities, TripPlanRequest } from "@openmapx/integration-framework";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { TripItinerary, TripPlan } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { planTransitChain, selectItinerary } from "../chain-plan.js";

const COLOGNE = { lat: 50.94, lng: 6.96 };
const BONN = { lat: 50.73, lng: 7.1 };
const AACHEN = { lat: 50.77, lng: 6.08 };

const CAPABILITIES: TemporalCapabilities = {
  tripDepartAt: "native",
  tripArriveBy: "native",
  dwell: "emulated",
  waypointDepartAfter: "emulated",
  waypointArriveBy: "emulated",
  timeDependentTravel: "native",
};

function itinerary(
  start: string,
  end: string,
  overrides: Partial<TripItinerary> = {},
): TripItinerary {
  return {
    duration: (Date.parse(end) - Date.parse(start)) / 1000,
    startTime: start,
    endTime: end,
    transfers: 0,
    walkDistance: 0,
    legs: [],
    ...overrides,
  };
}

function result(itineraries: TripItinerary[]): MobilityResult<TripPlan | null> {
  return {
    data: {
      from: { name: "", ...COLOGNE },
      to: { name: "", ...BONN },
      itineraries,
      provider: "transit-motis-local",
    },
    attributions: [],
    freshness: { fetchedAt: new Date().toISOString() },
  } as unknown as MobilityResult<TripPlan | null>;
}

function transitLeg(overrides: Record<string, unknown>) {
  return {
    mode: "RAIL",
    from: { name: "A", lat: 0, lng: 0 },
    to: { name: "B", lat: 0, lng: 0 },
    geometry: { type: "LineString", coordinates: [] },
    ...overrides,
  } as unknown as TripItinerary["legs"][number];
}

describe("selectItinerary", () => {
  const options = [
    itinerary("2026-09-01T09:10:00Z", "2026-09-01T10:00:00Z"),
    itinerary("2026-09-01T09:20:00Z", "2026-09-01T09:50:00Z"),
  ];

  it("prefers the provider's first option when no deadline binds", () => {
    expect(selectItinerary(options, null)).toBe(options[0]);
  });

  it("picks the first option that still meets a deadline", () => {
    expect(selectItinerary(options, Date.parse("2026-09-01T09:55:00Z"))).toBe(options[1]);
  });

  it("falls back to the earliest arrival when nothing meets the deadline", () => {
    expect(selectItinerary(options, Date.parse("2026-09-01T09:00:00Z"))).toBe(options[1]);
  });

  it("returns null for an empty list", () => {
    expect(selectItinerary([], null)).toBeNull();
  });
});

describe("planTransitChain", () => {
  it("calls the planner once per segment, chaining departure times through dwell", async () => {
    const calls: { from: unknown; to: unknown; departureTime?: string }[] = [];
    const planTrip = vi.fn(async (request: TripPlanRequest) => {
      calls.push({
        from: request.from,
        to: request.to,
        departureTime: request.departureTime,
      });
      const departure = Date.parse(request.departureTime as string);
      return result([
        itinerary(
          new Date(departure + 10 * 60_000).toISOString(),
          new Date(departure + 40 * 60_000).toISOString(),
        ),
      ]);
    });

    const plan = await planTransitChain({
      waypoints: [COLOGNE, BONN, AACHEN],
      schedules: [null, { dwellSeconds: 1800 }, null],
      anchor: { kind: "departAt", wallClock: "2026-09-01T09:00" },
      baseRequest: {},
      planTrip,
      capabilities: CAPABILITIES,
    });

    expect(planTrip).toHaveBeenCalledTimes(2);
    expect(calls[0]).toMatchObject({ from: COLOGNE, to: BONN });
    // Segment one arrives 40 min after departure, dwells 30 min, so segment two
    // is asked for 70 min after the anchor.
    expect(Date.parse(calls[1].departureTime as string)).toBe(
      Date.parse(calls[0].departureTime as string) + 40 * 60_000 + 30 * 60_000,
    );
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0].boardingWaitSeconds).toBe(600);
    expect(plan.warnings).toEqual([]);
  });

  it("asks for arrival times on a backward solve, walking from the destination", async () => {
    const arrivals: (string | undefined)[] = [];
    const planTrip = vi.fn(async (request: TripPlanRequest) => {
      arrivals.push(request.arrivalTime);
      const arrival = Date.parse(request.arrivalTime as string);
      return result([
        itinerary(
          new Date(arrival - 40 * 60_000).toISOString(),
          new Date(arrival - 5 * 60_000).toISOString(),
        ),
      ]);
    });

    await planTransitChain({
      waypoints: [COLOGNE, BONN, AACHEN],
      schedules: [null, { dwellSeconds: 600 }, null],
      anchor: { kind: "arriveBy", wallClock: "2026-09-01T18:00" },
      baseRequest: {},
      planTrip,
      capabilities: CAPABILITIES,
    });

    expect(planTrip).toHaveBeenCalledTimes(2);
    expect(Date.parse(arrivals[1] as string)).toBeLessThan(Date.parse(arrivals[0] as string));
  });

  it("reports the realtime arrival delay per segment", async () => {
    const planTrip = vi.fn(async () =>
      result([
        itinerary("2026-09-01T09:10:00Z", "2026-09-01T09:50:00Z", {
          legs: [
            transitLeg({
              startTime: "2026-09-01T09:10:00Z",
              endTime: "2026-09-01T09:50:00Z",
              scheduledStartTime: "2026-09-01T09:10:00Z",
              scheduledEndTime: "2026-09-01T09:44:00Z",
            }),
          ],
        }),
      ]),
    );

    const plan = await planTransitChain({
      waypoints: [COLOGNE, BONN],
      schedules: [null, null],
      anchor: { kind: "departAt", wallClock: "2026-09-01T09:00" },
      baseRequest: {},
      planTrip,
      capabilities: CAPABILITIES,
    });

    expect(plan.segments[0].delaySeconds).toBe(360);
  });

  it("warns when a chosen leg is cancelled", async () => {
    const planTrip = vi.fn(async () =>
      result([
        itinerary("2026-09-01T09:10:00Z", "2026-09-01T09:50:00Z", {
          legs: [
            transitLeg({
              startTime: "2026-09-01T09:10:00Z",
              endTime: "2026-09-01T09:50:00Z",
              cancelled: true,
            }),
          ],
        }),
      ]),
    );

    const plan = await planTransitChain({
      waypoints: [COLOGNE, BONN],
      schedules: [null, null],
      anchor: { kind: "departAt", wallClock: "2026-09-01T09:00" },
      baseRequest: {},
      planTrip,
      capabilities: CAPABILITIES,
    });

    expect(plan.warnings).toContainEqual({ kind: "cancelled-leg", segmentIndex: 0 });
  });

  it("warns when the provider could not honour a hard requirement", async () => {
    const planTrip = vi.fn(async () =>
      result([
        itinerary("2026-09-01T09:10:00Z", "2026-09-01T09:50:00Z", {
          invalidRequirements: ["wheelchairRequired"],
        }),
      ]),
    );

    const plan = await planTransitChain({
      waypoints: [COLOGNE, BONN],
      schedules: [null, null],
      anchor: { kind: "departAt", wallClock: "2026-09-01T09:00" },
      baseRequest: {},
      planTrip,
      capabilities: CAPABILITIES,
    });

    expect(plan.warnings).toContainEqual({
      kind: "unmet-requirement",
      segmentIndex: 0,
      requirements: ["wheelchairRequired"],
    });
  });

  it("stops the chain and reports no-connection when a segment is empty", async () => {
    const planTrip = vi.fn(async (request: TripPlanRequest) =>
      request.to.lat === BONN.lat
        ? result([itinerary("2026-09-01T09:10:00Z", "2026-09-01T09:50:00Z")])
        : result([]),
    );

    const plan = await planTransitChain({
      waypoints: [COLOGNE, BONN, AACHEN],
      schedules: [null, null, null],
      anchor: { kind: "departAt", wallClock: "2026-09-01T09:00" },
      baseRequest: {},
      planTrip,
      capabilities: CAPABILITIES,
    });

    expect(plan.warnings).toContainEqual({ kind: "no-connection", segmentIndex: 1 });
    expect(plan.schedule.violations).toContainEqual({
      kind: "unreachable",
      fromIndex: 1,
      toIndex: 2,
    });
    expect(plan.segments).toHaveLength(1);
  });

  it("warns when a provider returns a segment that departs before the previous one lands", async () => {
    let call = 0;
    const planTrip = vi.fn(async () => {
      call += 1;
      return call === 1
        ? result([itinerary("2026-09-01T09:10:00Z", "2026-09-01T10:00:00Z")])
        : // Departs 09:45, before the first segment lands at 10:00.
          result([itinerary("2026-09-01T09:45:00Z", "2026-09-01T10:30:00Z")]);
    });

    const plan = await planTransitChain({
      waypoints: [COLOGNE, BONN, AACHEN],
      schedules: [null, null, null],
      anchor: { kind: "departAt", wallClock: "2026-09-01T09:00" },
      baseRequest: {},
      planTrip,
      capabilities: CAPABILITIES,
    });

    expect(plan.warnings).toContainEqual({
      kind: "missed-connection",
      afterSegmentIndex: 0,
      overlapSeconds: 900,
    });
  });

  it("reports a deadline the chain cannot meet as a late arrival", async () => {
    const planTrip = vi.fn(async (request: TripPlanRequest) => {
      const departure = Date.parse(request.departureTime as string);
      return result([
        itinerary(
          new Date(departure).toISOString(),
          new Date(departure + 3 * 3_600_000).toISOString(),
        ),
      ]);
    });

    const plan = await planTransitChain({
      waypoints: [COLOGNE, BONN],
      // 09:00 in Europe/Berlin is 07:00 UTC; a three-hour leg lands at 10:00 UTC.
      schedules: [null, { arriveBy: "2026-09-01T09:30", timeZone: "UTC" }],
      anchor: { kind: "departAt", wallClock: "2026-09-01T09:00" },
      baseRequest: {},
      planTrip,
      capabilities: CAPABILITIES,
    });

    expect(plan.schedule.violations).toContainEqual(
      expect.objectContaining({ kind: "late-arrival", waypointIndex: 1 }),
    );
  });

  it("carries the shared planning preferences onto every segment", async () => {
    const requests: TripPlanRequest[] = [];
    const planTrip = vi.fn(async (request: TripPlanRequest) => {
      requests.push(request);
      const departure = Date.parse(request.departureTime as string);
      return result([
        itinerary(
          new Date(departure).toISOString(),
          new Date(departure + 30 * 60_000).toISOString(),
        ),
      ]);
    });

    await planTransitChain({
      waypoints: [COLOGNE, BONN, AACHEN],
      schedules: [null, null, null],
      anchor: { kind: "departAt", wallClock: "2026-09-01T09:00" },
      baseRequest: { modes: ["BUS", "RAIL"], wheelchairRequired: true },
      planTrip,
      capabilities: CAPABILITIES,
      numItinerariesPerSegment: 3,
    });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.modes).toEqual(["BUS", "RAIL"]);
      expect(request.wheelchairRequired).toBe(true);
      expect(request.numItineraries).toBe(3);
    }
  });
});
