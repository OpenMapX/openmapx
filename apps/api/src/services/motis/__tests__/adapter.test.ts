import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@motis-project/motis-client", () => ({
  stops: vi.fn(),
  stoptimes: vi.fn(),
  plan: vi.fn(),
  trips: vi.fn(),
  trip: vi.fn(),
  geocode: vi.fn(),
}));

vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@openmapx/core");
  return {
    ...actual,
    decodePolyline: (_encoded: string): [number, number][] => [
      [13.4, 52.5],
      [13.41, 52.51],
      [13.42, 52.52],
    ],
  };
});

import {
  getArrivals,
  getDepartures,
  getStopById,
  getStops,
  getTrip,
  getVehicleRadar,
  planTrip,
  searchByName,
} from "@integrations/transit-motis/adapter";
import type { MotisInstance } from "@integrations/transit-motis/instances";
import {
  geocode,
  stops as motisStops,
  trip as motisTrip,
  plan,
  stoptimes,
  trips,
} from "@motis-project/motis-client";

const testInstance: MotisInstance = {
  client: {} as never,
  prefix: "test:",
  provider: "test-provider",
};

afterEach(() => {
  vi.clearAllMocks();
});

// getStops

describe("getStops", () => {
  it("maps Place[] to TransitStop[] with prefixed IDs", async () => {
    vi.mocked(motisStops).mockResolvedValueOnce({
      data: [
        {
          stopId: "de:12345",
          name: "Berlin Hbf",
          lat: 52.525,
          lon: 13.369,
          modes: ["RAIL", "SUBWAY"],
          parentId: undefined,
        },
      ],
      error: undefined,
    } as never);

    const result = await getStops(testInstance, [13.0, 52.0, 14.0, 53.0]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("test:de:12345");
    expect(result[0].name).toBe("Berlin Hbf");
    expect(result[0].lat).toBe(52.525);
    expect(result[0].lng).toBe(13.369);
    expect(result[0].modes).toContain("rail");
    expect(result[0].modes).toContain("subway");
    expect(result[0].provider).toBe("test-provider");
  });

  it("passes bbox as min/max query params in south,west / north,east format", async () => {
    vi.mocked(motisStops).mockResolvedValueOnce({ data: [], error: undefined } as never);

    await getStops(testInstance, [13.0, 52.0, 14.0, 53.0]);

    expect(motisStops).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { min: "52,13", max: "53,14" },
      }),
    );
  });

  it("prefixes parentStationId when parentId is set", async () => {
    vi.mocked(motisStops).mockResolvedValueOnce({
      data: [
        {
          stopId: "child:1",
          name: "Platform A",
          lat: 52.5,
          lon: 13.4,
          modes: [],
          parentId: "parent:1",
        },
      ],
      error: undefined,
    } as never);

    const result = await getStops(testInstance, [13.0, 52.0, 14.0, 53.0]);

    expect(result[0].parentStationId).toBe("test:parent:1");
  });

  it("returns empty array when data is null", async () => {
    vi.mocked(motisStops).mockResolvedValueOnce({ data: null, error: undefined } as never);

    const result = await getStops(testInstance, [13.0, 52.0, 14.0, 53.0]);

    expect(result).toEqual([]);
  });

  it("returns empty array on error", async () => {
    vi.mocked(motisStops).mockRejectedValueOnce(new Error("network error"));

    const result = await getStops(testInstance, [13.0, 52.0, 14.0, 53.0]);

    expect(result).toEqual([]);
  });
});

// getStopById

