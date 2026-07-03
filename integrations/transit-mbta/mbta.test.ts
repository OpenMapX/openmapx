import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return { ...actual, decodePolyline: vi.fn(() => []) };
});

import {
  getDepartures,
  getFacilities,
  getStops,
  getVehiclePositions,
  setMbtaApiKey,
} from "./provider.js";

let mockFetch: ReturnType<typeof vi.fn>;

function mockOk(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  setMbtaApiKey("test-key");
});

afterEach(() => {
  setMbtaApiKey(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MBTA transit provider", () => {
  it("maps nearby stops and converts radius from meters to kilometers", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        data: [
          {
            id: "place-north",
            attributes: {
              name: "North Station",
              latitude: 42.3656,
              longitude: -71.0609,
              vehicle_type: 2,
            },
            relationships: {},
          },
        ],
      }),
    );

    const stops = await getStops(42.36, -71.06, 1000);

    expect(stops).toEqual([
      {
        id: "mb:place-north",
        name: "North Station",
        lat: 42.3656,
        lng: -71.0609,
        modes: ["rail"],
        platformCode: undefined,
        parentStationId: undefined,
        provider: "mb",
      },
    ]);

    const fetchUrl = String(mockFetch.mock.calls[0]?.[0]);
    expect(fetchUrl).toContain("filter%5Bradius%5D=1");
    expect(fetchUrl).toContain("api_key=test-key");
  });

  it("returns no MBTA stops without an API key", async () => {
    setMbtaApiKey(undefined);

    const stops = await getStops(42.36, -71.06, 1000);

    expect(stops).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("maps departures from prediction, route, and schedule payloads", async () => {
    const departureTime = "2026-03-10T10:05:00Z";

    mockFetch.mockResolvedValueOnce(
      mockOk({
        data: [
          {
            attributes: {
              departure_time: departureTime,
              headsign: "Alewife",
              departure_boarding_area: "A",
            },
            relationships: {
              route: { data: { id: "Red" } },
              trip: { data: { id: "trip-1" } },
              schedule: { data: { id: "sched-1" } },
            },
          },
        ],
        included: [
          {
            type: "route",
            id: "Red",
            attributes: {
              short_name: "Red",
              long_name: "Red Line",
              type: 1,
              color: "DA291C",
            },
          },
          {
            type: "schedule",
            id: "sched-1",
            attributes: { departure_time: departureTime },
          },
        ],
      }),
    );

    const departures = await getDepartures("mb:place-harvard", 30);

    expect(departures).toHaveLength(1);
    expect(departures[0]).toMatchObject({
      tripId: "trip-1",
      route: {
        id: "mb:Red",
        shortName: "Red",
        longName: "Red Line",
        mode: "subway",
        color: "DA291C",
      },
      headsign: "Alewife",
      scheduledAt: departureTime,
      platform: "A",
      canceled: false,
    });
  });

  it("maps vehicle positions and stop facilities", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        data: [
          {
            id: "v1",
            attributes: {
              latitude: 42.36,
              longitude: -71.06,
              current_stop_sequence: 5,
              updated_at: "2026-03-10T10:00:00Z",
            },
            relationships: {
              trip: { data: { id: "trip-1" } },
              stop: { data: { id: "place-north" } },
            },
          },
        ],
      }),
    );
    mockFetch.mockResolvedValueOnce(
      mockOk({
        data: [
          {
            id: "fac-1",
            attributes: {
              type: "ELEVATOR",
              long_name: "Elevator 1",
              properties: [{ name: "accessibility-accessible", value: 1 }],
            },
          },
        ],
      }),
    );

    const vehicles = await getVehiclePositions("mb:Red");
    const facilities = await getFacilities("mb:place-north");

    expect(vehicles[0]).toMatchObject({
      id: "mb:v1",
      provider: "mb",
      tripId: "mb:trip-1",
      routeId: "mb:Red",
      currentStopId: "mb:place-north",
      currentStopSequence: 5,
    });
    expect(facilities[0]).toEqual({
      id: "mb:fac-1",
      stopId: "mb:place-north",
      name: "Elevator 1",
      type: "elevator",
      isAccessible: true,
      provider: "mb",
    });
  });
});
