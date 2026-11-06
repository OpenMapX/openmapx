import type { Departure, TransitStop, VehicleJourney } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { dbNavigatorExamples } from "./__fixtures__/dbNavigator";
import { parseSharedTravelPlan } from "./index";
import { resolveSharedTravelPlan, type TravelPlanPort } from "./resolve";

const positions: Record<string, [number, number]> = {
  "Aachen Hbf": [6.105, 50.771],
  "Köln Hbf": [6.959, 50.943],
  "Berlin Hbf": [13.369, 52.525],
};
const iso = (wall: string) => new Date(`${wall}:00+01:00`).toISOString();
function fixture(text = dbNavigatorExamples[0]) {
  const parsed = parseSharedTravelPlan(text);
  if (parsed.kind !== "travel-plan") throw new Error("fixture");
  const plan = parsed.plan;
  const stop = (name: string): TransitStop => ({
    id: `ms:${name}`,
    name,
    lng: positions[name][0],
    lat: positions[name][1],
    modes: ["rail"],
    provider: "ms",
  });
  const departures: Departure[] = plan.legs.map((l, i) => ({
    tripId: `ms:trip-${i}`,
    route: { id: "route", shortName: l.service, longName: "", mode: "rail" },
    scheduledAt: iso(l.departure),
    headsign: l.headsign ?? "",
    serviceInfo: { trainNumber: l.trainNumber },
    stop: { id: stop(l.from).id, name: l.from },
  }));
  const journeys: VehicleJourney[] = plan.legs.map((l, i) => ({
    id: departures[i].tripId,
    provider: "ms",
    name: l.service,
    stops: [
      {
        stopId: stop(l.from).id,
        name: l.from,
        lat: stop(l.from).lat,
        lng: stop(l.from).lng,
        scheduledDeparture: iso(l.departure),
      },
      {
        stopId: stop(l.to).id,
        name: l.to,
        lat: stop(l.to).lat,
        lng: stop(l.to).lng,
        scheduledArrival: iso(l.arrival),
      },
    ],
  }));
  const port: TravelPlanPort = {
    searchStops: vi.fn(async (name) => [stop(name)]),
    departures: vi.fn(async (id) => departures.filter((d) => d.stop?.id === id)),
    journey: vi.fn(async (id) => journeys.find((j) => j.id === id)!),
    geometry: vi.fn(async () => null),
  };
  return { plan, port, departures, journeys, stop };
}
describe("explicit shared trip resolution", () => {
  it.each(dbNavigatorExamples)(
    "resolves every supplied exact train sequence without Pareto planning",
    async (text) => {
      const f = fixture(text);
      const result = await resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal);
      expect(result.itinerary.legs.map((l) => l.tripShortName)).toEqual(
        f.plan.legs.map((l) => l.trainNumber),
      );
      expect(result.itinerary.legs.map((l) => l.tripId)).toEqual(f.departures.map((d) => d.tripId));
      expect(result.itinerary.refreshToken).toBeUndefined();
      expect(result.schematic).toBe(true);
      expect(f.port.departures).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("2026-11-"),
        expect.any(AbortSignal),
      );
      expect(f.port.searchStops).toHaveBeenCalledTimes(
        new Set(f.plan.legs.flatMap((l) => [l.from, l.to])).size,
      );
    },
  );
  it.each(["train", "arrival", "departure", "missing-number", "far-station", "conflicting-number"])(
    "rejects %s instead of substituting a train",
    async (kind) => {
      const f = fixture();
      if (kind === "train") f.departures[0].serviceInfo = { trainNumber: "99999" };
      if (kind === "missing-number") f.departures[0].serviceInfo = undefined;
      if (kind === "conflicting-number") f.journeys[0].serviceInfo = { trainNumber: "99999" };
      if (kind === "arrival") f.journeys[0].stops[1].scheduledArrival = "2026-11-06T21:12:00Z";
      if (kind === "departure") f.journeys[0].stops[0].scheduledDeparture = "2026-11-06T20:19:00Z";
      if (kind === "far-station") f.journeys[0].stops[1].lat = 49;
      await expect(
        resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal),
      ).rejects.toMatchObject({ code: "not-found" });
    },
  );
  it("keeps realtime delays, cancellation and current platforms without using them for identity", async () => {
    const f = fixture();
    f.departures[0].canceled = true;
    f.departures[0].contributors = [{ sourceId: "test", name: "Test timetable" }];
    f.journeys[0].stops[0].expectedDeparture = "2026-11-06T20:23:00Z";
    f.journeys[0].stops[0].platform = "5";
    f.journeys[0].stops[0].scheduledPlatform = "3";
    const result = await resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal);
    expect(result.itinerary.legs[0]).toMatchObject({
      cancelled: true,
      startTime: "2026-11-06T20:23:00Z",
      scheduledStartTime: "2026-11-06T20:18:00.000Z",
      from: { platformCode: "5", scheduledPlatformCode: "3" },
    });
    expect(result.itinerary.contributors).toEqual(f.departures[0].contributors);
  });
  it("rejects distinct matching trips but deduplicates identical board rows", async () => {
    const f = fixture();
    f.departures.push({ ...f.departures[0] });
    await expect(
      resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal),
    ).resolves.toBeDefined();
    f.departures.push({ ...f.departures[0], tripId: "ms:second" });
    f.journeys.push({ ...f.journeys[0], id: "ms:second" });
    await expect(
      resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal),
    ).rejects.toMatchObject({ code: "ambiguous" });
  });
  it("rejects geographically distinct stations and cancellation before acquisition", async () => {
    const f = fixture();
    f.port.searchStops = vi.fn(async (name) => [f.stop(name), { ...f.stop(name), lat: 48 }]);
    await expect(
      resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal),
    ).rejects.toMatchObject({ code: "ambiguous" });
    const abort = new AbortController();
    abort.abort();
    f.port.searchStops = vi.fn();
    await expect(resolveSharedTravelPlan(f.plan, f.port, abort.signal)).rejects.toBeDefined();
    expect(f.port.searchStops).not.toHaveBeenCalled();
  });
  it.each(["2026-03-29T02:18", "2026-10-25T02:18"])(
    "rejects DST discontinuity %s",
    async (departure) => {
      const f = fixture();
      f.plan.legs[0].departure = departure;
      await expect(
        resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal),
      ).rejects.toMatchObject({ code: "invalid" });
    },
  );
});

it("accepts established station mode prefixes, zero-padded train numbers and explicit line classes", async () => {
  const f = fixture(dbNavigatorExamples[2]);
  f.port.searchStops = vi.fn(async (name) => [
    { ...f.stop(name), name: name === "Berlin Hbf" ? "S+U Berlin Hauptbahnhof" : name },
  ]);
  f.journeys[1].stops[1].name = "S+U Berlin Hauptbahnhof";
  f.departures[0].serviceInfo = { trainNumber: "010937" };
  await expect(
    resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal),
  ).resolves.toBeDefined();
  f.departures[0].route.shortName = "IC 10937";
  await expect(
    resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal),
  ).rejects.toMatchObject({ code: "not-found" });
});
it("does not use a regional line number as operational train identity", async () => {
  const f = fixture();
  f.plan.legs[0].trainNumber = "9";
  f.departures[0].serviceInfo = undefined;
  f.departures[0].route.shortName = "RE 9";
  await expect(
    resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal),
  ).rejects.toMatchObject({ code: "not-found" });
});
it("settles the overall deadline even if an acquisition ignores its abort signal", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.port.searchStops = vi.fn(() => new Promise(() => {}));
    const pending = resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(60001);
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});
