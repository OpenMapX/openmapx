import type {
  Departure,
  TransitStop,
  TripItinerary,
  VehicleJourney,
} from "@openmapx/mobility-core/transit";
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
  const providerTrip: TripItinerary = {
    id: "provider-plan",
    source: "transit-motis-local",
    instance: "ms",
    datasetEpoch: "epoch-1",
    startTime: iso(plan.legs[0].departure),
    endTime: iso(plan.legs.at(-1)?.arrival ?? ""),
    duration: 3180,
    transfers: plan.legs.length - 1,
    walkDistance: 0,
    legs: plan.legs.map((l, i) => ({
      mode: "rail",
      tripId: departures[i].tripId,
      tripShortName: l.trainNumber,
      from: { ...stop(l.from), stopId: stop(l.from).id },
      to: { ...stop(l.to), stopId: stop(l.to).id },
      route: departures[i].route,
      startTime: iso(l.departure),
      endTime: iso(l.arrival),
      scheduledStartTime: iso(l.departure),
      scheduledEndTime: iso(l.arrival),
      cancelled: false,
      geometry: { type: "LineString", coordinates: [positions[l.from], positions[l.to]] },
    })),
  };
  const providerPlan = () => ({
    data: {
      from: stop(plan.origin),
      to: stop(plan.destination),
      itineraries: [providerTrip],
      provider: "ms",
      datasetEpoch: "epoch-1",
    },
    attributions: [],
    freshness: { fetchedAt: "2026-11-06T19:00:00Z", isStale: false, hasRealtimeData: true },
  });
  const port: TravelPlanPort = {
    searchStops: vi.fn(async (name) => [stop(name)]),
    departures: vi.fn(async (id) => departures.filter((d) => d.stop?.id === id)),
    journey: vi.fn(async (id) => {
      const journey = journeys.find((j) => j.id === id);
      if (!journey) throw new Error("Missing fixture journey");
      return journey;
    }),
    plan: vi.fn(async () => providerPlan()),
    resolveTrip: vi.fn(async () => providerPlan()),
  };
  return { plan, port, departures, journeys, stop, providerTrip };
}
describe("explicit shared trip resolution", () => {
  it.each(dbNavigatorExamples)(
    "selects the exact provider train sequence for every supplied share",
    async (text) => {
      const f = fixture(text);
      const result = await resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal);
      expect(result.plan.data.itineraries[0].legs.map((l) => l.tripShortName)).toEqual(
        f.plan.legs.map((l) => l.trainNumber),
      );
      expect(result.plan.data.itineraries[0].legs.map((l) => l.tripId)).toEqual(
        f.departures.map((d) => d.tripId),
      );
      expect(result.plan.data.itineraries[0].refreshToken).toBeUndefined();
      expect(result.query.kind).toBe("search");
      expect(result.plan.data.itineraries[0]).toBe(f.providerTrip);
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
    f.providerTrip.legs[0].cancelled = true;
    f.providerTrip.legs[0].startTime = "2026-11-06T20:23:00Z";
    f.providerTrip.legs[0].from.platformCode = "5";
    f.providerTrip.legs[0].from.scheduledPlatformCode = "3";
    f.providerTrip.contributors = f.departures[0].contributors;
    const result = await resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal);
    expect(result.plan.data.itineraries[0].legs[0]).toMatchObject({
      cancelled: true,
      startTime: "2026-11-06T20:23:00Z",
      scheduledStartTime: "2026-11-06T20:18:00.000Z",
      from: { platformCode: "5", scheduledPlatformCode: "3" },
    });
    expect(result.plan.data.itineraries[0].contributors).toEqual(f.departures[0].contributors);
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
    f.port.searchStops = vi.fn(() => new Promise<TransitStop[]>(() => {}));
    const pending = resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(60001);
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});

it("resolves an overnight trip within its deadline despite slow independent station lookups", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(dbNavigatorExamples[3]);
    const search = f.port.searchStops;
    const plan = f.port.plan;
    f.port.searchStops = vi.fn(async (...args: Parameters<TravelPlanPort["searchStops"]>) => {
      await new Promise((resolve) => setTimeout(resolve, 18000));
      return search(...args);
    });
    f.port.plan = vi.fn(async (...args: Parameters<TravelPlanPort["plan"]>) => {
      await new Promise((resolve) => setTimeout(resolve, 8000));
      return plan(...args);
    });
    let outcome: unknown;
    const pending = resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal).then(
      (value) => {
        outcome = value;
      },
      (error) => {
        outcome = error;
      },
    );
    await vi.advanceTimersByTimeAsync(65000);
    await pending;
    expect(outcome).toMatchObject({ plan: { data: { provider: "ms" } } });
  } finally {
    vi.useRealTimers();
  }
});

it("bounds concurrent station discovery to three requests", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.plan.legs = Array.from({ length: 8 }, (_, i) => ({
      ...f.plan.legs[0],
      from: `Station ${i}`,
      to: `Station ${i + 1}`,
      departure: `2026-11-07T${String(i * 2).padStart(2, "0")}:00`,
      arrival: `2026-11-07T${String(i * 2 + 1).padStart(2, "0")}:00`,
    }));
    let active = 0;
    let peak = 0;
    f.port.searchStops = vi.fn(async (name: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return [{ ...f.stop("Aachen Hbf"), id: `ms:${name}`, name }];
    });
    const pending = resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ code: "not-found" });
    expect(f.port.searchStops).toHaveBeenCalledTimes(9);
    expect(peak).toBeLessThanOrEqual(3);
  } finally {
    vi.useRealTimers();
  }
});

it("queries a parent station once even when discovery returns more than four platform children", async () => {
  const f = fixture();
  f.port.searchStops = vi.fn(async (name) => [
    f.stop(name),
    ...Array.from({ length: 8 }, (_, i) => ({
      ...f.stop(name),
      id: `ms:platform-${name}-${i}`,
      parentStationId: f.stop(name).id,
    })),
  ]);
  await expect(
    resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal),
  ).resolves.toBeDefined();
  expect(f.port.departures).toHaveBeenCalledTimes(1);
});
it("accepts bounded colocated platform/feed records when the provider omits parent links", async () => {
  const f = fixture();
  f.port.searchStops = vi.fn(async (name) =>
    Array.from({ length: 20 }, (_, i) => ({
      ...f.stop(name),
      id: i === 0 ? f.stop(name).id : `ms:alias-${name}-${i}`,
    })),
  );
  await expect(
    resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal),
  ).resolves.toBeDefined();
  expect(f.port.departures).toHaveBeenCalledTimes(20);
});
it("a skipped intermediate stop does not cancel the ridden leg", async () => {
  const f = fixture();
  f.journeys[0].stops.splice(1, 0, {
    stopId: "ms:skip",
    name: "Skipped",
    lat: 50.8,
    lng: 6.4,
    canceled: true,
  });
  const result = await resolveSharedTravelPlan(f.plan, f.port, new AbortController().signal);
  expect(result.plan.data.itineraries[0].legs[0].cancelled).toBe(false);
});
