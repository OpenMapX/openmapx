import {
  type FakeHttpClient,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { createRisClient, type RisClient } from "@openmapx/mobility-core/ris-client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  germanWallClock,
  mapLang,
  mapTrip,
  parseDuration,
  planJourney,
  risCanHonor,
} from "./provider.js";

type TripInput = Parameters<typeof mapTrip>[0];
type LegInput = NonNullable<TripInput["legs"]>[number];

/** A leg mapped as a trip of its own. */
const mapLeg = (leg: LegInput) => mapTrip({ legs: [leg] })?.legs[0] ?? null;

function mockOk(data: unknown) {
  return data;
}

const at = (time: string, latitude = 50.9, longitude = 6.9) => ({
  time,
  position: { latitude, longitude },
});

describe("parseDuration", () => {
  it.each<[string | undefined, number]>([
    ["PT1H23M40S", 5020],
    ["PT45M", 2700],
    ["PT30S", 30],
    ["PT2H", 7200],
    ["P1DT2H", 93600],
    ["PT0.5S", 0.5],
    ["PT1M0.25S", 60.25],
    ["garbagePT1Hgarbage", 0],
    ["PT1Hjunk", 0],
    ["", 0],
    [undefined, 0],
    ["garbage", 0],
  ])("parseDuration(%j) -> %s", (iso, expected) => {
    expect(parseDuration(iso)).toBe(expected);
  });
});

describe("mapLang", () => {
  it.each([
    ["de", "DE"],
    ["EN", "EN"],
    ["fr", "FR"],
    ["pl", "PL"],
    ["xx", "EN"],
    [undefined, "EN"],
  ])("mapLang(%j) -> %s", (lang, expected) => {
    expect(mapLang(lang)).toBe(expected);
  });
});

describe("mapLeg", () => {
  it("leaves out CONNECT legs", () => {
    expect(mapLeg({ type: "CONNECT" })).toBeNull();
  });

  it("maps a WALK leg as a walking leg with a straight-line geometry", () => {
    const leg = mapLeg({
      type: "WALK",
      origin: { name: "A", time: "2026-03-10T10:00:00Z", position: { latitude: 50, longitude: 6 } },
      destination: {
        name: "B",
        time: "2026-03-10T10:05:00Z",
        position: { latitude: 51, longitude: 7 },
      },
    } satisfies LegInput);

    expect(leg).toMatchObject({
      mode: "walking",
      startTime: "2026-03-10T10:00:00Z",
      endTime: "2026-03-10T10:05:00Z",
      from: { name: "A", lat: 50, lng: 6 },
      to: { name: "B", lat: 51, lng: 7 },
      geometry: {
        type: "LineString",
        coordinates: [
          [6, 50],
          [7, 51],
        ],
      },
    });
    expect(leg?.route).toBeUndefined();
  });

  it("maps a JOURNEY leg with route, trip id, mode and via-stop count", () => {
    const leg = mapLeg({
      type: "JOURNEY",
      departure: {
        name: "Köln Hbf",
        time: "2026-03-10T10:00:00Z",
        evaNumber: "8000207",
        position: { latitude: 50.9, longitude: 6.9 },
      },
      arrival: {
        name: "Frankfurt Hbf",
        time: "2026-03-10T11:00:00Z",
        evaNumber: "8000105",
        position: { latitude: 50.1, longitude: 8.6 },
      },
      transport: { category: "HIGH_SPEED_TRAIN", line: "ICE 521", direction: "Frankfurt" },
      journeyID: "j-1",
      viaStops: [{ name: "v1" }, { name: "v2" }],
    } satisfies LegInput);

    expect(leg).toMatchObject({
      mode: "rail",
      from: { name: "Köln Hbf", stopId: "ris:8000207" },
      to: { name: "Frankfurt Hbf", stopId: "ris:8000105" },
      route: { shortName: "ICE 521", longName: "Frankfurt" },
      tripId: "ris:j-1",
      _intermediateStopCount: 2,
    });
  });

  it("falls back to rail mode for an unknown transit category", () => {
    const leg = mapLeg({
      type: "JOURNEY",
      departure: at("2026-03-10T10:00:00Z"),
      arrival: at("2026-03-10T10:30:00Z", 51, 7),
      transport: { category: "UNKNOWN_THING", number: "42" },
    } satisfies LegInput);
    expect(leg?.mode).toBe("rail");
    expect(leg?.route).toEqual({ shortName: "42", longName: "" });
  });

  it("draws the leg's polyline and places an end RIS left unplaced on it", () => {
    const leg = mapLeg({
      type: "JOURNEY",
      departure: { time: "2026-03-10T10:00:00Z" },
      arrival: at("2026-03-10T10:30:00Z", 40.7, -120.95),
      // Google's documented example: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453).
      polyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
    });
    expect(leg?.from).toMatchObject({ lat: 38.5, lng: -120.2 });
    expect(leg?.geometry.coordinates).toHaveLength(3);
  });

  it.each([
    ["an end without a position", { departure: { time: "2026-03-10T10:00:00Z" } }],
    [
      "an end outside the coordinate range",
      { departure: { time: "2026-03-10T10:00:00Z", position: { latitude: 95, longitude: 6 } } },
    ],
    ["an end without a time", { departure: { position: { latitude: 50, longitude: 6 } } }],
  ])(
    "leaves out a lone leg with %s that nothing else places or times, instead of placing it at 0° N 0° E",
    (_label, departure) => {
      expect(
        mapLeg({
          type: "JOURNEY",
          ...departure,
          arrival: at("2026-03-10T10:30:00Z"),
        } as LegInput),
      ).toBeNull();
    },
  );
});

