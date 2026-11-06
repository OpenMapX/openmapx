import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TripItinerary, TripPlan } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { dbNavigatorExamples } from "./__fixtures__/dbNavigator";
import { parseSharedTravelPlan } from "./index";
import { resolveSharedTravelPlan, type TravelPlanPort } from "./resolve";

function fixture() {
  const parsed = parseSharedTravelPlan(dbNavigatorExamples[0]);
  if (parsed.kind !== "travel-plan") throw new Error("fixture");
  const from = { stopId: "ms:a", name: "Aachen Hauptbahnhof", lat: 50.768, lng: 6.091 };
  const to = { stopId: "ms:b", name: "Koeln Hauptbahnhof", lat: 50.943, lng: 6.959 };
  const trip: TripItinerary = {
    id: "provider-trip",
    source: "transit-motis-local",
    instance: "ms",
    datasetEpoch: "epoch-1",
    startTime: "2026-11-06T20:23:00Z",
    endTime: "2026-11-06T21:16:00Z",
    duration: 3180,
    transfers: 0,
    walkDistance: 0,
    distanceMeters: 71000,
    fare: { source: "provider", transfers: [{ legProducts: [] }] },
    refreshToken: "ordinary-provider-refresh",
    legs: [
      {
        mode: "rail",
        tripId: "ms:10935",
        tripShortName: "10935",
        route: { shortName: "RE 9", longName: "Provider route" },
        startTime: "2026-11-06T20:23:00Z",
        endTime: "2026-11-06T21:16:00Z",
        scheduledStartTime: "2026-11-06T20:18:00Z",
        scheduledEndTime: "2026-11-06T21:11:00Z",
        from: { ...from, platformCode: "17" },
        to: { ...to, platformCode: "8" },
        geometry: {
          type: "LineString",
          coordinates: [
            [6.091, 50.768],
            [6.5, 50.91],
            [6.959, 50.943],
          ],
        },
      },
    ],
  };
  const envelope: MobilityEnvelope<TripPlan> = {
    data: {
      from,
      to,
      provider: "ms",
      source: "transit-motis-local",
      datasetEpoch: "epoch-1",
      itineraries: [
        { ...trip, id: "wrong", legs: [{ ...trip.legs[0], tripId: "ms:another" }] },
        trip,
      ],
      nextPageToken: "ordinary-signed-next-page",
    },
    attributions: [],
    freshness: { fetchedAt: "2026-11-06T19:00:00Z", isStale: false, hasRealtimeData: true },
  };
  const plan = vi.fn(async () => envelope);
  const resolveTrip = vi.fn(async () => ({
    ...envelope,
    data: { ...envelope.data, itineraries: [trip], nextPageToken: undefined },
  }));
  const port = {
    searchStops: vi.fn(async (name: string) => [
      {
        ...(name === "Aachen Hbf" ? from : to),
        id: name === "Aachen Hbf" ? from.stopId : to.stopId,
        provider: "ms",
        modes: ["rail"],
      },
    ]),
    departures: vi.fn(async () => [
      {
        tripId: "ms:10935",
        stop: { id: from.stopId, name: from.name },
        route: { mode: "rail", shortName: "RE9", longName: "Provider route" },
        serviceInfo: { trainNumber: "10935" },
        scheduledAt: "2026-11-06T20:18:00Z",
        headsign: "Provider headsign",
      },
    ]),
    journey: vi.fn(async () => ({
      id: "ms:10935",
      provider: "ms",
      name: "RE9",
      stops: [
        { ...from, scheduledDeparture: "2026-11-06T20:18:00Z" },
        { ...to, scheduledArrival: "2026-11-06T21:11:00Z" },
      ],
    })),
    geometry: vi.fn(async () => null),
    plan,
    resolveTrip,
  };
  return { shared: parsed.plan, trip, envelope, port, plan, resolveTrip };
}

describe("shared text selects provider plans without composing their data", () => {
  it("returns the complete ordinary provider envelope and selects the exact train, not the first result", async () => {
    const f = fixture();
    const result = await resolveSharedTravelPlan(
      f.shared,
      f.port as unknown as TravelPlanPort,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      plan: f.envelope,
      selectedItineraryKey: expect.stringContaining("provider-trip"),
    });
    expect((result as unknown as { plan: MobilityEnvelope<TripPlan> }).plan).toBe(f.envelope);
    expect(f.plan).toHaveBeenCalled();
    expect(f.resolveTrip).not.toHaveBeenCalled();
    expect(f.port.geometry).not.toHaveBeenCalled();
  });

  it("uses a truthful provider-reference query for an exact trip missing from ordinary search", async () => {
    const f = fixture();
    f.plan.mockResolvedValue({
      ...f.envelope,
      data: { ...f.envelope.data, itineraries: [], nextPageToken: undefined },
    });
    const result = await resolveSharedTravelPlan(
      f.shared,
      f.port as unknown as TravelPlanPort,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      query: { kind: "reference" },
      plan: { data: { itineraries: [f.trip] } },
    });
    expect(f.resolveTrip).toHaveBeenCalled();
  });

  it("rejects a provider reconstruction that substituted a different train", async () => {
    const f = fixture();
    f.plan.mockResolvedValue({
      ...f.envelope,
      data: { ...f.envelope.data, itineraries: [], nextPageToken: undefined },
    });
    f.resolveTrip.mockResolvedValue({
      ...f.envelope,
      data: {
        ...f.envelope.data,
        itineraries: [{ ...f.trip, legs: [{ ...f.trip.legs[0], tripId: "ms:wrong" }] }],
        nextPageToken: undefined,
      },
    });
    await expect(
      resolveSharedTravelPlan(
        f.shared,
        f.port as unknown as TravelPlanPort,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});
