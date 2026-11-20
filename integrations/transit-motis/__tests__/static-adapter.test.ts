import { encodePolyline } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routeDetails: vi.fn(),
  routes: vi.fn(),
  stops: vi.fn(),
  stoptimes: vi.fn(),
  trip: vi.fn(),
}));

vi.mock("@motis-project/motis-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@motis-project/motis-client")>()),
  routeDetails: mocks.routeDetails,
  routes: mocks.routes,
  stops: mocks.stops,
  stoptimes: mocks.stoptimes,
  trip: mocks.trip,
}));

import {
  getArrivals,
  getDepartures,
  getLegGeometry,
  getRoute,
  getRouteStops,
  getRoutesForStop,
  getRoutesInBbox,
  getStopPlatforms,
  getStopTimetable,
  mapItinerary,
  mapMotisRoute,
  motisPlaceToJourneyStop,
  normalizeStop,
  normalizeStoptime,
  routeProbeBox,
} from "../adapter.js";
import { decodeMotisLineReference, encodeMotisRoutePatternId } from "../route-pattern-id.js";

const instance = { client: {} as never, prefix: "ms:", provider: "ms" };

const stop = (stopId: string, lon: number, lat: number, parentId?: string) => ({
  stopId,
  parentId,
  name: stopId,
  lon,
  lat,
  modes: ["BUS" as const],
});

const line = (coordinates: [number, number][], routeIndexes: number[]) => ({
  polyline: { points: encodePolyline(coordinates, 6), precision: 6, length: coordinates.length },
  colors: [],
  routeIndexes,
});

const route = (
  routeIdx: number,
  segments: Array<{ from: number; to: number; polyline: number }>,
) => ({
  mode: "BUS" as const,
  transitRoutes: [
    { id: `de_feed_route-${routeIdx}`, shortName: `${routeIdx}`, longName: `Route ${routeIdx}` },
  ],
  numStops: segments.length + 1,
  routeIdx,
  pathSource: "TIMETABLE" as const,
  segments,
});