describe("mapTrip", () => {
  it("derives duration from leg times and counts transfers between transit legs", () => {
    const trip: TripInput = {
      legs: [
        {
          type: "JOURNEY",
          departure: at("2026-03-10T10:00:00Z"),
          arrival: at("2026-03-10T10:30:00Z"),
          transport: { category: "REGIONAL_TRAIN", line: "RE1" },
        },
        {
          type: "JOURNEY",
          departure: at("2026-03-10T10:35:00Z"),
          arrival: at("2026-03-10T11:00:00Z"),
          transport: { category: "SUBWAY", line: "U1" },
        },
      ],
    };

    const itinerary = mapTrip(trip);
    expect(itinerary?.startTime).toBe("2026-03-10T10:00:00Z");
    expect(itinerary?.endTime).toBe("2026-03-10T11:00:00Z");
    expect(itinerary?.duration).toBe(3600);
    expect(itinerary?.transfers).toBe(1);
    expect(itinerary?.legs).toHaveLength(2);
  });

  it("estimates walk distance from walk-leg durations and skips CONNECT legs", () => {
    const trip: TripInput = {
      duration: "PT20M",
      legs: [
        {
          type: "WALK",
          duration: "PT12M",
          origin: at("2026-03-10T10:00:00Z"),
          destination: at("2026-03-10T10:12:00Z"),
        },
        { type: "CONNECT" },
      ],
    };

    const itinerary = mapTrip(trip);
    // 12 min at 5 km/h ≈ 1000 m.
    expect(itinerary?.walkDistance).toBe(1000);
    expect(itinerary?.transfers).toBe(0);
    expect(itinerary?.legs).toHaveLength(1);
  });

  it("falls back to the trip-level ISO duration when the leg times give none", () => {
    const sameTime = at("2026-03-10T10:00:00Z");
    const itinerary = mapTrip({
      duration: "PT15M",
      legs: [{ type: "WALK", origin: sameTime, destination: sameTime }],
    });
    expect(itinerary?.duration).toBe(900);
  });

  it("uses fixed day/fractional durations for fallback travel time and walk distance", () => {
    const sameTime = at("2026-03-10T10:00:00Z");
    const itinerary = mapTrip({
      duration: "P1DT2H",
      legs: [{ type: "WALK", duration: "PT1M0.5S", origin: sameTime, destination: sameTime }],
    });
    expect(itinerary?.duration).toBe(93600);
    expect(itinerary?.walkDistance).toBe(84);
  });

  it("places and times walking legs from the request, their neighbours and their duration", () => {
    const itinerary = mapTrip(
      {
        legs: [
          { type: "WALK", duration: "PT5M", origin: { name: "Start" }, destination: {} },
          {
            type: "JOURNEY",
            departure: { name: "Köln Hbf", ...at("2026-03-10T10:06:00Z", 50.94, 6.96) },
            arrival: { name: "Bonn Hbf", ...at("2026-03-10T10:30:00Z", 50.73, 7.1) },
            transport: { category: "REGIONAL_TRAIN", line: "RE5" },
          },
          { type: "WALK", duration: "PT3M", origin: {}, destination: {} },
        ],
      },
      { origin: { lat: 50.95, lng: 6.95 }, destination: { lat: 50.72, lng: 7.11 } },
    );

    expect(itinerary?.legs.map((leg) => [leg.from, leg.to, leg.startTime, leg.endTime])).toEqual([
      [
        { name: "Start", lat: 50.95, lng: 6.95 },
        { name: "", lat: 50.94, lng: 6.96 },
        "2026-03-10T10:01:00.000Z",
        "2026-03-10T10:06:00Z",
      ],
      [
        { name: "Köln Hbf", lat: 50.94, lng: 6.96 },
        { name: "Bonn Hbf", lat: 50.73, lng: 7.1 },
        "2026-03-10T10:06:00Z",
        "2026-03-10T10:30:00Z",
      ],
      [
        { name: "", lat: 50.73, lng: 7.1 },
        { name: "", lat: 50.72, lng: 7.11 },
        "2026-03-10T10:30:00Z",
        "2026-03-10T10:33:00.000Z",
      ],
    ]);
  });

  it("places a transfer stop RIS left unplaced from the leg on its other side", () => {
    const itinerary = mapTrip({
      legs: [
        {
          type: "JOURNEY",
          departure: at("2026-03-10T10:00:00Z", 50.9, 6.9),
          arrival: { time: "2026-03-10T10:30:00Z" },
        },
        {
          type: "JOURNEY",
          departure: at("2026-03-10T10:35:00Z", 50.7, 7.1),
          arrival: at("2026-03-10T11:00:00Z", 50.3, 7.6),
        },
      ],
    });
    expect(itinerary?.legs[0]?.to).toMatchObject({ lat: 50.7, lng: 7.1 });
  });

  it("leaves out a trip only when a transfer stop has no position on either side", () => {
    expect(
      mapTrip(
        {
          legs: [
            {
              type: "JOURNEY",
              departure: at("2026-03-10T10:00:00Z"),
              arrival: { time: "2026-03-10T10:30:00Z" },
            },
            {
              type: "JOURNEY",
              departure: { time: "2026-03-10T10:35:00Z" },
              arrival: at("2026-03-10T11:00:00Z"),
            },
          ],
        },
        { origin: { lat: 50.9, lng: 6.9 }, destination: { lat: 50.3, lng: 7.6 } },
      ),
    ).toBeNull();
  });
});

