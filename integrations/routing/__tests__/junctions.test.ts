import { beforeEach, describe, expect, it, vi } from "vitest";

const overpassQuerySafe = vi.fn();

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  overpassQuerySafe: (...args: unknown[]) => overpassQuerySafe(...args),
}));

import {
  buildJunctionsQuery,
  junctionCacheKey,
  mapJunctionWays,
  type OverpassWayElement,
  parseJunctionPoints,
} from "../junctions.js";
import {
  createRoutingHandlerEnvironment,
  createRoutingTestReply,
} from "./support/routing-handler-contract.js";

// The A57 approach to exit 20: six route vertices ending 30 m past the split.
const TRACE = [
  [6.6803, 51.1782],
  [6.6793, 51.1784],
  [6.6785, 51.1786],
  [6.6777, 51.1787],
  [6.6768, 51.1789],
  [6.6766, 51.1789],
] as [number, number][];

function point(overrides: Record<string, unknown> = {}) {
  return { lng: 6.6768, lat: 51.1789, bearing: 283, trace: TRACE, ...overrides };
}

// A second decision point ~2 km away whose ways must never leak into the first.
const FAR_TRACE = [
  [6.7, 51.16],
  [6.699, 51.1602],
] as [number, number][];
const farPoint = () => point({ lng: 6.699, lat: 51.1602, bearing: 290, trace: FAR_TRACE });

const APPROACH_WAY: OverpassWayElement = {
  type: "way",
  id: 314653469,
  tags: {
    highway: "motorway",
    oneway: "yes",
    lanes: "5",
    "destination:ref:lanes": "A 57|A 57|A 57|A 46|A 46",
  },
  geometry: [
    { lat: 51.1786, lon: 6.6785 },
    { lat: 51.1788713, lon: 6.6768301 },
  ],
};

const RAMP_WAY: OverpassWayElement = {
  type: "way",
  id: 163585518,
  tags: { highway: "motorway_link", oneway: "yes", destination: "Neuss-Zentrum" },
  geometry: [
    { lat: 51.1788713, lon: 6.6768301 },
    { lat: 51.1790176, lon: 6.6764196 },
    { lat: 51.179145, lon: 6.675696 },
  ],
};

// The through carriageway continuing past the split: same bearing, starts at the point.
const DOWNSTREAM_WAY: OverpassWayElement = {
  type: "way",
  id: 77,
  tags: { highway: "motorway", oneway: "yes", lanes: "4", "turn:lanes": "none|none|none|none" },
  geometry: [
    { lat: 51.1788713, lon: 6.6768301 },
    { lat: 51.1791214, lon: 6.6751203 },
  ],
};

// The opposite carriageway, drawn against travel and tagged oneway=-1.
const REVERSE_WAY: OverpassWayElement = {
  type: "way",
  id: 99,
  tags: { highway: "motorway", oneway: "-1", lanes: "5", "destination:lanes": "x|x|x|x|x" },
  geometry: [
    { lat: 51.1785, lon: 6.6755 },
    { lat: 51.1786, lon: 6.6765 },
  ],
};

beforeEach(() => {
  overpassQuerySafe.mockReset();
});

describe("parseJunctionPoints", () => {
  it("accepts 1–40 well-formed points", () => {
    const points = parseJunctionPoints({ points: [point()] });
    expect(points).toHaveLength(1);
    expect(points?.[0].trace).toHaveLength(6);
    const many = parseJunctionPoints({ points: Array.from({ length: 40 }, () => point()) });
    expect(many).toHaveLength(40);
  });

  it.each([
    ["a missing array", { points: undefined }],
    ["an empty array", { points: [] }],
    ["41 points", { points: Array.from({ length: 41 }, () => point()) }],
    ["an out-of-range bearing", { points: [point({ bearing: 400 })] }],
    ["a one-vertex trace", { points: [point({ trace: [[6.68, 51.17]] })] }],
    ["a nine-vertex trace", { points: [point({ trace: Array(9).fill([6.68, 51.17]) })] }],
    ["a non-finite coordinate", { points: [point({ lng: Number.NaN })] }],
    ["a latitude past the pole", { points: [point({ lat: 91 })] }],
  ])("returns null for %s", (_name, body) => {
    expect(parseJunctionPoints(body)).toBeNull();
  });
});

