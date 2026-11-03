import type { DirectionsResult, LngLat, Route } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import {
  byDistance,
  MEASURED_PARKING,
  measureParkingLegs,
  type ParkingLegs,
  rankParking,
} from "./arrivalParkingLegs";
import type { NearbyParkingPlace } from "./nearbyParking";

const CAR: LngLat = [10, 50];
const DESTINATION: LngLat = [10, 50.001];
const ROUTER = [{ sourceId: "valhalla", name: "Valhalla" }];

function lot(id: string, offset: number, over: Partial<NearbyParkingPlace> = {}) {
  return { id, name: id, coordinates: [10 + offset / 1000, 50.001] as LngLat, ...over };
}

function routed(duration: number, distance: number): DirectionsResult {
  const route = {
    distance,
    duration,
    geometry: [],
    legs: [],
    steps: [],
    mode: "walking",
    contributors: ROUTER,
  } as unknown as Route;
  return { routes: [route], provider: "valhalla" } as DirectionsResult;
}

type Plan = (waypoints: LngLat[], signal: AbortSignal) => Promise<DirectionsResult>;

/** A mock as the planner a measurement takes. */
function planner(mock: ReturnType<typeof vi.fn>): Plan {
  return (waypoints, signal) => mock(waypoints, signal) as Promise<DirectionsResult>;
}

/** Answers by the car park a leg starts or ends at, from per-id tables. */
function router(table: Record<string, DirectionsResult | Error>, end: "first" | "last") {
  return vi.fn(async (...args: unknown[]) => {
    const waypoints = args[0] as LngLat[];
    const point = end === "first" ? waypoints[0] : waypoints.at(-1);
    const id = `p${Math.round(((point?.[0] ?? 0) - 10) * 1000)}`;
    const answer = table[id];
    if (!answer || answer instanceof Error) throw answer ?? new Error(`no answer for ${id}`);
    return answer;
  });
}

describe("measureParkingLegs", () => {
  it("measures the drive to each car park and the walk on to the destination", async () => {
    const drive = router({ p1: routed(60, 400), p2: routed(30, 200) }, "last");
    const walk = router({ p1: routed(120, 150), p2: routed(300, 380) }, "first");
    const legs = await measureParkingLegs({
      from: CAR,
      destination: DESTINATION,
      candidates: [lot("p1", 1), lot("p2", 2)],
      signal: new AbortController().signal,
      drive: planner(drive),
      walk: planner(walk),
    });

    expect(legs).toEqual([
      {
        id: "p1",
        kind: "network",
        driveSeconds: 60,
        walk: { seconds: 120, meters: 150, contributors: ROUTER },
      },
      {
        id: "p2",
        kind: "network",
        driveSeconds: 30,
        walk: { seconds: 300, meters: 380, contributors: ROUTER },
      },
    ]);
    expect(drive).toHaveBeenCalledWith([CAR, [10.001, 50.001]], expect.any(AbortSignal));
    expect(walk).toHaveBeenCalledWith([[10.001, 50.001], DESTINATION], expect.any(AbortSignal));
  });

  it("tells a car park no route reaches from one it could not measure", async () => {
    const legs = await measureParkingLegs({
      from: CAR,
      destination: DESTINATION,
      candidates: [lot("p1", 1), lot("p2", 2), lot("p3", 3), lot("p4", 4)],
      signal: new AbortController().signal,
      drive: planner(
        router({ p1: { routes: [] } as unknown as DirectionsResult, p2: routed(30, 200) }, "last"),
      ),
      walk: planner(
        router({ p2: { routes: [] } as unknown as DirectionsResult, p3: routed(60, 80) }, "first"),
      ),
    });
    expect(legs.map((leg) => [leg.id, leg.kind])).toEqual([
      ["p1", "unreachable"],
      ["p2", "unreachable"],
      // The drive to p3 failed, so its walk was never asked; p4 had no answers at all.
      ["p3", "unknown"],
      ["p4", "unknown"],
    ]);
  });

  it("measures a bounded shortlist with at most two requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return routed(10, 10);
    });
    const candidates = Array.from({ length: 9 }, (_, i) => lot(`p${i + 1}`, i + 1));
    const legs = await measureParkingLegs({
      from: CAR,
      destination: DESTINATION,
      candidates,
      signal: new AbortController().signal,
      drive: planner(slow),
      walk: planner(slow),
    });
    expect(legs).toHaveLength(MEASURED_PARKING);
    expect(slow).toHaveBeenCalledTimes(MEASURED_PARKING * 2);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("rejects when cancelled rather than reporting partial measurements", async () => {
    const controller = new AbortController();
    const drive = vi.fn(async () => {
      controller.abort();
      return routed(10, 10);
    });
    await expect(
      measureParkingLegs({
        from: CAR,
        destination: DESTINATION,
        candidates: [lot("p1", 1)],
        signal: controller.signal,
        drive: planner(drive),
        walk: planner(vi.fn(async () => routed(10, 10))),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("rankParking", () => {
  const network = (id: string, driveSeconds: number, walkSeconds: number): ParkingLegs => ({
    id,
    kind: "network",
    driveSeconds,
    walk: { seconds: walkSeconds, meters: walkSeconds, contributors: ROUTER },
  });

  it("orders by distance, full sites last, until the legs are measured", () => {
    const closest = byDistance(
      [lot("p3", 3), lot("p1", 1, { full: true }), lot("p2", 2), lot("p4", 4), lot("p5", 5)],
      DESTINATION,
    );
    expect(closest.map((p) => p.id)).toEqual(["p2", "p3", "p4", "p5", "p1"]);
    expect(rankParking(closest, null).map((p) => p.id)).toEqual(["p2", "p3", "p4", "p5"]);
  });

  it("puts the quickest drive and walk first and drops what no route reaches", () => {
    const closest = [lot("p1", 1), lot("p2", 2), lot("p3", 3), lot("p4", 4), lot("p5", 5)];
    const ranked = rankParking(closest, [
      // Closest, but across a one-way loop.
      network("p1", 240, 60),
      network("p2", 40, 90),
      { id: "p3", kind: "unreachable" },
      { id: "p4", kind: "unknown" },
      network("p5", 50, 100),
    ]);
    expect(ranked.map((p) => p.id)).toEqual(["p2", "p5", "p1", "p4"]);
    expect(ranked[0]?.walk).toEqual({ seconds: 90, meters: 90, contributors: ROUTER });
    expect(ranked[3]).not.toHaveProperty("walk");
  });

  it("keeps a site reported full last even when it is quickest", () => {
    const ranked = rankParking(
      [lot("p1", 1, { full: true }), lot("p2", 2)],
      [network("p1", 10, 10), network("p2", 100, 100)],
    );
    expect(ranked.map((p) => p.id)).toEqual(["p2", "p1"]);
  });
});