describe("planJourney", () => {
  let mockFetch: Mock<(input: FakeHttpRequest) => unknown>;
  let transport: FakeHttpClient;
  let risClient: RisClient;

  beforeEach(() => {
    mockFetch = vi.fn<(input: FakeHttpRequest) => unknown>();
    transport = fakeHttpClient((request) => mockFetch(request));
    risClient = createRisClient({ clientId: "cid", apiKey: "key" }, transport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when credentials are not configured", async () => {
    const unconfigured = createRisClient({}, transport);
    expect(await planJourney(unconfigured, 50, 6, 51, 7, "2026-03-10", "10:00")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("posts a routing request and maps the first trip's endpoints into a plan", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        trips: [
          {
            legs: [
              {
                type: "JOURNEY",
                departure: {
                  name: "Köln Hbf",
                  time: "2026-03-10T10:00:00Z",
                  position: { latitude: 50.9, longitude: 6.9 },
                },
                arrival: {
                  name: "Frankfurt Hbf",
                  time: "2026-03-10T11:00:00Z",
                  position: { latitude: 50.1, longitude: 8.6 },
                },
                transport: { category: "HIGH_SPEED_TRAIN", line: "ICE 521" },
              },
            ],
          },
        ],
      }),
    );

    const plan = await planJourney(risClient, 50.9, 6.9, 50.1, 8.6, "2026-03-10", "10:00");

    expect(plan).not.toBeNull();
    expect(plan?.from).toEqual({ name: "Köln Hbf", lat: 50.9, lng: 6.9 });
    expect(plan?.to).toEqual({ name: "Frankfurt Hbf", lat: 50.1, lng: 8.6 });
    expect(plan?.itineraries).toHaveLength(1);
    const body = transport.calls[0]?.body;
    expect(body).toMatchObject({ provider: "HAFAS", departureTime: "2026-03-10T10:00" });
  });

  it("places a first leg RIS left unplaced at the requested origin and leaves out untimed trips", async () => {
    const leg = (departure: Record<string, unknown>) => ({
      type: "JOURNEY",
      departure,
      arrival: at("2026-03-10T11:00:00Z", 50.1, 8.6),
      transport: { category: "HIGH_SPEED_TRAIN", line: "ICE 521" },
    });
    mockFetch.mockResolvedValueOnce(
      mockOk({
        trips: [
          { legs: [leg({ name: "Untimed", ...at("", 50.9, 6.9) })] },
          { legs: [leg({ name: "Köln Hbf", time: "2026-03-10T10:05:00Z" })] },
        ],
      }),
    );

    const plan = await planJourney(risClient, 50.94, 6.96, 50.1, 8.6, "2026-03-10", "10:00");

    expect(plan?.itineraries).toHaveLength(1);
    expect(plan?.from).toEqual({ name: "Köln Hbf", lat: 50.94, lng: 6.96 });
  });

  it("returns null when the routing response has no trips", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ trips: [] }));
    expect(await planJourney(risClient, 50, 6, 51, 7, "2026-03-10", "10:00")).toBeNull();
  });
});