describe("MOTIS static route adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes a source-backed GTFS stop code without exposing the prefixed stop id", () => {
    const normalized = normalizeStop(instance, {
      stopId: "de:1",
      name: "Aachen Hbf",
      stopCode: "AACHN",
      lon: 6.091,
      lat: 50.768,
      modes: ["RAIL"],
    });

    expect(normalized?.codes).toEqual([{ value: "AACHN", namespace: "gtfs" }]);
    expect(normalized?.codes?.map(({ value }) => value)).not.toContain("ms:de:1");
  });

  it("uses response route indexes, not internal routeIdx, and preserves segment order", () => {
    const response = {
      routes: [
        route(99, [
          { from: 0, to: 1, polyline: 0 },
          { from: 1, to: 2, polyline: 1 },
        ]),
      ],
      polylines: [
        line(
          [
            [1, 1],
            [2, 2],
          ],
          [0],
        ),
        line(
          [
            [2, 2],
            [3, 3],
          ],
          [0],
        ),
      ],
      stops: [stop("a", 1, 1), stop("b", 2, 2), stop("c", 3, 3)],
      zoomFiltered: false,
    };
    const mapped = mapMotisRoute(response, 0, "epoch-1");
    expect(mapped?.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    });
    expect(mapped?.id).toMatch(/^ms:rp:/);
  });

  it("keeps genuinely discontinuous route geometry as a MultiLineString", () => {
    const response = {
      routes: [
        route(5, [
          { from: 0, to: 1, polyline: 0 },
          { from: 1, to: 2, polyline: 1 },
        ]),
      ],
      polylines: [
        line(
          [
            [1, 1],
            [2, 2],
          ],
          [0],
        ),
        line(
          [
            [8, 8],
            [9, 9],
          ],
          [0],
        ),
      ],
      stops: [stop("a", 1, 1), stop("b", 2, 2), stop("c", 9, 9)],
      zoomFiltered: false,
    };
    expect(mapMotisRoute(response, 0, "epoch")?.geometry?.type).toBe("MultiLineString");
  });

  it("rejects stale pattern IDs before requesting route-details", async () => {
    const stale = encodeMotisRoutePatternId("old", 7, ["de_feed_route"]);
    expect(await getRoute(instance, stale, "new")).toBeNull();
    expect(mocks.routeDetails).not.toHaveBeenCalled();
  });

  it("reconstructs ordered route stops and deduplicates adjacent indexes", async () => {
    mocks.routeDetails.mockResolvedValue({
      data: {
        routes: [
          route(7, [
            { from: 0, to: 1, polyline: 0 },
            { from: 1, to: 2, polyline: 1 },
          ]),
        ],
        polylines: [
          line(
            [
              [1, 1],
              [2, 2],
            ],
            [0],
          ),
          line(
            [
              [2, 2],
              [3, 3],
            ],
            [0],
          ),
        ],
        stops: [stop("a", 1, 1), stop("b", 2, 2), stop("c", 3, 3)],
        zoomFiltered: false,
      },
    });
    const id = encodeMotisRoutePatternId("epoch", 7, ["de_feed_route-7"]);
    expect((await getRouteStops(instance, id, "epoch")).map((candidate) => candidate.id)).toEqual([
      "ms:a",
      "ms:b",
      "ms:c",
    ]);
  });

  it("finds terminus-only and seasonal patterns while excluding envelope false positives", async () => {
    mocks.stoptimes.mockResolvedValue({ data: { place: stop("root", 8, 47), stopTimes: [] } });
    mocks.routes.mockResolvedValue({
      data: {
        routes: [
          route(11, [{ from: 0, to: 1, polyline: 0 }]),
          route(12, []),
          route(13, [{ from: 2, to: 3, polyline: 1 }]),
        ],
        polylines: [
          line(
            [
              [7, 47],
              [8, 47],
            ],
            [0],
          ),
          line(
            [
              [1, 1],
              [2, 2],
            ],
            [2],
          ),
        ],
        stops: [
          stop("other", 7, 47),
          stop("platform", 8, 47, "root"),
          stop("x", 1, 1),
          stop("y", 2, 2),
        ],
        zoomFiltered: false,
      },
    });
    const routes = await getRoutesForStop(instance, "ms:root", "epoch");
    expect(routes.map((candidate) => candidate.shortName)).toEqual(["11"]);
    expect(mocks.routes.mock.calls[0][0].query.zoom).toBe(11);
    expect(mocks.stoptimes).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the stop lookup fails", () => mocks.stoptimes.mockRejectedValue(new Error("down"))],
    [
      "the stop lookup answers an error",
      () => mocks.stoptimes.mockResolvedValue({ data: undefined, error: { e: 1 } }),
    ],
    [
      "the route request answers an error",
      () => {
        mocks.stoptimes.mockResolvedValue({ data: { place: stop("root", 8, 47), stopTimes: [] } });
        mocks.routes.mockResolvedValue({ data: undefined, error: { e: 1 } });
      },
    ],
  ])("rejects when %s instead of answering no lines", async (_case, arrange) => {
    arrange();
    await expect(getRoutesForStop(instance, "ms:root", "epoch")).rejects.toThrow(/unavailable/);
  });

  it("answers no lines for a stop MOTIS does not know", async () => {
    mocks.stoptimes.mockResolvedValue({ data: { stopTimes: [] } });
    expect(await getRoutesForStop(instance, "ms:root", "epoch")).toEqual([]);
    expect(mocks.routes).not.toHaveBeenCalled();
  });
});