describe("buildJunctionsQuery", () => {
  it("emits one polyline around statement per point and no per-sample circles", () => {
    const query = buildJunctionsQuery([point()]);
    // Untagged ways too: whether the route is on a motorway at the split does
    // not depend on the carriageway carrying destination tags.
    expect(query).toBe(
      `[out:json][timeout:25];(way(around:20,${TRACE.map(([lng, lat]) => `${lat},${lng}`).join(
        ",",
      )})["highway"~"^(motorway|trunk|motorway_link|trunk_link)$"];);out tags geom;`,
    );
    expect((query.match(/around:/g) ?? []).length).toBe(1);
  });

  it("joins several points into one query with one statement each", () => {
    const query = buildJunctionsQuery([point(), farPoint()]);
    expect((query.match(/around:/g) ?? []).length).toBe(2);
    expect((query.match(/\[out:json\]/g) ?? []).length).toBe(1);
  });
});

describe("junctionCacheKey", () => {
  it("is stable to sub-10 m position noise and rounds the bearing to 10°", () => {
    expect(junctionCacheKey(point())).toBe(
      junctionCacheKey(point({ lng: 6.67681, lat: 51.17894, bearing: 284 })),
    );
    expect(junctionCacheKey(point())).not.toBe(junctionCacheKey(point({ bearing: 286 })));
    expect(junctionCacheKey(point())).not.toBe(junctionCacheKey(farPoint()));
  });
});