describe("risCanHonor", () => {
  it("can serve an unconstrained request", () => {
    expect(risCanHonor({})).toBe(true);
    expect(risCanHonor({ modes: [] })).toBe(true);
  });

  it("serves the all-transit default as unrestricted", () => {
    expect(risCanHonor({ modes: ["TRANSIT"] })).toBe(true);
    expect(risCanHonor({ modes: ["TRANSIT", "BUS"] })).toBe(true);
  });

  it("defers when a mode allow-list is requested (no API mode filter)", () => {
    expect(risCanHonor({ modes: ["REGIONAL_RAIL"] })).toBe(false);
  });

  it("defers when the Deutschlandticket filter is requested", () => {
    expect(risCanHonor({ deutschlandticketOnly: true })).toBe(false);
  });
});

describe("germanWallClock", () => {
  it.each([
    ["winter", "2026-01-15T07:30:00Z", "2026-01-15", "08:30"],
    ["summer", "2026-07-01T06:30:00Z", "2026-07-01", "08:30"],
    ["the first minute after spring-forward", "2026-03-29T01:00:00Z", "2026-03-29", "03:00"],
    ["the second pass through fall-back", "2026-10-25T01:30:00Z", "2026-10-25", "02:30"],
    [
      "a UTC evening that is already tomorrow in Germany",
      "2026-11-10T23:15:00Z",
      "2026-11-11",
      "00:15",
    ],
  ])("renders %s on the Berlin clock", (_case, instant, date, time) => {
    expect(germanWallClock(new Date(instant))).toEqual({ date, time });
  });
});