describe("MOTIS routes-for-stop probe sharing", () => {
  const places: Record<string, ReturnType<typeof stop>> = {
    root: stop("root", 8.005, 47.005),
    p1: stop("p1", 8.0052, 47.0051, "root"),
    p2: stop("p2", 8.0049, 47.0049, "root"),
    bay: stop("bay", 8.006, 47.006),
    lone: stop("lone", 8.0065, 47.0065),
    far: stop("far", 8.505, 47.505),
  };

  const fixture = (zoomFiltered = false) => ({
    data: {
      routes: [
        route(30, [{ from: 1, to: 4, polyline: 0 }]),
        route(10, [{ from: 0, to: 4, polyline: 0 }]),
        route(20, [{ from: 3, to: 4, polyline: 0 }]),
        route(40, [{ from: 2, to: 3, polyline: 0 }]),
        route(50, [{ from: 4, to: 4, polyline: 0 }]),
      ],
      polylines: [],
      stops: [places.root, places.p1, places.p2, places.bay, stop("x", 9, 48)],
      zoomFiltered,
    },
  });

  const stationStops = ["ms:root", "ms:p1", "ms:p2", "ms:bay", "ms:lone"];

  const gateRoutes = () => {
    const gate = Promise.withResolvers<unknown>();
    mocks.routes.mockImplementation(() => gate.promise);
    return gate;
  };

  const shortNames = (routes: Array<{ shortName: string }>) =>
    routes.map((candidate) => candidate.shortName);

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.stoptimes.mockImplementation(async ({ query }: { query: { stopId: string } }) => ({
      data: { place: places[query.stopId], stopTimes: [] },
    }));
  });

  it("issues one request for a station's stops and answers what each stop answers alone", async () => {
    const gate = gateRoutes();
    const pending = Promise.all(
      stationStops.map((stopId) => getRoutesForStop(instance, stopId, "e")),
    );
    await vi.waitFor(() => expect(mocks.routes).toHaveBeenCalledTimes(1));
    gate.resolve(fixture());
    const concurrent = await pending;

    const box = routeProbeBox(47.005, 8.005);
    expect(mocks.routes).toHaveBeenCalledTimes(1);
    expect(mocks.routes.mock.calls[0][0].query).toEqual({
      min: "46.999000,7.999000",
      max: "47.011000,8.011000",
      zoom: 11,
    });
    expect(box).toMatchObject({ min: "46.999000,7.999000", max: "47.011000,8.011000" });

    const sequential = [];
    for (const stopId of stationStops) {
      sequential.push(await getRoutesForStop(instance, stopId, "e"));
    }
    expect(mocks.routes).toHaveBeenCalledTimes(1 + stationStops.length);
    expect(sequential).toEqual(concurrent);
    expect(concurrent.map(shortNames)).toEqual([
      ["30", "10", "40"],
      ["30", "10", "40"],
      ["30", "10", "40"],
      ["20", "40"],
      [],
    ]);
  });

  it("gives stops in different grid cells their own probe", async () => {
    mocks.routes.mockResolvedValue({
      data: {
        routes: [
          route(1, [{ from: 0, to: 2, polyline: 0 }]),
          route(2, [{ from: 1, to: 2, polyline: 0 }]),
        ],
        polylines: [],
        stops: [places.root, places.far, stop("x", 9, 48)],
        zoomFiltered: false,
      },
    });
    const [near, far] = await Promise.all([
      getRoutesForStop(instance, "ms:root", "e"),
      getRoutesForStop(instance, "ms:far", "e"),
    ]);
    expect(mocks.routes).toHaveBeenCalledTimes(2);
    const boxes = [routeProbeBox(47.005, 8.005), routeProbeBox(47.505, 8.505)].map(
      ({ min, max }) => ({ min, max, zoom: 11 }),
    );
    expect(mocks.routes.mock.calls.map((call) => call[0].query)).toEqual(
      expect.arrayContaining(boxes),
    );
    expect(boxes[0]).not.toEqual(boxes[1]);
    expect(shortNames(near)).toEqual(["1"]);
    expect(shortNames(far)).toEqual(["2"]);
  });

  it.each([
    [47.005, 8.005],
    [47.0099, 8.0099],
    [47.01, 8.01],
    [-33.8688, 151.2093],
    [-0.0005, -0.0005],
    [52.5251, 13.3694],
  ])("snaps (%f, %f) to a probe box containing its ±0.001° box", (lat, lon) => {
    const { min, max } = routeProbeBox(lat, lon);
    const [minLat, minLon] = min.split(",").map(Number);
    const [maxLat, maxLon] = max.split(",").map(Number);
    expect(minLat).toBeLessThanOrEqual(lat - 0.001 + 1e-9);
    expect(minLon).toBeLessThanOrEqual(lon - 0.001 + 1e-9);
    expect(maxLat).toBeGreaterThanOrEqual(lat + 0.001 - 1e-9);
    expect(maxLon).toBeGreaterThanOrEqual(lon + 0.001 - 1e-9);
    expect(maxLat - minLat).toBeLessThanOrEqual(0.012 + 1e-9);
    expect(maxLon - minLon).toBeLessThanOrEqual(0.012 + 1e-9);
  });

  it("rejects every waiter of a failed probe and retries on the next lookup", async () => {
    const gate = gateRoutes();
    const pending = stationStops.map((stopId) => getRoutesForStop(instance, stopId, "e"));
    await vi.waitFor(() => expect(mocks.routes).toHaveBeenCalledTimes(1));
    gate.reject(new Error("down"));
    for (const call of pending) await expect(call).rejects.toThrow(/down/);
    expect(mocks.routes).toHaveBeenCalledTimes(1);

    mocks.routes.mockResolvedValue(fixture());
    expect(shortNames(await getRoutesForStop(instance, "ms:root", "e"))).toEqual([
      "30",
      "10",
      "40",
    ]);
    expect(mocks.routes).toHaveBeenCalledTimes(2);
  });

  it("rejects every waiter when the shared probe answers an error", async () => {
    const gate = gateRoutes();
    const pending = stationStops.map((stopId) => getRoutesForStop(instance, stopId, "e"));
    await vi.waitFor(() => expect(mocks.routes).toHaveBeenCalledTimes(1));
    gate.resolve({ data: undefined, error: { e: 1 } });
    for (const call of pending) await expect(call).rejects.toThrow(/unavailable/);
    expect(mocks.routes).toHaveBeenCalledTimes(1);
  });

  it("rejects every waiter when the shared response is zoom-filtered", async () => {
    const gate = gateRoutes();
    const pending = stationStops.map((stopId) => getRoutesForStop(instance, stopId, "e"));
    await vi.waitFor(() => expect(mocks.routes).toHaveBeenCalledTimes(1));
    gate.resolve(fixture(true));
    for (const call of pending) await expect(call).rejects.toThrow(/unexpectedly filtered/);
    expect(mocks.routes).toHaveBeenCalledTimes(1);
  });

  it("never shares a probe between dataset epochs", async () => {
    const gate = gateRoutes();
    const pending = Promise.all([
      getRoutesForStop(instance, "ms:root", "e1"),
      getRoutesForStop(instance, "ms:root", "e2"),
    ]);
    await vi.waitFor(() => expect(mocks.routes).toHaveBeenCalledTimes(2));
    gate.resolve(fixture());
    const [first, second] = await pending;
    const ids = (epoch: string) =>
      [30, 10, 40].map((routeIdx) =>
        encodeMotisRoutePatternId(epoch, routeIdx, [`de_feed_route-${routeIdx}`]),
      );
    expect(first.map((candidate) => candidate.id)).toEqual(ids("e1"));
    expect(second.map((candidate) => candidate.id)).toEqual(ids("e2"));
    expect(mocks.routes).toHaveBeenCalledTimes(2);
  });
});

