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
  getDepartures,
  getLegGeometry,
  getRoute,
  getRouteStops,
  getRoutesForStop,
  getRoutesInBbox,
  getStopPlatforms,
  getStopTimetable,
  mapMotisRoute,
  normalizeStop,
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
  polyline: { points: encodePolyline(coordinates, 6), precision: 6 },
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

    expect(normalized.codes).toEqual([{ value: "AACHN", namespace: "gtfs" }]);
    expect(normalized.codes?.map(({ value }) => value)).not.toContain("ms:de:1");
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
});

describe("MOTIS stops, platforms, and civil-day timetable", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps current track before scheduled track", () => {
    expect(
      normalizeStop(instance, { ...stop("p", 1, 2), track: "4", scheduledTrack: "3" }).platformCode,
    ).toBe("4");
    expect(normalizeStop(instance, { ...stop("p", 1, 2), scheduledTrack: "3" }).platformCode).toBe(
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