describe("getStopById", () => {
  it("returns TransitStop from stoptimes place", async () => {
    vi.mocked(stoptimes).mockResolvedValueOnce({
      data: {
        place: {
          stopId: "de:12345",
          name: "Berlin Hbf",
          lat: 52.525,
          lon: 13.369,
          modes: ["RAIL"],
          parentId: undefined,
        },
        stopTimes: [],
      },
      error: undefined,
    } as never);

    const result = await getStopById(testInstance, "test:de:12345");

    expect(result).not.toBeNull();
    expect(result?.id).toBe("test:de:12345");
    expect(result?.name).toBe("Berlin Hbf");
    expect(result?.provider).toBe("test-provider");
  });

  it("strips instance prefix before querying", async () => {
    vi.mocked(stoptimes).mockResolvedValueOnce({
      data: {
        place: {
          stopId: "de:12345",
          name: "Test Stop",
          lat: 52.0,
          lon: 13.0,
          modes: [],
          parentId: undefined,
        },
        stopTimes: [],
      },
      error: undefined,
    } as never);

    await getStopById(testInstance, "test:de:12345");

    expect(stoptimes).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ stopId: "de:12345", n: 0, window: 0 }),
      }),
    );
  });

  it("returns null when place is missing", async () => {
    vi.mocked(stoptimes).mockResolvedValueOnce({
      data: { place: null, stopTimes: [] },
      error: undefined,
    } as never);

    const result = await getStopById(testInstance, "test:de:12345");

    expect(result).toBeNull();
  });

  it("returns null on error", async () => {
    vi.mocked(stoptimes).mockRejectedValueOnce(new Error("fail"));

    const result = await getStopById(testInstance, "test:de:12345");

    expect(result).toBeNull();
  });
});

// searchByName

describe("searchByName", () => {
  it("maps STOP-type geocode results to TransitStop[]", async () => {
    vi.mocked(geocode).mockResolvedValueOnce({
      data: [
        { type: "STOP", id: "de:99999", name: "München Hbf", lat: 48.14, lon: 11.56 },
        { type: "STOP", id: "de:88888", name: "München Ost", lat: 48.13, lon: 11.6 },
      ],
      error: undefined,
    } as never);

    const result = await searchByName(testInstance, "München", 10);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("test:de:99999");
    expect(result[0].name).toBe("München Hbf");
    expect(result[0].lat).toBe(48.14);
    expect(result[0].lng).toBe(11.56);
    expect(result[0].modes).toEqual([]);
    expect(result[0].provider).toBe("test-provider");
  });

  it("also accepts PLACE type results", async () => {
    vi.mocked(geocode).mockResolvedValueOnce({
      data: [{ type: "PLACE", id: "place:1", name: "Test Place", lat: 48.0, lon: 11.0 }],
      error: undefined,
    } as never);

    const result = await searchByName(testInstance, "Test", 10);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("test:place:1");
  });

  it("filters out results without an id", async () => {
    vi.mocked(geocode).mockResolvedValueOnce({
      data: [
        { type: "STOP", id: null, name: "No ID Stop", lat: 48.0, lon: 11.0 },
        { type: "STOP", id: "de:11111", name: "Valid Stop", lat: 48.1, lon: 11.1 },
      ],
      error: undefined,
    } as never);

    const result = await searchByName(testInstance, "stop", 10);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("test:de:11111");
  });

  it("respects the limit parameter", async () => {
    vi.mocked(geocode).mockResolvedValueOnce({
      data: [
        { type: "STOP", id: "s1", name: "Stop 1", lat: 48.0, lon: 11.0 },
        { type: "STOP", id: "s2", name: "Stop 2", lat: 48.1, lon: 11.1 },
        { type: "STOP", id: "s3", name: "Stop 3", lat: 48.2, lon: 11.2 },
      ],
      error: undefined,
    } as never);

    const result = await searchByName(testInstance, "Stop", 2);

    expect(result).toHaveLength(2);
  });

  it("returns empty array when data is null", async () => {
    vi.mocked(geocode).mockResolvedValueOnce({ data: null, error: undefined } as never);

    const result = await searchByName(testInstance, "anything", 10);

    expect(result).toEqual([]);
  });

  it("returns empty array on error", async () => {
    vi.mocked(geocode).mockRejectedValueOnce(new Error("fail"));

    const result = await searchByName(testInstance, "anything", 10);

    expect(result).toEqual([]);
  });
});

// getDepartures

