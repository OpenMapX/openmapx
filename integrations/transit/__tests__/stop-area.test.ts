import type { OverpassResponse } from "@openmapx/core";
import { stopAreaDistance } from "@openmapx/core/navigation";
import { describe, expect, it } from "vitest";
import {
  deriveStopAreaFromOsm,
  ifoptOf,
  OSM_ATTRIBUTION,
  parseStopAreaQuery,
  resolveStopArea,
  type StopAreaQuery,
  stopAreaCacheKey,
  stopAreaFromSiblings,
  stopAreaOverpassQuery,
} from "../stop-area.js";

/**
 * Synthetic Overpass answers shaped like the real ones for a German bus stop
 * (IFOPT-tagged pole and stop position), a main station whose platforms carry
 * IFOPT area ids, and a station mapped without any ids.
 */

const LAT = 50.78;
const LNG = 6.1;
const M_LNG = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const M_LAT = 1 / 110_574;
const at = (x: number, y: number) => ({ lat: LAT + y * M_LAT, lon: LNG + x * M_LNG });
const lngLat = (x: number, y: number): [number, number] => [LNG + x * M_LNG, LAT + y * M_LAT];

function node(id: number, x: number, y: number, tags: Record<string, string>) {
  return { type: "node", id, ...at(x, y), tags };
}

function way(id: number, points: Array<[number, number]>, tags: Record<string, string>) {
  return { type: "way", id, geometry: points.map(([x, y]) => at(x, y)), tags };
}

function stopArea(id: number, members: Array<[string, number]>, tags: Record<string, string>) {
  return {
    type: "relation",
    id,
    tags: { type: "public_transport", public_transport: "stop_area", ...tags },
    members: members.map(([type, ref]) => ({ type, ref, role: "" })),
  };
}

const response = (elements: unknown[]) => ({ elements }) as unknown as OverpassResponse;

function query(overrides: Partial<StopAreaQuery>): StopAreaQuery {
  return { stopId: "x", lat: LAT, lng: LNG, name: "", mode: "bus", ...overrides };
}

describe("ifoptOf", () => {
  it("finds the DHID inside a feed stop id", () => {
    expect(ifoptOf("mo:de-DELFI_de:05334:1008:91:2")).toEqual({
      id: "de:05334:1008:91:2",
      stopPlace: "de:05334:1008",
      area: "de:05334:1008:91",
    });
    expect(ifoptOf("mo:de-DELFI_de:05334:1008")).toEqual({
      id: "de:05334:1008",
      stopPlace: "de:05334:1008",
      area: null,
    });
  });

  it("does not read other ids as IFOPT", () => {
    expect(ifoptOf("mo:fr-eurostar-gtfs_aachen_hbf")).toBeNull();
    expect(ifoptOf("db:8000001")).toBeNull();
  });
});

describe("parseStopAreaQuery", () => {
  it("accepts a described stop and rejects nonsense", () => {
    expect(
      parseStopAreaQuery("s", {
        lat: "50.78",
        lng: "6.1",
        name: "A",
        mode: "bus",
        platform: "H.2",
      }),
    ).toEqual({ stopId: "s", lat: 50.78, lng: 6.1, name: "A", mode: "bus", platform: "H.2" });
    expect(parseStopAreaQuery("s", { lat: "91", lng: "6.1", mode: "bus" })).toBeNull();
    expect(parseStopAreaQuery("s", { lat: "50", lng: "6", mode: "walking" })).toBeNull();
    expect(parseStopAreaQuery("s", { lat: "x", lng: "6", mode: "bus" })).toBeNull();
  });

  it("keys the cache by what the request claimed, not only the id", () => {
    const a = query({ stopId: "s", platform: "1" });
    expect(stopAreaCacheKey(a)).not.toBe(stopAreaCacheKey({ ...a, lat: LAT + 0.01 }));
    expect(stopAreaCacheKey(a)).not.toBe(stopAreaCacheKey({ ...a, platform: "2" }));
  });

  it("searches wider around a station than around a bus stop", () => {
    expect(stopAreaOverpassQuery(query({ mode: "bus" }))).toContain("around:150,");
    expect(stopAreaOverpassQuery(query({ mode: "rail" }))).toContain("around:300,");
  });
});