describe("MOTIS stops, platforms, and civil-day timetable", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps current track before scheduled track", () => {
    expect(
      normalizeStop(instance, { ...stop("p", 1, 2), track: "4", scheduledTrack: "3" })
        ?.platformCode,
    ).toBe("4");
    expect(normalizeStop(instance, { ...stop("p", 1, 2), scheduledTrack: "3" })?.platformCode).toBe(
      "3",
    );
  });

  it("enumerates and deduplicates actual child places without synthesizing rows", async () => {
    mocks.stoptimes.mockResolvedValue({ data: { place: stop("root", 8, 47), stopTimes: [] } });
    mocks.stops.mockResolvedValue({
      data: [
        { ...stop("p1", 8, 47, "root"), track: "1" },
        { ...stop("p1", 8, 47, "root"), track: "1" },
        stop("other", 8, 47, "elsewhere"),
      ],
    });
    const platforms = await getStopPlatforms(instance, "ms:root");
    expect(platforms).toHaveLength(1);
    expect(platforms[0]).toMatchObject({ id: "ms:p1", platformCode: "1" });
  });

  it("paginates, deduplicates boundaries, and excludes civil-day end", async () => {
    const makeStopTime = (tripId: string, departure: string) => ({
      place: { ...stop("root", 8, 47), departure, scheduledDeparture: departure },
      mode: "BUS" as const,
      realTime: false,
      headsign: "Town",
      tripFrom: stop("a", 8, 47),
      tripTo: stop("b", 8, 48),
      agencyId: "agency",
      agencyName: "Agency",
      agencyUrl: "https://example.test",
      routeId: "de_feed_route",
      directionId: "0",
      tripId,
      routeShortName: "1",
      routeLongName: "",
      tripShortName: "",
      displayName: "1",
    });
    mocks.stoptimes
      .mockResolvedValueOnce({ data: { place: { ...stop("root", 8, 47), tz: "Europe/Berlin" } } })
      .mockResolvedValueOnce({
        data: {
          stopTimes: [makeStopTime("a", "2026-03-28T23:00:00.000Z")],
          nextPageCursor: "next",
        },
      })
      .mockResolvedValueOnce({
        data: {
          stopTimes: [
            makeStopTime("a", "2026-03-28T23:00:00.000Z"),
            makeStopTime("end", "2026-03-29T22:00:00.000Z"),
          ],
          nextPageCursor: "",
        },
      });
    const departures = await getStopTimetable(instance, "ms:root", "2026-03-29", "epoch");
    expect(departures).toHaveLength(1);
    expect(decodeMotisLineReference(departures[0].route.id)).toMatchObject({
      e: "epoch",
      r: "de_feed_route",
    });
    expect(mocks.stoptimes.mock.calls[1][0].query.time).toBe("2026-03-28T23:00:00.000Z");
    expect(mocks.stoptimes.mock.calls[2][0].query.pageCursor).toBe("next");
  });

  it("includes an event 24.5 hours into a 25-hour fall-back civil day", async () => {
    const event = {
      place: { ...stop("root", 8, 47), departure: "2026-10-25T22:30:00.000Z" },
      mode: "BUS" as const,
      realTime: false,
      headsign: "Town",
      tripFrom: stop("a", 8, 47),
      tripTo: stop("b", 8, 48),
      agencyId: "a",
      agencyName: "",
      agencyUrl: "",
      routeId: "de_feed_route",
      directionId: "0",
      tripId: "late",
      routeShortName: "1",
      routeLongName: "",
      tripShortName: "",
      displayName: "1",
    };
    mocks.stoptimes
      .mockResolvedValueOnce({ data: { place: { ...stop("root", 8, 47), tz: "Europe/Berlin" } } })
      .mockResolvedValueOnce({ data: { stopTimes: [event], nextPageCursor: "" } });
    expect(await getStopTimetable(instance, "ms:root", "2026-10-25", "epoch")).toHaveLength(1);
  });

  it("resolves the stop timezone from coordinates when MOTIS omits optional Place.tz", async () => {
    const event = {
      place: { ...stop("root", 13.369, 52.525), departure: "2026-07-30T06:00:00.000Z" },
      mode: "RAIL" as const,
      realTime: false,
      headsign: "Ostbahnhof",
      tripFrom: stop("a", 13.332, 52.507),
      tripTo: stop("b", 13.435, 52.51),
      agencyId: "a",
      agencyName: "",
      agencyUrl: "",
      routeId: "de_demo_s1",
      directionId: "0",
      tripId: "fallback-tz",
      routeShortName: "S1",
      routeLongName: "",
      tripShortName: "",
      displayName: "S1",
    };
    mocks.stoptimes
      .mockResolvedValueOnce({ data: { place: stop("root", 13.369, 52.525) } })
      .mockResolvedValueOnce({ data: { stopTimes: [event], nextPageCursor: "" } });
    expect(await getStopTimetable(instance, "ms:root", "2026-07-30", "epoch")).toHaveLength(1);
    expect(mocks.stoptimes.mock.calls[1][0].query.time).toBe("2026-07-29T22:00:00.000Z");
  });

  it("caps a civil-day timetable at 300 accepted events", async () => {
    const events = Array.from({ length: 400 }, (_, index) => {
      const departure = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      return {
        place: { ...stop("root", 8, 47), departure },
        mode: "BUS" as const,
        realTime: false,
        headsign: "Town",
        tripFrom: stop("a", 8, 47),
        tripTo: stop("b", 8, 48),
        agencyId: "a",
        agencyName: "",
        agencyUrl: "",
        routeId: "de_feed_route",
        directionId: "0",
        tripId: `trip-${index}`,
        routeShortName: "1",
        routeLongName: "",
        tripShortName: "",
        displayName: "1",
      };
    });
    mocks.stoptimes
      .mockResolvedValueOnce({ data: { place: { ...stop("root", 8, 47), tz: "UTC" } } })
      .mockResolvedValueOnce({
        data: { stopTimes: events.slice(0, 200), nextPageCursor: "next" },
      })
      .mockResolvedValueOnce({ data: { stopTimes: events.slice(200), nextPageCursor: "more" } });
    expect(await getStopTimetable(instance, "ms:root", "2026-01-01", "epoch")).toHaveLength(300);
    expect(mocks.stoptimes).toHaveBeenCalledTimes(3);
  });
});