describe("mapJunctionWays", () => {
  const mapped = () => parseJunctionPoints({ points: [point()] })?.[0] as ReturnType<typeof point>;

  it("reads the bearing at the node nearest the point, splits ramps off, and signs the end distance", () => {
    const result = mapJunctionWays([APPROACH_WAY, RAMP_WAY, REVERSE_WAY], mapped());
    expect(result.approach.map((way) => way.wayId)).toEqual([314653469]);
    const approach = result.approach[0];
    expect(approach.bearing).toBeGreaterThan(270);
    expect(approach.bearing).toBeLessThan(300);
    expect(approach.endDistanceMeters).toBeGreaterThanOrEqual(0);
    expect(approach.endDistanceMeters).toBeLessThan(5);
    expect(approach.tags).toEqual({ lanes: 5, destinationRefLanes: "A 57|A 57|A 57|A 46|A 46" });
    expect(result.ramps.map((way) => way.wayId)).toEqual([163585518]);
    // The ramp heads north-west out of the split; its far end curves away.
    expect(result.ramps[0].bearing).toBeGreaterThan(290);
    expect(result.ramps[0].bearing).toBeLessThan(320);
    expect(result.ramps[0].startDistanceMeters).toBeLessThan(5);
    expect(result.ramps[0].endDistanceMeters).toBeLessThan(-50);
    expect(approach.startDistanceMeters).toBeGreaterThan(100);
  });

  it("reverses a oneway=-1 way into travel order before filtering", () => {
    // Drawn against travel, the reverse carriageway reads ~66°; reversed it
    // heads ~246°, which is still 37° off the route and so excluded.
    const asDrawn = mapJunctionWays(
      [{ ...REVERSE_WAY, tags: { ...REVERSE_WAY.tags, oneway: "yes" } }],
      mapped(),
    );
    const reversed = mapJunctionWays([REVERSE_WAY], mapped());
    expect(asDrawn.approach).toEqual([]);
    expect(reversed.approach).toEqual([]);
    // Flipping the drawn direction of a way that then heads the route's way makes it qualify.
    const flipped = mapJunctionWays(
      [
        {
          ...APPROACH_WAY,
          tags: { ...APPROACH_WAY.tags, oneway: "-1" },
          geometry: [...(APPROACH_WAY.geometry ?? [])].reverse(),
        },
      ],
      mapped(),
    );
    expect(flipped.approach).toHaveLength(1);
  });

  it("reports the route on the motorway when a carriageway runs through the split its way", () => {
    expect(mapJunctionWays([APPROACH_WAY], mapped()).onMotorway).toBe(true);
    expect(mapJunctionWays([DOWNSTREAM_WAY], mapped()).onMotorway).toBe(true);
  });

  it("counts an untagged trunk carriageway as the road, but never draws it as a gantry", () => {
    const untagged: OverpassWayElement = {
      type: "way",
      id: 55,
      tags: { highway: "trunk", oneway: "yes" },
      geometry: [
        { lat: 51.1786, lon: 6.6785 },
        { lat: 51.1788713, lon: 6.6768301 },
        { lat: 51.1791214, lon: 6.6751203 },
      ],
    };
    const result = mapJunctionWays([untagged], mapped());
    expect(result.onMotorway).toBe(true);
    expect(result.approach).toEqual([]);
  });

  it("does not put an on-ramp's surface street on the motorway", () => {
    // Only the link leaving the split: the road the route arrives on is not
    // a motorway or trunk, so nothing in the result runs through the point.
    expect(mapJunctionWays([RAMP_WAY], mapped()).onMotorway).toBe(false);
  });

  it("ignores a carriageway beside the route or running the other way", () => {
    const shifted = (element: OverpassWayElement, dLat: number): OverpassWayElement => ({
      ...element,
      id: element.id + 1000,
      geometry: element.geometry?.map((node) => ({ lat: node.lat + dLat, lon: node.lon })),
    });
    // ~25 m north: close enough to be matched to this point's trace, not the road.
    expect(mapJunctionWays([shifted(DOWNSTREAM_WAY, 0.000225)], mapped()).onMotorway).toBe(false);
    const oncoming: OverpassWayElement = {
      ...DOWNSTREAM_WAY,
      id: 88,
      geometry: [...(DOWNSTREAM_WAY.geometry ?? [])].reverse(),
    };
    expect(mapJunctionWays([oncoming], mapped()).onMotorway).toBe(false);
  });

  describe("where the exit lanes already exist", () => {
    // The real OSM chain into exit 20: four lanes, then a fifth added 41 m
    // before the split.
    const way = (id: number, lanes: string, nodes: [number, number][]): OverpassWayElement => ({
      type: "way",
      id,
      tags: { highway: "motorway", oneway: "yes", lanes },
      geometry: nodes.map(([lon, lat]) => ({ lat, lon })),
    });
    const FOUR_LANES_FAR = way(314653470, "4", [
      [6.6819535, 51.1781486],
      [6.6795424, 51.1784787],
    ]);
    const FOUR_LANES = way(314653467, "4", [
      [6.6795424, 51.1784787],
      [6.6774012, 51.1787881],
    ]);
    const FIVE_LANES = way(314653466, "5", [
      [6.6774012, 51.1787881],
      [6.6768301, 51.1788713],
    ]);
    const atSplit = () =>
      point({ lng: 6.6768301, lat: 51.1788713, bearing: 283 }) as ReturnType<typeof point>;

    it("measures from where the lane count at the split begins", () => {
      const result = mapJunctionWays(
        [FOUR_LANES_FAR, FOUR_LANES, FIVE_LANES, DOWNSTREAM_WAY, RAMP_WAY],
        atSplit(),
      );
      expect(result.fullLanesFromMeters).toBe(41);
    });

    it("follows the carriageway across ways cut for other reasons", () => {
      const bridge = way(9, "5", [
        [6.6795424, 51.1784787],
        [6.6774012, 51.1787881],
      ]);
      const result = mapJunctionWays([FOUR_LANES_FAR, bridge, FIVE_LANES], atSplit());
      expect(result.fullLanesFromMeters).toBe(194);
    });

    it("is absent when the way at the split has no lane count", () => {
      const untagged: OverpassWayElement = { ...FIVE_LANES, tags: { highway: "motorway" } };
      expect(mapJunctionWays([FOUR_LANES, untagged], atSplit()).fullLanesFromMeters).toBe(
        undefined,
      );
    });
  });

  it("keeps the downstream continuation out of the approach set", () => {
    const result = mapJunctionWays([DOWNSTREAM_WAY], mapped());
    expect(result.approach).toEqual([]);
  });

  it("drops ways that were matched by another point's statement", () => {
    const farWay: OverpassWayElement = {
      ...APPROACH_WAY,
      id: 5,
      geometry: [
        { lat: 51.16, lon: 6.7 },
        { lat: 51.1602, lon: 6.699 },
      ],
    };
    const near = mapJunctionWays([APPROACH_WAY, farWay], mapped());
    expect(near.approach.map((way) => way.wayId)).toEqual([314653469]);
    const far = mapJunctionWays(
      [APPROACH_WAY, farWay],
      parseJunctionPoints({ points: [farPoint()] })?.[0] as ReturnType<typeof point>,
    );
    expect(far.approach.map((way) => way.wayId)).toEqual([5]);
  });
});

