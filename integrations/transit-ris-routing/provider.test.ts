import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isConfigured, mapLang, mapLeg, mapTrip, parseDuration, planJourney } from "./provider.js";
import { setRisCredentials } from "./ris-client.js";

type LegInput = Parameters<typeof mapLeg>[0];
type TripInput = Parameters<typeof mapTrip>[0];

function mockOk(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}

describe("parseDuration", () => {
  it.each<[string | undefined, number]>([
    ["PT1H23M40S", 5020],
    ["PT45M", 2700],
    ["PT30S", 30],
    ["PT2H", 7200],
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
  it("returns null for CONNECT legs", () => {
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
      transport: { category: "UNKNOWN_THING", number: "42" },
    } satisfies LegInput);
    expect(leg?.mode).toBe("rail");
    expect(leg?.route).toEqual({ shortName: "42", longName: "" });
  });
});

describe("mapTrip", () => {
  it("derives duration from leg times and counts transfers between transit legs", () => {
    const trip: TripInput = {
      legs: [
        {
          type: "JOURNEY",
          departure: { time: "2026-03-10T10:00:00Z" },
          arrival: { time: "2026-03-10T10:30:00Z" },
          transport: { category: "REGIONAL_TRAIN", line: "RE1" },
        },
        {
          type: "JOURNEY",
          departure: { time: "2026-03-10T10:35:00Z" },
          arrival: { time: "2026-03-10T11:00:00Z" },
          transport: { category: "SUBWAY", line: "U1" },
        },
      ],
    };

    const itinerary = mapTrip(trip);
    expect(itinerary.startTime).toBe("2026-03-10T10:00:00Z");
    expect(itinerary.endTime).toBe("2026-03-10T11:00:00Z");
    expect(itinerary.duration).toBe(3600);
    expect(itinerary.transfers).toBe(1);
    expect(itinerary.legs).toHaveLength(2);
  });

  it("estimates walk distance from walk-leg durations and skips CONNECT legs", () => {
    const trip: TripInput = {
      duration: "PT20M",
      legs: [
        {
          type: "WALK",
          duration: "PT12M",
          origin: { time: "2026-03-10T10:00:00Z", position: { latitude: 0, longitude: 0 } },
          destination: { time: "2026-03-10T10:12:00Z", position: { latitude: 0, longitude: 0 } },
        },
        { type: "CONNECT" },
      ],
    };

    const itinerary = mapTrip(trip);
    // 12 min at 5 km/h ≈ 1000 m.
    expect(itinerary.walkDistance).toBe(1000);
    expect(itinerary.transfers).toBe(0);
    expect(itinerary.legs).toHaveLength(1);
  });

  it("falls back to the trip-level ISO duration when no leg times are present", () => {
    const itinerary = mapTrip({ duration: "PT15M", legs: [{ type: "WALK" }] });
    expect(itinerary.duration).toBe(900);
  });
});

describe("planJourney", () => {
  beforeEach(() => {
    setRisCredentials({ clientId: "cid", apiKey: "key" });
  });

  afterEach(() => {
    setRisCredentials({});
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns null when credentials are not configured", async () => {
    setRisCredentials({});
    expect(isConfigured()).toBe(false);
    expect(await planJourney(50, 6, 51, 7, "2026-03-10", "10:00")).toBeNull();
  });

  it("posts a routing request and maps the first trip's endpoints into a plan", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
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
    vi.stubGlobal("fetch", mockFetch);

    const plan = await planJourney(50.9, 6.9, 50.1, 8.6, "2026-03-10", "10:00");

    expect(plan).not.toBeNull();
    expect(plan?.from).toEqual({ name: "Köln Hbf", lat: 50.9, lng: 6.9 });
    expect(plan?.to).toEqual({ name: "Frankfurt Hbf", lat: 50.1, lng: 8.6 });
    expect(plan?.itineraries).toHaveLength(1);
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ provider: "HAFAS", departureTime: "2026-03-10T10:00" });
  });

  it("returns null when the routing response has no trips", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockOk({ trips: [] })));
    expect(await planJourney(50, 6, 51, 7, "2026-03-10", "10:00")).toBeNull();
  });
});