describe("deriveStopAreaFromOsm", () => {
  it("matches a bus stop's pole and stop position by IFOPT, inside its stop place", () => {
    const area = deriveStopAreaFromOsm(
      query({
        stopId: "mo:de-DELFI_de:05334:1067:2:2",
        name: "Aachen, Blücherplatz",
        platform: "H.2",
      }),
      response([
        node(1, 2, 3, {
          highway: "bus_stop",
          public_transport: "platform",
          "ref:IFOPT": "de:05334:1067:2:2",
        }),
        node(2, 0, 1, {
          public_transport: "stop_position",
          bus: "yes",
          "ref:IFOPT": "de:05334:1067:2:2",
        }),
        node(3, -80, -40, {
          highway: "bus_stop",
          public_transport: "platform",
          "ref:IFOPT": "de:05334:1067:1:1",
        }),
        node(4, -78, -42, { public_transport: "stop_position", "ref:IFOPT": "de:05334:1067:1:1" }),
        stopArea(
          10,
          [
            ["node", 1],
            ["node", 2],
            ["node", 3],
            ["node", 4],
          ],
          { name: "Blücherplatz" },
        ),
      ]),
    );
    expect(area?.platform).toEqual([
      { type: "point", coordinates: lngLat(2, 3), bufferMeters: 12 },
      { type: "point", coordinates: lngLat(0, 1), bufferMeters: 10 },
    ]);
    // The far side of the street belongs to the stop place, not this platform.
    expect(stopAreaDistance(area?.platform ?? [], lngLat(-80, -40))).toBeGreaterThan(50);
    expect(stopAreaDistance(area?.station ?? [], lngLat(-80, -40))).toBe(0);
    expect(area?.source).toBe("osm");
  });

  it("matches a train platform by the IFOPT area it shares with the next track", () => {
    const platform = way(
      20,
      [
        [-200, -4],
        [200, -4],
        [200, 4],
        [-200, 4],
        [-200, -4],
      ],
      {
        railway: "platform",
        public_transport: "platform",
        ref: "2;3",
        "ref:IFOPT": "de:05334:1008:91",
      },
    );
    const other = way(
      21,
      [
        [-200, 26],
        [200, 26],
        [200, 34],
        [-200, 34],
        [-200, 26],
      ],
      {
        railway: "platform",
        public_transport: "platform",
        ref: "6;7",
        "ref:IFOPT": "de:05334:1008:92",
      },
    );
    const area = deriveStopAreaFromOsm(
      query({ stopId: "mo:de-DELFI_de:05334:1008:91:2", mode: "rail", platform: "2" }),
      response([
        platform,
        other,
        node(22, 0, 30, { railway: "station", "ref:IFOPT": "de:05334:1008" }),
        stopArea(
          30,
          [
            ["way", 20],
            ["way", 21],
            ["node", 22],
          ],
          { "ref:IFOPT": "de:05334:1008" },
        ),
      ]),
    );
    expect(area?.platform).toHaveLength(1);
    expect(area?.platform[0]).toMatchObject({ type: "polygon", bufferMeters: 3 });
    // Anywhere along the 400 m platform is on it; the next platform is not.
    expect(stopAreaDistance(area?.platform ?? [], lngLat(-190, 0))).toBe(0);
    expect(stopAreaDistance(area?.platform ?? [], lngLat(0, 30))).toBeGreaterThan(15);
    expect(stopAreaDistance(area?.station ?? [], lngLat(150, 30))).toBe(0);
  });

  it("gives a station-level id the stop place only, never a guessed platform", () => {
    const area = deriveStopAreaFromOsm(
      query({ stopId: "mo:de-DELFI_de:05334:1008", mode: "rail" }),
      response([
        way(
          20,
          [
            [-200, -4],
            [200, -4],
          ],
          { railway: "platform", "ref:IFOPT": "de:05334:1008:91" },
        ),
        way(
          21,
          [
            [-200, 30],
            [200, 30],
          ],
          { railway: "platform", "ref:IFOPT": "de:05334:1008:92" },
        ),
      ]),
    );
    expect(area?.platform).toEqual([]);
    expect(area?.station[0]).toMatchObject({ type: "polygon", bufferMeters: 10 });
  });

  it("matches a station mapped without ids by its spelled-out name and track", () => {
    const area = deriveStopAreaFromOsm(
      query({ stopId: "mo:gb-feed_cologne", name: "Köln Hbf", mode: "rail", platform: "Gleis 2" }),
      response([
        way(
          40,
          [
            [-150, 0],
            [150, 0],
          ],
          { railway: "platform", train: "yes", ref: "2;3" },
        ),
        way(
          41,
          [
            [-150, 40],
            [150, 40],
          ],
          { railway: "platform", train: "yes", ref: "4;5" },
        ),
        node(42, 0, -3, { public_transport: "stop_position", train: "yes", ref: "2" }),
        // A tram platform of the same stop place, also numbered 2.
        node(43, 120, -90, { railway: "platform", tram: "yes", ref: "2" }),
        stopArea(
          50,
          [
            ["way", 40],
            ["way", 41],
            ["node", 42],
            ["node", 43],
          ],
          {
            name: "Köln Hauptbahnhof",
          },
        ),
      ]),
    );
    expect(area?.platform).toEqual([
      { type: "line", coordinates: [lngLat(-150, 0), lngLat(150, 0)], bufferMeters: 4 },
      { type: "point", coordinates: lngLat(0, -3), bufferMeters: 10 },
    ]);
    expect(area?.station).toHaveLength(1);
  });

  it("takes the nearest bus platform when nothing names it, but not one too far", () => {
    const near = deriveStopAreaFromOsm(
      query({ stopId: "mo:us-feed_123", name: "Main St", mode: "bus" }),
      response([node(60, 15, 0, { highway: "bus_stop" })]),
    );
    expect(near?.platform).toHaveLength(1);
    const far = deriveStopAreaFromOsm(
      query({ stopId: "mo:us-feed_123", name: "Main St", mode: "bus" }),
      response([node(60, 60, 0, { highway: "bus_stop" })]),
    );
    expect(far).toBeNull();
  });

  it("does not guess a platform for a train with no track", () => {
    const area = deriveStopAreaFromOsm(
      query({ stopId: "mo:fr-feed_gare", name: "Gare", mode: "rail" }),
      response([
        way(
          70,
          [
            [-10, 0],
            [10, 0],
          ],
          { railway: "platform" },
        ),
      ]),
    );
    expect(area).toBeNull();
  });

  it("drops a stop place that spans more than a station could", () => {
    const area = deriveStopAreaFromOsm(
      query({ stopId: "mo:de-DELFI_de:05334:1:1:1", name: "Weit", mode: "bus" }),
      response([
        node(80, 0, 0, { highway: "bus_stop", "ref:IFOPT": "de:05334:1:1:1" }),
        node(81, 2500, 0, { highway: "bus_stop", "ref:IFOPT": "de:05334:1:2:2" }),
        stopArea(
          90,
          [
            ["node", 80],
            ["node", 81],
          ],
          { name: "Weit" },
        ),
      ]),
    );
    expect(area?.platform).toHaveLength(1);
    expect(area?.station).toEqual([]);
  });
});