describe("POST /navigation/junctions", () => {
  function environment() {
    const store = new Map<string, unknown>();
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    };
    const env = createRoutingHandlerEnvironment({
      routingProviders: [],
      contextOverrides: { cache: cache as never },
    });
    return { env, cache, store };
  }

  it("returns 400 for an invalid body", async () => {
    const { env } = environment();
    const reply = createRoutingTestReply();
    await env.getHandler("/navigation/junctions")({ body: { points: [] }, query: {} }, reply);
    expect(reply.code).toBe(400);
  });

  it("answers one junction per input point from a single Overpass query, without Cache-Control", async () => {
    overpassQuerySafe.mockResolvedValue({ elements: [APPROACH_WAY, RAMP_WAY] });
    const { env, cache } = environment();
    const reply = createRoutingTestReply();
    await env.getHandler("/navigation/junctions")(
      { body: { points: [point(), farPoint()] }, query: {} },
      reply,
    );
    expect(reply.code).toBe(200);
    const body = reply.body as {
      junctions: { index: number; approach: unknown[]; ramps: unknown[] }[];
    };
    expect(body.junctions.map((j) => j.index)).toEqual([0, 1]);
    expect(body.junctions[0].approach).toHaveLength(1);
    expect(body.junctions[0].ramps).toHaveLength(1);
    expect(body.junctions[1].approach).toEqual([]);
    expect(overpassQuerySafe).toHaveBeenCalledTimes(1);
    expect((String(overpassQuerySafe.mock.calls[0][0]).match(/around:/g) ?? []).length).toBe(2);
    expect(cache.set).toHaveBeenCalledTimes(2);
    expect(reply.header).not.toHaveBeenCalled();
  });

  it("marks the points unavailable when Overpass fails and caches nothing", async () => {
    overpassQuerySafe.mockResolvedValue(null);
    const { env, cache } = environment();
    const reply = createRoutingTestReply();
    await env.getHandler("/navigation/junctions")(
      { body: { points: [point()] }, query: {} },
      reply,
    );
    expect(reply.code).toBe(200);
    // Without OSM there is no evidence either way, so no candidate is promoted,
    // and the client is told to ask again rather than settle on "nothing".
    expect(reply.body).toEqual({
      junctions: [{ index: 0, approach: [], ramps: [], onMotorway: false, unavailable: true }],
    });
    expect(cache.set).not.toHaveBeenCalled();
    expect(reply.header).not.toHaveBeenCalled();
  });

  it("treats an Overpass runtime error reported with a 200 as no answer, and caches nothing", async () => {
    overpassQuerySafe.mockResolvedValue({
      elements: [APPROACH_WAY],
      remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.',
    });
    const { env, cache } = environment();
    const reply = createRoutingTestReply();
    await env.getHandler("/navigation/junctions")(
      { body: { points: [point()] }, query: {} },
      reply,
    );
    expect(reply.body).toEqual({
      junctions: [{ index: 0, approach: [], ramps: [], onMotorway: false, unavailable: true }],
    });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("queries only the points that are not cached yet", async () => {
    overpassQuerySafe.mockResolvedValue({ elements: [APPROACH_WAY] });
    const { env } = environment();
    const handler = env.getHandler("/navigation/junctions");
    await handler({ body: { points: [point()] }, query: {} }, createRoutingTestReply());
    expect(overpassQuerySafe).toHaveBeenCalledTimes(1);

    overpassQuerySafe.mockClear();
    const reply = createRoutingTestReply();
    await handler({ body: { points: [point(), farPoint()] }, query: {} }, reply);
    expect(overpassQuerySafe).toHaveBeenCalledTimes(1);
    const query = String(overpassQuerySafe.mock.calls[0][0]);
    expect((query.match(/around:/g) ?? []).length).toBe(1);
    expect(query).toContain(`${FAR_TRACE[0][1]},${FAR_TRACE[0][0]}`);
    const body = reply.body as { junctions: { approach: unknown[] }[] };
    expect(body.junctions[0].approach).toHaveLength(1);

    overpassQuerySafe.mockClear();
    await handler({ body: { points: [point(), farPoint()] }, query: {} }, createRoutingTestReply());
    expect(overpassQuerySafe).not.toHaveBeenCalled();
  });
});