describe("getDepartures", () => {
  it("maps StopTime[] to Departure[] with correct route fields", async () => {
    vi.mocked(stoptimes).mockResolvedValueOnce({
      data: {
        place: { stopId: "de:12345", name: "Test", lat: 52.0, lon: 13.0, modes: [] },
        stopTimes: [
          {
            tripId: "trip:1",
            routeId: "route:1",
            routeShortName: "S1",
            routeLongName: "S-Bahn 1",
            displayName: "S1",
            headsign: "Spandau",
            mode: "SUBURBAN",
            routeColor: "#FF0000",
            realTime: false,
            cancelled: false,
            tripCancelled: false,
            place: {
              scheduledDeparture: "2026-03-21T10:00:00Z",
              scheduledArrival: "2026-03-21T09:59:00Z",
              departure: "2026-03-21T10:00:00Z",
              arrival: "2026-03-21T09:59:00Z",
              track: "3",
              scheduledTrack: "3",
            },
          },
        ],
      },
      error: undefined,
    } as never);

    const result = await getDepartures(testInstance, "test:de:12345", 60);

    expect(result).toHaveLength(1);
    const dep = result[0];
    expect(dep.tripId).toBe("test:trip:1");
    expect(dep.route.id).toBe("test:route:1");
    expect(dep.route.shortName).toBe("S1");
    expect(dep.route.longName).toBe("S-Bahn 1");
    expect(dep.route.mode).toBe("rail");
    expect(dep.route.color).toBe("FF0000");
    expect(dep.headsign).toBe("Spandau");
    expect(dep.scheduledAt).toBe("2026-03-21T10:00:00Z");
    expect(dep.platform).toBe("3");
    expect(dep.canceled).toBe(false);
  });

  it("computes delaySeconds when realTime is true and times differ", async () => {
    vi.mocked(stoptimes).mockResolvedValueOnce({
      data: {
        place: { stopId: "de:12345", name: "Test", lat: 52.0, lon: 13.0, modes: [] },
        stopTimes: [
          {
            tripId: "trip:2",
            routeId: "route:2",
            routeShortName: "U2",
            routeLongName: "",
            displayName: "U2",
            headsign: "Pankow",
            mode: "SUBWAY",
            routeColor: null,
            realTime: true,
            cancelled: false,
            tripCancelled: false,
            place: {
              scheduledDeparture: "2026-03-21T10:00:00Z",
              scheduledArrival: undefined,
              departure: "2026-03-21T10:03:00Z",
              arrival: undefined,
              track: undefined,
              scheduledTrack: undefined,
            },
          },
        ],
      },
      error: undefined,
    } as never);

    const result = await getDepartures(testInstance, "test:de:12345", 60);

    expect(result[0].delaySeconds).toBe(180);
    expect(result[0].expectedAt).toBe("2026-03-21T10:03:00Z");
  });

  it("does not set delay when realTime is false", async () => {
    vi.mocked(stoptimes).mockResolvedValueOnce({
      data: {
        place: { stopId: "de:12345", name: "Test", lat: 52.0, lon: 13.0, modes: [] },
        stopTimes: [
          {
            tripId: "trip:3",
            routeId: "route:3",
            routeShortName: "Bus 100",
            routeLongName: "",
            displayName: null,
            headsign: "Zoo",
            mode: "BUS",
            routeColor: null,
            realTime: false,
            cancelled: false,
            tripCancelled: false,
            place: {
              scheduledDeparture: "2026-03-21T10:00:00Z",
              scheduledArrival: undefined,
              departure: "2026-03-21T10:05:00Z",
              arrival: undefined,
              track: undefined,
              scheduledTrack: undefined,
            },
          },
        ],
      },
      error: undefined,
    } as never);

    const result = await getDepartures(testInstance, "test:de:12345", 60);

    expect(result[0].delaySeconds).toBeUndefined();
    expect(result[0].expectedAt).toBeUndefined();
  });

  it("sets canceled to true when cancelled flag is set", async () => {
    vi.mocked(stoptimes).mockResolvedValueOnce({
      data: {
        place: { stopId: "de:12345", name: "Test", lat: 52.0, lon: 13.0, modes: [] },
        stopTimes: [
          {
            tripId: "trip:4",
            routeId: "route:4",
            routeShortName: "RE1",
            routeLongName: "",
            displayName: null,
            headsign: "Frankfurt",
            mode: "RAIL",
            routeColor: null,
            realTime: true,
            cancelled: true,
            tripCancelled: false,
            place: {
              scheduledDeparture: "2026-03-21T10:00:00Z",
              scheduledArrival: undefined,
              departure: "2026-03-21T10:00:00Z",
              arrival: undefined,
              track: undefined,
              scheduledTrack: undefined,
            },
          },
        ],
      },
      error: undefined,
    } as never);

    const result = await getDepartures(testInstance, "test:de:12345", 60);

    expect(result[0].canceled).toBe(true);
  });

  it("strips instance prefix before querying and uses arriveBy=false", async () => {
    vi.mocked(stoptimes).mockResolvedValueOnce({
      data: { place: null, stopTimes: [] },
      error: undefined,
    } as never);

    await getDepartures(testInstance, "test:de:12345", 30);

    expect(stoptimes).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ stopId: "de:12345", arriveBy: false }),
      }),
    );
  });

  it("returns empty array on error", async () => {
    vi.mocked(stoptimes).mockRejectedValueOnce(new Error("fail"));

    const result = await getDepartures(testInstance, "test:de:12345", 60);

    expect(result).toEqual([]);
  });
});