describe("stopAreaFromSiblings", () => {
  it("wraps the timetable's sibling platforms into a stop place", () => {
    const area = stopAreaFromSiblings(query({ stopId: "s", mode: "rail" }), [
      { lat: LAT + 60 * M_LAT, lng: LNG },
      { lat: LAT, lng: LNG + 80 * M_LNG },
    ]);
    expect(area).toMatchObject({ stopId: "s", platform: [], source: "feed" });
    expect(area?.station[0]).toMatchObject({ type: "polygon", bufferMeters: 30 });
  });

  it("has nothing to wrap for a lone stop", () => {
    expect(stopAreaFromSiblings(query({ stopId: "s" }), [{ lat: LAT, lng: LNG }])).toBeNull();
  });
});

describe("resolveStopArea", () => {
  const busStop = query({
    stopId: "mo:de-DELFI_de:05334:1067:2:2",
    name: "Blücherplatz",
    platform: "H.2",
  });
  const pole = node(1, 0, 0, {
    highway: "bus_stop",
    "ref:IFOPT": "de:05334:1067:2:2",
  });
  const siblings = (points: Array<[number, number]>) => async () => ({
    data: points.map(([x, y]) => ({ lat: LAT + y * M_LAT, lng: LNG + x * M_LNG })) as never,
    attributions: [{ sourceId: "delfi", name: "DELFI" }],
    freshness: { fetchedAt: "", hasRealtimeData: false, isStale: false },
  });

  it("answers from OpenStreetMap alone when it knows the stop place", async () => {
    const twoPoles = response([
      pole,
      node(2, 30, 20, { highway: "bus_stop", "ref:IFOPT": "de:05334:1067:1:1" }),
      stopArea(
        3,
        [
          ["node", 1],
          ["node", 2],
        ],
        {},
      ),
    ]);
    const lookup = siblings([[50, 50]]);
    const resolved = await resolveStopArea(busStop, {
      overpass: async () => twoPoles,
      siblings: lookup,
    });
    expect(resolved).toMatchObject({ complete: true, attributions: [OSM_ATTRIBUTION] });
    expect(resolved.area?.source).toBe("osm");
  });

  it("borrows the timetable's stop place when the map has only the platform", async () => {
    const resolved = await resolveStopArea(busStop, {
      overpass: async () => response([pole]),
      siblings: siblings([
        [40, 0],
        [0, 40],
      ]),
    });
    expect(resolved.area?.platform).toHaveLength(1);
    expect(resolved.area?.station).toHaveLength(1);
    expect(resolved.attributions.map((a) => a.sourceId)).toEqual(["openstreetmap", "delfi"]);
  });

  it("falls back to the timetable and marks the answer incomplete when Overpass fails", async () => {
    const resolved = await resolveStopArea(busStop, {
      overpass: async () => {
        throw new Error("busy");
      },
      siblings: siblings([
        [40, 0],
        [0, 40],
      ]),
    });
    expect(resolved.area?.source).toBe("feed");
    expect(resolved.complete).toBe(false);
  });

  it("finds nothing for an unmapped stop without siblings, and may cache that", async () => {
    const resolved = await resolveStopArea(busStop, {
      overpass: async () => response([]),
      siblings: siblings([]),
    });
    expect(resolved).toEqual({ area: null, attributions: [], complete: true });
  });
});