describe("MOTIS trip geometry", () => {
  it("trims the shared raw trip geometry to requested stop boundaries", async () => {
    mocks.trip.mockResolvedValue({
      data: {
        legs: [
          {
            mode: "BUS",
            routeId: "route",
            from: stop("a", 1, 1),
            to: stop("c", 3, 3),
            intermediateStops: [stop("b", 2, 2)],
            legGeometry: {
              points: encodePolyline(
                [
                  [1, 1],
                  [2, 2],
                  [3, 3],
                ],
                6,
              ),
              precision: 6,
            },
          },
        ],
      },
    });
    expect(await getLegGeometry(instance, "ms:trip", "ms:b", "ms:c")).toEqual({
      type: "LineString",
      coordinates: [
        [2, 2],
        [3, 3],
      ],
    });
    expect(mocks.trip).toHaveBeenCalledTimes(1);
  });

  it("returns null instead of fabricating geometry when MOTIS has none", async () => {
    mocks.trip.mockResolvedValue({
      data: {
        legs: [
          {
            mode: "BUS",
            routeId: "r",
            from: stop("a", 1, 1),
            to: stop("b", 2, 2),
            legGeometry: { points: "", precision: 6 },
          },
        ],
      },
    });
    expect(await getLegGeometry(instance, "ms:trip")).toBeNull();
  });

  it("returns null instead of the whole trip when the from stop is unresolvable", async () => {
    mocks.trip.mockResolvedValue({
      data: {
        legs: [
          {
            mode: "BUS",
            routeId: "route",
            from: stop("a", 1, 1),
            to: stop("c", 3, 3),
            intermediateStops: [stop("b", 2, 2)],
            legGeometry: {
              points: encodePolyline(
                [
                  [1, 1],
                  [2, 2],
                  [3, 3],
                ],
                6,
              ),
              precision: 6,
            },
          },
        ],
      },
    });
    expect(await getLegGeometry(instance, "ms:trip", "ms:does-not-exist", "ms:c")).toBeNull();
  });
});