// getArrivals

describe("getArrivals", () => {
  it("uses scheduledArrival for scheduledAt instead of scheduledDeparture", async () => {
    vi.mocked(stoptimes).mockResolvedValueOnce({
      data: {
        place: { stopId: "de:12345", name: "Test", lat: 52.0, lon: 13.0, modes: [] },
        stopTimes: [
          {
            tripId: "trip:5",
            routeId: "route:5",
            routeShortName: "ICE 500",
            routeLongName: "",
            displayName: null,
            headsign: "Hamburg",
            mode: "HIGHSPEED_RAIL",
            routeColor: null,
            realTime: true,
            cancelled: false,
            tripCancelled: false,
            place: {
              scheduledDeparture: "2026-03-21T10:05:00Z",
              scheduledArrival: "2026-03-21T10:00:00Z",
              departure: "2026-03-21T10:06:00Z",
              arrival: "2026-03-21T10:02:00Z",
              track: undefined,
              scheduledTrack: undefined,
            },
          },
        ],
      },
      error: undefined,
    } as never);

    const result = await getArrivals(testInstance, "test:de:12345", 60);

    expect(result).toHaveLength(1);
    expect(result[0].scheduledAt).toBe("2026-03-21T10:00:00Z");
    expect(result[0].expectedAt).toBe("2026-03-21T10:02:00Z");
    expect(result[0].delaySeconds).toBe(120);
  });

  it("queries with arriveBy=true", async () => {
    vi.mocked(stoptimes).mockResolvedValueOnce({
      data: { place: null, stopTimes: [] },
      error: undefined,
    } as never);

    await getArrivals(testInstance, "test:de:12345", 30);

    expect(stoptimes).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ arriveBy: true }),
      }),
    );
  });
});

// planTrip