describe("MOTIS adapter regression guards", () => {
  beforeEach(() => vi.clearAllMocks());

  const timetableEvent = (tripId: string, place: Record<string, unknown>) => ({
    place,
    mode: "BUS" as const,
    realTime: false,
    headsign: "Town",
    tripFrom: stop("a", 8, 47),
    tripTo: stop("b", 8, 48),
    agencyId: "a",
    agencyName: "",
    agencyUrl: "",
    routeId: "de_feed_route",
    directionId: "0",
    tripId,
    routeShortName: "1",
    routeLongName: "",
    tripShortName: "",
    displayName: "1",
  });

  it("caps timetable pagination when pages carry only undated events", async () => {
    let calls = 0;
    mocks.stoptimes.mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve({ data: { place: { ...stop("root", 8, 47), tz: "UTC" } } });
      }
      return Promise.resolve({
        data: {
          // Arrival-only events: no departure instants, so nothing is
          // accepted and the interval check never trips.
          stopTimes: [
            timetableEvent(`t-${calls}`, {
              ...stop("root", 8, 47),
              arrival: "2026-01-01T10:00:00.000Z",
            }),
          ],
          nextPageCursor: `cursor-${calls}`,
        },
      });
    });
    expect(await getStopTimetable(instance, "ms:root", "2026-01-01", "epoch")).toEqual([]);
    expect(mocks.stoptimes.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it("keeps a realtime-delayed departure on its scheduled civil day", async () => {
    mocks.stoptimes
      .mockResolvedValueOnce({ data: { place: { ...stop("root", 8, 47), tz: "UTC" } } })
      .mockResolvedValueOnce({
        data: {
          stopTimes: [
            timetableEvent("delayed", {
              ...stop("root", 8, 47),
              scheduledDeparture: "2026-01-01T23:50:00.000Z",
              departure: "2026-01-02T00:10:00.000Z",
            }),
          ],
          nextPageCursor: "",
        },
      });
    const departures = await getStopTimetable(instance, "ms:root", "2026-01-01", "epoch");
    expect(departures).toHaveLength(1);
    expect(departures[0].tripId).toBe("ms:delayed");
  });

  it("drops only the unencodable pattern from a bbox response, not the whole overlay", async () => {
    const oversizedRouteIds = Array.from(
      { length: 200 },
      (_, index) => `de_very-long-feed-tag_route-${index}-${"x".repeat(24)}`,
    );
    mocks.routes.mockResolvedValue({
      data: {
        routes: [
          {
            ...route(0, [{ from: 0, to: 1, polyline: 0 }]),
            transitRoutes: oversizedRouteIds.map((id) => ({ id, shortName: "X", longName: "" })),
          },
          route(1, [{ from: 0, to: 1, polyline: 0 }]),
        ],
        polylines: [
          line(
            [
              [1, 1],
              [2, 2],
            ],
            [0, 1],
          ),
        ],
        stops: [stop("a", 1, 1), stop("b", 2, 2)],
        zoomFiltered: false,
      },
    });
    const mapped = await getRoutesInBbox(instance, [1, 1, 2, 2], "epoch");
    expect(mapped).toHaveLength(1);
    expect(mapped[0].shortName).toBe("1");
  });

  it("encodes a provider-scoped sentinel line reference when no epoch is available", async () => {
    mocks.stoptimes.mockResolvedValue({
      data: {
        place: { ...stop("root", 8, 47), tz: "UTC" },
        stopTimes: [
          timetableEvent("t1", {
            ...stop("root", 8, 47),
            departure: "2026-01-01T10:00:00.000Z",
            scheduledDeparture: "2026-01-01T10:00:00.000Z",
          }),
        ],
      },
    });
    const departures = await getDepartures(instance, "ms:root", 60);
    expect(departures).toHaveLength(1);
    expect(decodeMotisLineReference(departures[0].route.id)).toMatchObject({
      e: "ms-unversioned",
      r: "de_feed_route",
    });
  });
});

describe("MOTIS per-service realtime evidence", () => {
  it.each([false, undefined])(
    "does not infer updates from enabled realtime when realTime=%s",
    (realTime) => {
      const departure = normalizeStoptime(
        instance,
        {
          place: { scheduledDeparture: "2026-10-07T08:00:00Z", departure: "2026-10-07T08:00:00Z" },
          mode: "BUS",
          realTime,
        } as never,
        "departure",
        { realtimeEnabled: true },
      );
      expect(departure.provenance?.realtimeCompleteness).toBe(
        realTime === false ? "none" : "unknown",
      );
      expect(departure.expectedAt).toBeUndefined();
    },
  );
});

describe("MOTIS stop time's own stop", () => {
  it("names the stop each stop time leaves from, such as a station's platform", () => {
    const departure = normalizeStoptime(
      instance,
      {
        place: {
          stopId: "de:05315:11201:3:9",
          name: "Köln Hbf",
          scheduledDeparture: "2026-10-07T08:00:00Z",
        },
        mode: "HIGHSPEED_RAIL",
      } as never,
      "departure",
    );
    expect(departure.stop).toEqual({ id: "ms:de:05315:11201:3:9", name: "Köln Hbf" });
  });

  it("leaves the stop out when MOTIS gives none", () => {
    const departure = normalizeStoptime(
      instance,
      { place: { scheduledDeparture: "2026-10-07T08:00:00Z" }, mode: "BUS" } as never,
      "departure",
    );
    expect(departure.stop).toBeUndefined();
  });
});

describe("MOTIS line names", () => {
  it("takes the train number out of a regional line's display name", () => {
    const departure = normalizeStoptime(
      instance,
      {
        place: { scheduledDeparture: "2026-10-31T17:08:00Z" },
        mode: "REGIONAL_RAIL",
        displayName: "RE1 (26826)",
        routeShortName: "RE1",
        tripShortName: "026826",
      } as never,
      "departure",
    );
    expect(departure.route.shortName).toBe("RE1");
    expect(departure.serviceInfo?.trainNumber).toBe("26826");
  });

  it("retains a regional operational number supplied separately from the display name", () => {
    const departure = normalizeStoptime(
      instance,
      {
        place: { scheduledDeparture: "2026-11-06T20:18:00Z" },
        displayName: "RE9",
        routeShortName: "RE9",
        tripShortName: "010935",
        mode: "REGIONAL_RAIL",
      } as never,
      "departure",
    );
    expect(departure.route.shortName).toBe("RE9");
    expect(departure.serviceInfo?.trainNumber).toBe("10935");
  });

  it("keeps a long-distance train's display name, whose route name is a bare number", () => {
    const departure = normalizeStoptime(
      instance,
      {
        place: { scheduledDeparture: "2026-10-31T17:08:00Z" },
        mode: "HIGHSPEED_RAIL",
        displayName: "ICE 203",
        routeShortName: "43",
      } as never,
      "departure",
    );
    expect(departure.route.shortName).toBe("ICE 203");
    expect(departure.serviceInfo).toBeUndefined();
  });
});