describe("planTrip", () => {
  it("returns TripPlan with mapped itineraries and decoded geometry", async () => {
    vi.mocked(plan).mockResolvedValueOnce({
      data: {
        from: { name: "Origin", lat: 52.5, lon: 13.4 },
        to: { name: "Destination", lat: 52.52, lon: 13.42 },
        itineraries: [
          {
            duration: 1200,
            transfers: 1,
            legs: [
              {
                mode: "WALK",
                startTime: "2026-03-21T10:00:00Z",
                endTime: "2026-03-21T10:05:00Z",
                scheduledStartTime: "2026-03-21T10:00:00Z",
                scheduledEndTime: "2026-03-21T10:05:00Z",
                from: { name: "Origin", lat: 52.5, lon: 13.4, stopId: undefined },
                to: { name: "Stop A", lat: 52.51, lon: 13.41, stopId: "de:stop1" },
                routeShortName: undefined,
                routeLongName: undefined,
                routeId: undefined,
                tripId: undefined,
                displayName: undefined,
                routeColor: undefined,
                legGeometry: null,
                intermediateStops: [],
                distance: 300,
              },
              {
                mode: "TRAM",
                startTime: "2026-03-21T10:08:00Z",
                endTime: "2026-03-21T10:20:00Z",
                scheduledStartTime: "2026-03-21T10:08:00Z",
                scheduledEndTime: "2026-03-21T10:20:00Z",
                from: { name: "Stop A", lat: 52.51, lon: 13.41, stopId: "de:stop1" },
                to: { name: "Stop B", lat: 52.52, lon: 13.42, stopId: "de:stop2" },
                routeShortName: "M1",
                routeLongName: "Tram M1",
                routeId: "route:tram1",
                tripId: "trip:tram1",
                displayName: "M1",
                routeColor: null,
                legGeometry: { points: "encodedPolyline", precision: 5 },
                intermediateStops: [
                  { name: "Mid Stop", lat: 52.515, lon: 13.415, stopId: "de:mid" },
                ],
                distance: 900,
              },
            ],
            fareTransfers: [],
          },
        ],
      },
      error: undefined,
    } as never);

    const result = await planTrip(testInstance, 52.5, 13.4, 52.52, 13.42, "2026-03-21", "10:00:00");

    expect(result).not.toBeNull();
    if (!result) throw new Error("result was null");

    expect(result.from.name).toBe("Origin");
    expect(result.to.name).toBe("Destination");
    expect(result.itineraries).toHaveLength(1);

    const itin = result.itineraries[0];
    expect(itin.duration).toBe(1200);
    expect(itin.transfers).toBe(1);

    const walkLeg = itin.legs[0];
    expect(walkLeg.mode).toBe("walking");
    expect(walkLeg.route).toBeUndefined();
    expect(walkLeg.to.stopId).toBe("test:de:stop1");

    const tramLeg = itin.legs[1];
    expect(tramLeg.mode).toBe("tram");
    expect(tramLeg.route).toBeDefined();
    expect(tramLeg.route?.shortName).toBe("M1");
    expect(tramLeg.tripId).toBe("test:trip:tram1");
    expect(tramLeg.routeId).toBe("test:route:tram1");
    expect(tramLeg.from.stopId).toBe("test:de:stop1");
    expect(tramLeg.to.stopId).toBe("test:de:stop2");
    expect(tramLeg._intermediateStopCount).toBe(1);
    expect(tramLeg.geometry.type).toBe("LineString");
    expect(tramLeg.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to scheduled times when start and end times are equal (bad GTFS-RT)", async () => {
    vi.mocked(plan).mockResolvedValueOnce({
      data: {
        from: { name: "A", lat: 52.5, lon: 13.4 },
        to: { name: "B", lat: 52.52, lon: 13.42 },
        itineraries: [
          {
            duration: 600,
            transfers: 0,
            legs: [
              {
                mode: "BUS",
                startTime: "2026-03-21T10:00:00Z",
                endTime: "2026-03-21T10:00:00Z",
                scheduledStartTime: "2026-03-21T10:00:00Z",
                scheduledEndTime: "2026-03-21T10:10:00Z",
                from: { name: "A", lat: 52.5, lon: 13.4, stopId: "s1" },
                to: { name: "B", lat: 52.52, lon: 13.42, stopId: "s2" },
                routeShortName: "100",
                routeLongName: "Bus 100",
                routeId: "r100",
                tripId: "t100",
                displayName: "100",
                routeColor: null,
                legGeometry: null,
                intermediateStops: [],
                distance: 500,
              },
            ],
            fareTransfers: [],
          },
        ],
      },
      error: undefined,
    } as never);

    const result = await planTrip(testInstance, 52.5, 13.4, 52.52, 13.42, "2026-03-21", "10:00:00");

    expect(result?.itineraries[0].legs[0].startTime).toBe("2026-03-21T10:00:00Z");
    expect(result?.itineraries[0].legs[0].endTime).toBe("2026-03-21T10:10:00Z");
  });

  it("returns null when itineraries are empty", async () => {
    vi.mocked(plan).mockResolvedValueOnce({
      data: { from: null, to: null, itineraries: [] },
      error: undefined,
    } as never);

    const result = await planTrip(testInstance, 52.5, 13.4, 52.52, 13.42, "2026-03-21", "10:00:00");

    expect(result).toBeNull();
  });

  it("returns null on error", async () => {
    vi.mocked(plan).mockRejectedValueOnce(new Error("fail"));

    const result = await planTrip(testInstance, 52.5, 13.4, 52.52, 13.42, "2026-03-21", "10:00:00");

    expect(result).toBeNull();
  });
});

// getVehicleRadar

describe("getVehicleRadar", () => {
  it("maps TripSegment[] to VehiclePosition[] with prefixed IDs", async () => {
    vi.mocked(trips).mockResolvedValueOnce({
      data: [
        {
          trips: [{ tripId: "trip:bus1", displayName: "Bus 200" }],
          from: { lat: 52.5, lon: 13.4, stopId: "stop:1" },
          departure: "2026-03-21T10:01:00Z",
        },
      ],
      error: undefined,
    } as never);

    const result = await getVehicleRadar(testInstance, [13.0, 52.0, 14.0, 53.0]);

    expect(result).toHaveLength(1);
    const vp = result[0];
    expect(vp.id).toBe("test:trip:bus1");
    expect(vp.provider).toBe("test-provider");
    expect(vp.tripId).toBe("test:trip:bus1");
    expect(vp.lat).toBe(52.5);
    expect(vp.lng).toBe(13.4);
    expect(vp.label).toBe("Bus 200");
    expect(vp.currentStopId).toBe("test:stop:1");
    expect(vp.updatedAt).toBe("2026-03-21T10:01:00Z");
  });

  it("skips segments without lat/lon", async () => {
    vi.mocked(trips).mockResolvedValueOnce({
      data: [
        {
          trips: [{ tripId: "trip:a", displayName: "A" }],
          from: { lat: undefined, lon: undefined, stopId: undefined },
          departure: undefined,
        },
        {
          trips: [{ tripId: "trip:b", displayName: "B" }],
          from: { lat: 52.5, lon: 13.4, stopId: "stop:b" },
          departure: "2026-03-21T10:00:00Z",
        },
      ],
      error: undefined,
    } as never);

    const result = await getVehicleRadar(testInstance, [13.0, 52.0, 14.0, 53.0]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("test:trip:b");
  });

  it("uses seg-N fallback id when tripId is missing", async () => {
    vi.mocked(trips).mockResolvedValueOnce({
      data: [
        {
          trips: [],
          from: { lat: 52.5, lon: 13.4, stopId: undefined },
          departure: undefined,
        },
      ],
      error: undefined,
    } as never);

    const result = await getVehicleRadar(testInstance, [13.0, 52.0, 14.0, 53.0]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("test:seg-0");
  });

  it("returns empty array when data is null", async () => {
    vi.mocked(trips).mockResolvedValueOnce({ data: null, error: undefined } as never);

    const result = await getVehicleRadar(testInstance, [13.0, 52.0, 14.0, 53.0]);

    expect(result).toEqual([]);
  });

  it("returns empty array on error", async () => {
    vi.mocked(trips).mockRejectedValueOnce(new Error("fail"));

    const result = await getVehicleRadar(testInstance, [13.0, 52.0, 14.0, 53.0]);

    expect(result).toEqual([]);
  });
});

// getTrip

describe("getTrip", () => {
  it("maps trip legs to VehicleJourney with all stops", async () => {
    vi.mocked(motisTrip).mockResolvedValueOnce({
      data: {
        legs: [
          {
            routeShortName: "S7",
            headsign: "Potsdam",
            from: {
              stopId: "stop:origin",
              name: "Berlin Hbf",
              lat: 52.525,
              lon: 13.369,
              scheduledArrival: undefined,
              scheduledDeparture: "2026-03-21T10:00:00Z",
              arrival: undefined,
              departure: "2026-03-21T10:00:00Z",
              track: "5",
              scheduledTrack: "5",
              cancelled: false,
            },
            to: {
              stopId: "stop:dest",
              name: "Potsdam Hbf",
              lat: 52.391,
              lon: 13.067,
              scheduledArrival: "2026-03-21T10:30:00Z",
              scheduledDeparture: undefined,
              arrival: "2026-03-21T10:30:00Z",
              departure: undefined,
              track: "3",
              scheduledTrack: "3",
              cancelled: false,
            },
            intermediateStops: [
              {
                stopId: "stop:mid",
                name: "Wannsee",
                lat: 52.42,
                lon: 13.18,
                scheduledArrival: "2026-03-21T10:15:00Z",
                scheduledDeparture: "2026-03-21T10:16:00Z",
                arrival: "2026-03-21T10:15:00Z",
                departure: "2026-03-21T10:16:00Z",
                track: undefined,
                scheduledTrack: undefined,
                cancelled: false,
              },
            ],
          },
        ],
      },
      error: undefined,
    } as never);

    const result = await getTrip(testInstance, "test:trip:s7-1");

    expect(result).not.toBeNull();
    if (!result) throw new Error("result was null");

    expect(result.id).toBe("test:trip:s7-1");
    expect(result.name).toBe("S7");
    expect(result.provider).toBe("test-provider");
    expect(result.stops).toHaveLength(3);

    expect(result.stops[0].stopId).toBe("test:stop:origin");
    expect(result.stops[0].name).toBe("Berlin Hbf");
    expect(result.stops[0].platform).toBe("5");

    expect(result.stops[1].stopId).toBe("test:stop:mid");
    expect(result.stops[1].name).toBe("Wannsee");

    expect(result.stops[2].stopId).toBe("test:stop:dest");
    expect(result.stops[2].name).toBe("Potsdam Hbf");
  });

  it("strips instance prefix before querying", async () => {
    vi.mocked(motisTrip).mockResolvedValueOnce({
      data: {
        legs: [
          {
            routeShortName: "RE1",
            headsign: "Frankfurt",
            from: {
              stopId: "stop:a",
              name: "A",
              lat: 52.0,
              lon: 13.0,
              scheduledDeparture: "2026-03-21T10:00:00Z",
              scheduledArrival: undefined,
              departure: "2026-03-21T10:00:00Z",
              arrival: undefined,
              track: undefined,
              scheduledTrack: undefined,
              cancelled: false,
            },
            to: {
              stopId: "stop:b",
              name: "B",
              lat: 52.1,
              lon: 13.1,
              scheduledArrival: "2026-03-21T11:00:00Z",
              scheduledDeparture: undefined,
              arrival: "2026-03-21T11:00:00Z",
              departure: undefined,
              track: undefined,
              scheduledTrack: undefined,
              cancelled: false,
            },
            intermediateStops: [],
          },
        ],
      },
      error: undefined,
    } as never);

    await getTrip(testInstance, "test:trip:re1-5");

    expect(motisTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { tripId: "trip:re1-5" },
      }),
    );
  });

  it("computes delaySeconds for stops with differing actual vs scheduled times", async () => {
    vi.mocked(motisTrip).mockResolvedValueOnce({
      data: {
        legs: [
          {
            routeShortName: "U1",
            headsign: "Uhlandstr.",
            from: {
              stopId: "stop:x",
              name: "Warschauer Str.",
              lat: 52.508,
              lon: 13.449,
              scheduledArrival: "2026-03-21T10:00:00Z",
              scheduledDeparture: "2026-03-21T10:01:00Z",
              arrival: "2026-03-21T10:03:00Z",
              departure: "2026-03-21T10:04:00Z",
              track: undefined,
              scheduledTrack: undefined,
              cancelled: false,
            },
            to: {
              stopId: "stop:y",
              name: "Kottbusser Tor",
              lat: 52.499,
              lon: 13.418,
              scheduledArrival: "2026-03-21T10:05:00Z",
              scheduledDeparture: undefined,
              arrival: "2026-03-21T10:05:00Z",
              departure: undefined,
              track: undefined,
              scheduledTrack: undefined,
              cancelled: false,
            },
            intermediateStops: [],
          },
        ],
      },
      error: undefined,
    } as never);

    const result = await getTrip(testInstance, "test:trip:u1-10");

    expect(result?.stops[0].delaySeconds).toBe(180);
  });

  it("returns null when legs are missing", async () => {
    vi.mocked(motisTrip).mockResolvedValueOnce({
      data: { legs: null },
      error: undefined,
    } as never);

    const result = await getTrip(testInstance, "test:trip:missing");

    expect(result).toBeNull();
  });

  it("returns null on error", async () => {
    vi.mocked(motisTrip).mockRejectedValueOnce(new Error("fail"));

    const result = await getTrip(testInstance, "test:trip:error");

    expect(result).toBeNull();
  });
});