describe("MOTIS timetable transport evidence", () => {
  beforeEach(() => mocks.stoptimes.mockReset());
  it.each([getDepartures, getArrivals])(
    "does not turn an HTTP error into a valid empty timetable",
    async (read) => {
      mocks.stoptimes.mockResolvedValue({
        error: { message: "private upstream details" },
        response: { status: 503 },
      });
      await expect(read(instance, "ms:root", 60)).rejects.toThrow("MOTIS timetable unavailable");
    },
  );
  it("does not turn an invalid response into a valid empty timetable", async () => {
    mocks.stoptimes.mockResolvedValue({ data: {} });
    await expect(getDepartures(instance, "ms:root", 60)).rejects.toThrow(
      "MOTIS timetable unavailable",
    );
  });
  it("accepts a successfully empty timetable", async () => {
    mocks.stoptimes.mockResolvedValue({ data: { stopTimes: [] } });
    await expect(getDepartures(instance, "ms:root", 60)).resolves.toEqual([]);
  });
});

it.each([false, undefined])(
  "keeps absent per-service realtime evidence unknown with health/configuration %s",
  (realtimeEnabled) => {
    const normalized = normalizeStoptime(
      instance,
      {
        tripId: "trip-a",
        place: {
          stopId: "stop-a",
          name: "Station",
          lat: 52.52,
          lon: 13.37,
          scheduledDeparture: "2026-10-07T08:05:00Z",
        },
        // A partial stop time: the absent realTime flag is what this case is about.
      } as never,
      "departure",
      { realtimeEnabled },
    );
    expect(normalized.provenance?.realtimeCompleteness).toBe("unknown");
  },
);

it("anchors a departure window to the requested time instead of now", async () => {
  mocks.stoptimes.mockResolvedValue({ data: { stopTimes: [] } });
  await getDepartures(instance, "ms:root", 5, undefined, "2026-11-06T20:17:00.000Z");
  expect(mocks.stoptimes.mock.calls.at(-1)?.[0].query).toMatchObject({
    time: "2026-11-06T20:17:00.000Z",
    window: 300,
  });
});

describe("MOTIS places without coordinates", () => {
  const placed = { name: "A", stopId: "a", lat: 50.9, lon: 6.9 };
  const unplaced = { name: "B", stopId: "b" } as unknown as typeof placed;

  it("leaves a stop out instead of placing it at 0° N 0° E", () => {
    expect(normalizeStop(instance, unplaced)).toBeNull();
    expect(normalizeStop(instance, { ...placed, lat: 91 })).toBeNull();
    expect(motisPlaceToJourneyStop(instance, unplaced)).toBeNull();
    expect(normalizeStop(instance, placed)).toMatchObject({ id: "ms:a", lat: 50.9, lng: 6.9 });
  });

  it("refuses an itinerary with a leg end that cannot be placed", () => {
    const leg = (to: typeof placed) => ({
      mode: "BUS",
      from: placed,
      to,
      startTime: "2026-03-10T10:00:00Z",
      endTime: "2026-03-10T10:20:00Z",
      duration: 1200,
      realTime: false,
      scheduled: true,
    });
    const itinerary = (to: typeof placed) =>
      ({ duration: 1200, legs: [leg(to)], transfers: 0 }) as unknown as Parameters<
        typeof mapItinerary
      >[1];

    expect(mapItinerary(instance, itinerary(unplaced))).toBeNull();
    expect(mapItinerary(instance, itinerary({ ...placed, stopId: "c" }))?.legs).toHaveLength(1);
  });
});
