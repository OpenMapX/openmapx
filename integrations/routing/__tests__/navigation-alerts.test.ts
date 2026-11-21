import { haversineDistance, type LngLat } from "@openmapx/core";
import { loadJsonFixture } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import {
  type AlertOverpassElement,
  buildNavigationAlertsQuery,
  mapAlertElements,
  type RawRoadAlert,
  ROAD_CONTEXT_REACH_M,
} from "../navigation-alerts.js";

/** The recorded Overpass answer around the Kaarst junction. */
const kaarst = loadJsonFixture<{ elements: AlertOverpassElement[] }>(
  import.meta.dirname,
  "../__fixtures__/kaarst-maubisstrasse-alerts.json",
);

const BASE_LAT = 51.23;
const BASE_LNG = 6.62;
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG = Math.cos((BASE_LAT * Math.PI) / 180) * 111_320;

/** A position `x` metres east and `y` metres north of the test origin. */
function at(x: number, y: number): { lat: number; lon: number } {
  return { lat: BASE_LAT + y / M_PER_DEG_LAT, lon: BASE_LNG + x / M_PER_DEG_LNG };
}

function node(
  id: number,
  x: number,
  y: number,
  tags: Record<string, string>,
): AlertOverpassElement {
  return { type: "node", id, ...at(x, y), tags };
}

/** A way through the given node ids at the given metric positions, with geometry. */
function way(
  id: number,
  points: [number, number, number][],
  tags: Record<string, string>,
  withGeometry = true,
): AlertOverpassElement {
  return {
    type: "way",
    id,
    tags,
    nodes: points.map(([nodeId]) => nodeId),
    ...(withGeometry ? { geometry: points.map(([, x, y]) => at(x, y)) } : {}),
  };
}

function byId(alerts: RawRoadAlert[], id: string): RawRoadAlert | undefined {
  return alerts.find((alert) => alert.id === id);
}

function flags(alert: RawRoadAlert | undefined) {
  return alert?.roads.map(({ wayId, forward, backward }) => ({ wayId, forward, backward }));
}

describe("mapAlertElements — Kaarst, Maubisstraße × Grünstraße / Matthias-Claudius-Straße", () => {
  const alerts = mapAlertElements(kaarst.elements);

  it("keeps each side-street stop sign on its own street, for its own approach only", () => {
    // Grünstraße is digitised away from Maubisstraße; `direction=backward`
    // stops the traffic heading back toward the junction.
    expect(flags(byId(alerts, "stop:8557831413"))).toEqual([
      { wayId: 24578686, forward: false, backward: true },
    ]);
    // Matthias-Claudius-Straße runs toward Maubisstraße; `direction=forward`.
    expect(flags(byId(alerts, "stop:8557831412"))).toEqual([
      { wayId: 158227908, forward: true, backward: false },
    ]);
  });

  it("applies an undirected speed bump both ways on its street", () => {
    expect(flags(byId(alerts, "traffic_calming:9272074398"))).toEqual([
      { wayId: 158227908, forward: true, backward: true },
    ]);
  });

  it("drops lateral traffic calming", () => {
    expect(byId(alerts, "traffic_calming:12141815653")).toBeUndefined(); // choker
    expect(byId(alerts, "traffic_calming:14251134244")).toBeUndefined(); // chicane
  });

  it("gives each road a slice of geometry with the hazard as a vertex", () => {
    const road = byId(alerts, "stop:8557831413")?.roads[0];
    expect(road).toBeDefined();
    if (!road) return;
    const anchor = road.line[road.anchorIndex];
    expect(haversineDistance(anchor, [6.6193297, 51.2295553])).toBeLessThan(0.05);
    // The way starts 6.7 m before the sign, at Maubisstraße.
    expect(haversineDistance(road.line[0], [6.6192329, 51.2295545])).toBeLessThan(0.05);
    const last = road.line[road.line.length - 1];
    expect(haversineDistance(anchor, last)).toBeCloseTo(ROAD_CONTEXT_REACH_M, 0);
  });
});

describe("mapAlertElements — stop signs", () => {
  // A residential street (way 2) ending at a tertiary road (way 1) at node 10.
  const mainRoad = way(
    1,
    [
      [9, -60, 0],
      [10, 0, 0],
      [11, 60, 0],
    ],
    { highway: "tertiary" },
  );
  const sideStreet = way(
    2,
    [
      [20, 0, -80],
      [21, 0, -10],
      [10, 0, 0],
    ],
    { highway: "residential" },
  );

  it("applies a stop on a junction node only to the minor approach", () => {
    const alerts = mapAlertElements([node(10, 0, 0, { highway: "stop" }), mainRoad, sideStreet]);
    expect(flags(byId(alerts, "stop:10"))).toEqual([
      // The side street ends at the junction: only forward traffic reaches it.
      { wayId: 2, forward: true, backward: false },
    ]);
  });

  it("does not let a direction on a junction node stop the main road", () => {
    const alerts = mapAlertElements([
      node(10, 0, 0, { highway: "stop", direction: "forward" }),
      mainRoad,
      sideStreet,
    ]);
    expect(flags(byId(alerts, "stop:10"))).toEqual([{ wayId: 2, forward: true, backward: false }]);
  });

  it("drops an undirected junction-node stop between equal roads", () => {
    const alerts = mapAlertElements([
      node(10, 0, 0, { highway: "stop" }),
      { ...mainRoad, tags: { highway: "residential" } },
      sideStreet,
    ]);
    expect(byId(alerts, "stop:10")).toBeUndefined();
  });

  it("applies an all-way stop to every road", () => {
    const alerts = mapAlertElements([
      node(10, 0, 0, { highway: "stop", stop: "all" }),
      mainRoad,
      sideStreet,
    ]);
    expect(flags(byId(alerts, "stop:10"))).toEqual([
      { wayId: 1, forward: true, backward: true },
      { wayId: 2, forward: true, backward: true },
    ]);
  });

  it("points an undirected stop before a junction at that junction", () => {
    const alerts = mapAlertElements([
      node(21, 0, -10, { highway: "stop" }),
      sideStreet,
      // Topology only, as the junction lookup fetches it.
      way(
        1,
        [
          [9, -60, 0],
          [10, 0, 0],
          [11, 60, 0],
        ],
        { highway: "tertiary" },
        false,
      ),
    ]);
    expect(flags(byId(alerts, "stop:21"))).toEqual([{ wayId: 2, forward: true, backward: false }]);
  });

  it("points an undirected stop where its road is split at the sign across both ways", () => {
    // Way 3 ends at the sign (node 102) and way 4 continues from it. Junction
    // J1 (node 100) lies 20 m back on way 3, junction J2 (node 104) 30 m on
    // along way 4: the sign is for traffic from J2 heading to J1, which runs
    // against both ways' digitisation.
    const alerts = mapAlertElements([
      node(102, 0, 0, { highway: "stop" }),
      way(
        3,
        [
          [100, 0, -20],
          [101, 0, -10],
          [102, 0, 0],
        ],
        { highway: "residential" },
      ),
      way(
        4,
        [
          [102, 0, 0],
          [103, 0, 15],
          [104, 0, 30],
        ],
        { highway: "residential" },
      ),
      way(
        5,
        [
          [110, -50, -20],
          [100, 0, -20],
          [111, 50, -20],
        ],
        { highway: "tertiary" },
        false,
      ),
      way(
        6,
        [
          [120, -50, 30],
          [104, 0, 30],
          [121, 50, 30],
        ],
        { highway: "tertiary" },
        false,
      ),
    ]);
    expect(flags(byId(alerts, "stop:102"))).toEqual([
      { wayId: 3, forward: false, backward: true },
      { wayId: 4, forward: false, backward: true },
    ]);
  });

  it("applies an undirected stop far from any junction both ways", () => {
    const alerts = mapAlertElements([node(21, 0, -10, { highway: "stop" }), sideStreet]);
    expect(flags(byId(alerts, "stop:21"))).toEqual([{ wayId: 2, forward: true, backward: true }]);
  });

  it("reads stop:direction ahead of direction", () => {
    const alerts = mapAlertElements([
      node(21, 0, -10, { highway: "stop", "stop:direction": "backward", direction: "90" }),
      sideStreet,
    ]);
    expect(flags(byId(alerts, "stop:21"))).toEqual([{ wayId: 2, forward: false, backward: true }]);
  });
});

describe("mapAlertElements — other hazards", () => {
  const street = way(
    1,
    [
      [1, -100, 0],
      [2, 0, 0],
      [3, 100, 0],
    ],
    { highway: "residential" },
  );

  it("keeps a vertical device listed among lateral ones", () => {
    const alerts = mapAlertElements([node(2, 0, 0, { traffic_calming: "choker;cushion" }), street]);
    expect(flags(byId(alerts, "traffic_calming:2"))).toEqual([
      { wayId: 1, forward: true, backward: true },
    ]);
  });

  it("drops a level crossing of an abandoned railway, keeps an active one", () => {
    const rail = (railway: string) =>
      way(
        9,
        [
          [7, 0, -50],
          [2, 0, 0],
          [8, 0, 50],
        ],
        { railway },
        false,
      );
    const crossing = node(2, 0, 0, { railway: "level_crossing" });
    expect(mapAlertElements([crossing, street, rail("abandoned")])).toEqual([]);
    expect(
      flags(byId(mapAlertElements([crossing, street, rail("rail")]), "railway_crossing:2")),
    ).toEqual([{ wayId: 1, forward: true, backward: true }]);
  });

  it("honours forward/backward on a speed camera, keeps its limit", () => {
    const alerts = mapAlertElements([
      node(2, 0, 0, { highway: "speed_camera", direction: "backward", maxspeed: "50" }),
      street,
    ]);
    expect(byId(alerts, "speed_camera:2")).toMatchObject({
      speedLimitKmh: 50,
      roads: [{ wayId: 1, forward: false, backward: true }],
    });
  });

  it("ignores a speed camera's facing angle", () => {
    const alerts = mapAlertElements([
      node(2, 0, 0, { highway: "speed_camera", direction: "270" }),
      street,
    ]);
    expect(flags(byId(alerts, "speed_camera:2"))).toEqual([
      { wayId: 1, forward: true, backward: true },
    ]);
  });

  it("attaches a camera beside the road to that road at its projection", () => {
    const alerts = mapAlertElements([node(50, 30, 6, { highway: "speed_camera" }), street]);
    const road = byId(alerts, "speed_camera:50")?.roads[0];
    expect(road?.wayId).toBe(1);
    if (!road) return;
    const anchor = road.line[road.anchorIndex] as LngLat;
    const expected = at(30, 0);
    expect(haversineDistance(anchor, [expected.lon, expected.lat])).toBeLessThan(0.1);
  });

  it("gives a hazard on a roundabout's closing node road on both sides", () => {
    // A 40 m square roundabout whose closing node carries a speed table.
    const roundabout = way(
      5,
      [
        [60, 0, 0],
        [61, 40, 0],
        [62, 40, 40],
        [63, 0, 40],
        [60, 0, 0],
      ],
      { highway: "tertiary", junction: "roundabout", oneway: "yes" },
    );
    const alerts = mapAlertElements([node(60, 0, 0, { traffic_calming: "table" }), roundabout]);
    const road = byId(alerts, "traffic_calming:60")?.roads[0];
    expect(road).toBeDefined();
    if (!road) return;
    const anchor = road.line[road.anchorIndex];
    // Forward traffic reaches the closing node from the way's last segment.
    expect(road.anchorIndex).toBeGreaterThan(0);
    expect(haversineDistance(road.line[0], anchor)).toBeGreaterThan(30);
    expect(haversineDistance(road.line[road.line.length - 1], anchor)).toBeGreaterThan(30);
  });

  it("drops a hazard beside no road", () => {
    expect(mapAlertElements([node(50, 30, 20, { highway: "speed_camera" }), street])).toEqual([]);
  });

  it("does not take a highway value that names an object property for a road", () => {
    const notARoad = way(
      7,
      [
        [8, -100, 0],
        [9, 0, 0],
        [10, 100, 0],
      ],
      { highway: "constructor" },
    );
    expect(mapAlertElements([node(9, 0, 0, { traffic_calming: "bump" }), notARoad])).toEqual([]);
  });

  it("drops a stop sign standing between two roads", () => {
    const other = way(
      4,
      [
        [5, -100, 10],
        [6, 100, 10],
      ],
      { highway: "residential" },
    );
    expect(mapAlertElements([node(50, 30, 5, { highway: "stop" }), street, other])).toEqual([]);
  });
});

describe("mapAlertElements — hazards beside the road", () => {
  /** A position `x` metres east and `y` metres north of (lng, lat) in the projection's frame. */
  function near(lat: number, lng: number, x: number, y: number): { lat: number; lon: number } {
    const kx = Math.cos((lat * Math.PI) / 180) * 111_320;
    return { lat: lat + y / M_PER_DEG_LAT, lon: lng + x / kx };
  }
  function camera(id: number, position: { lat: number; lon: number }): AlertOverpassElement {
    return { type: "node", id, ...position, tags: { highway: "speed_camera" } };
  }
  function road(id: number, positions: { lat: number; lon: number }[]): AlertOverpassElement {
    return {
      type: "way",
      id,
      tags: { highway: "residential" },
      nodes: positions.map((_, index) => id * 1000 + index),
      geometry: positions,
    };
  }

  it("attaches a camera near the far end of a long way at its projection", () => {
    const vertices = Array.from({ length: 101 }, (_, i) => at(-5000 + i * 100, 0));
    const alerts = mapAlertElements([
      node(50, 4990, 8, { highway: "speed_camera" }),
      road(1, vertices),
    ]);
    const roadAlert = byId(alerts, "speed_camera:50")?.roads[0];
    expect(roadAlert?.wayId).toBe(1);
    if (!roadAlert) return;
    const anchor = roadAlert.line[roadAlert.anchorIndex];
    const expected = at(4990, 0);
    expect(haversineDistance(anchor, [expected.lon, expected.lat])).toBeLessThan(0.1);
    expect(haversineDistance(roadAlert.line[0], anchor)).toBeCloseTo(ROAD_CONTEXT_REACH_M, 0);
  });

  it("does not attach a camera close to a way's bounding box but far from the way", () => {
    // A diagonal way: its box corner at (100, 0) lies 70 m from the line itself.
    const diagonal = road(1, [at(0, 0), at(100, 100)]);
    expect(mapAlertElements([node(50, 105, 5, { highway: "speed_camera" }), diagonal])).toEqual([]);
    expect(mapAlertElements([node(50, 95, 5, { highway: "speed_camera" }), diagonal])).toEqual([]);
  });

  it("attaches up to the snap distance and not beyond", () => {
    const street = road(1, [at(-100, 0), at(100, 0)]);
    expect(
      byId(
        mapAlertElements([node(50, 0, 14.95, { highway: "speed_camera" }), street]),
        "speed_camera:50",
      )?.roads[0]?.wayId,
    ).toBe(1);
    expect(mapAlertElements([node(50, 0, 15.05, { highway: "speed_camera" }), street])).toEqual([]);
    // Off the end of the way: the distance to its end node counts.
    expect(
      byId(
        mapAlertElements([node(51, 110, 10, { highway: "speed_camera" }), street]),
        "speed_camera:51",
      )?.roads[0]?.wayId,
    ).toBe(1);
    expect(mapAlertElements([node(51, 112, 10, { highway: "speed_camera" }), street])).toEqual([]);
  });

  it("measures longitude in metres at high latitude", () => {
    // At 69° N a degree of longitude is about 40 km, so 14 m east spans far
    // more degrees than 15 m would at the equator.
    const lat = 69;
    const lng = 18.95;
    const northbound = road(1, [near(lat, lng, 0, -100), near(lat, lng, 0, 100)]);
    const attached = mapAlertElements([camera(50, near(lat, lng, 14, 0)), northbound]);
    expect(byId(attached, "speed_camera:50")?.roads[0]?.wayId).toBe(1);
    expect(mapAlertElements([camera(50, near(lat, lng, 16, 0)), northbound])).toEqual([]);
    const westbound = road(2, [near(lat, lng, -200, 0), near(lat, lng, -20, 0)]);
    expect(
      byId(mapAlertElements([camera(51, near(lat, lng, -6, 0)), westbound]), "speed_camera:51")
        ?.roads[0]?.wayId,
    ).toBe(2);
    expect(mapAlertElements([camera(51, near(lat, lng, -4, 0)), westbound])).toEqual([]);
  });

  describe("matches the full projection against every road", () => {
    /** The original selection: project onto every road, then keep the nearest ones. */
    function referenceOffRoad(
      type: string,
      position: LngLat,
      roads: { id: number; coords: LngLat[] }[],
    ): { wayId: number; anchor: LngLat; along: number }[] {
      const kx = Math.cos((position[1] * Math.PI) / 180) * 111_320;
      const ky = 110_574;
      const nearRoads = roads
        .map((r) => {
          const cum = [0];
          for (let i = 1; i < r.coords.length; i++) {
            cum.push(cum[i - 1] + haversineDistance(r.coords[i - 1], r.coords[i]));
          }
          let best = { distance: Number.POSITIVE_INFINITY, along: 0, point: r.coords[0] };
          for (let i = 0; i < r.coords.length - 1; i++) {
            const [a, b] = [r.coords[i], r.coords[i + 1]];
            const ax = (a[0] - position[0]) * kx;
            const ay = (a[1] - position[1]) * ky;
            const dx = (b[0] - position[0]) * kx - ax;
            const dy = (b[1] - position[1]) * ky - ay;
            const lengthSquared = dx * dx + dy * dy;
            const t =
              lengthSquared > 0
                ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSquared))
                : 0;
            const distance = Math.hypot(ax + t * dx, ay + t * dy);
            if (distance < best.distance) {
              best = {
                distance,
                along: cum[i] + t * (cum[i + 1] - cum[i]),
                point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
              };
            }
          }
          return { r, best };
        })
        .filter(({ best }) => best.distance <= 15)
        .sort((a, b) => a.best.distance - b.best.distance);
      if (nearRoads.length === 0) return [];
      const candidates = nearRoads.filter(
        ({ best }) => best.distance <= nearRoads[0].best.distance + 3,
      );
      if (type === "stop" && candidates.length > 1) return [];
      return candidates.map(({ r, best }) => ({
        wayId: r.id,
        anchor: best.point,
        along: best.along,
      }));
    }

    /** mulberry32 */
    function prng(seed: number): () => number {
      let a = seed;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const round7 = (value: number) => Math.round(value * 1e7) / 1e7;

    it("on randomised layouts", () => {
      const random = prng(147);
      let attachedCount = 0;
      let rejectedCount = 0;
      for (let layout = 0; layout < 300; layout++) {
        const lat = -75 + random() * 150;
        const lng = -179 + random() * 358;
        const elements: AlertOverpassElement[] = [];
        const trafficRoads: { id: number; coords: LngLat[] }[] = [];
        const wayCount = 1 + Math.floor(random() * 8);
        for (let w = 0; w < wayCount; w++) {
          const id = layout * 100 + w + 1;
          const previous = trafficRoads[trafficRoads.length - 1];
          let positions: { lat: number; lon: number }[];
          if (previous && random() < 0.2) {
            // Same geometry under another id: ties must keep input order.
            positions = previous.coords.map(([lon, plat]) => ({ lat: plat, lon }));
          } else {
            const length = 2 + Math.floor(random() * 10);
            let x = (random() - 0.5) * 300;
            let y = (random() - 0.5) * 300;
            const step = 5 + random() * (random() < 0.2 ? 2000 : 80);
            positions = [];
            for (let i = 0; i < length; i++) {
              positions.push(near(lat, lng, x, y));
              const heading = random() * 2 * Math.PI;
              x += Math.cos(heading) * step;
              y += Math.sin(heading) * step;
            }
          }
          const highway = ["residential", "cycleway", "footway", "primary"][
            Math.floor(random() * 4)
          ];
          elements.push({ ...road(id, positions), tags: { highway } });
          if (highway !== "footway") {
            trafficRoads.push({ id, coords: positions.map((p) => [p.lon, p.lat]) });
          }
        }
        const nodeCount = 1 + Math.floor(random() * 6);
        const expected: {
          id: string;
          roads: { wayId: number; anchor: LngLat; along: number }[];
        }[] = [];
        for (let n = 0; n < nodeCount; n++) {
          // Outside the way node ids, so the node stands beside every road.
          const id = 9_000_000_000 + layout * 100 + n;
          const wayElement = elements[Math.floor(random() * elements.length)];
          const vertex =
            wayElement.geometry?.[Math.floor(random() * (wayElement.geometry?.length ?? 1))];
          if (!vertex) continue;
          const kx = Math.cos((vertex.lat * Math.PI) / 180) * 111_320;
          const offset = random() * 30;
          const heading = random() * 2 * Math.PI;
          const position = {
            lat: vertex.lat + (Math.sin(heading) * offset) / M_PER_DEG_LAT,
            lon: vertex.lon + (Math.cos(heading) * offset) / kx,
          };
          const type = random() < 0.25 ? "stop" : "speed_camera";
          elements.push({ type: "node", id, ...position, tags: { highway: type } });
          const roads = referenceOffRoad(type, [position.lon, position.lat], trafficRoads);
          if (roads.length > 0) expected.push({ id: `${type}:${id}`, roads });
          else rejectedCount++;
        }
        const alerts = mapAlertElements(elements);
        expect(alerts.map((alert) => alert.id)).toEqual(expected.map((e) => e.id));
        alerts.forEach((alert, i) => {
          expect(alert.roads.map((r) => r.wayId)).toEqual(expected[i].roads.map((r) => r.wayId));
          alert.roads.forEach((r, j) => {
            const reference = expected[i].roads[j];
            expect(r.line[r.anchorIndex]).toEqual([
              round7(reference.anchor[0]),
              round7(reference.anchor[1]),
            ]);
            // The slice reaches back along the road from the reference's along-distance.
            let back = 0;
            for (let k = 1; k <= r.anchorIndex; k++)
              back += haversineDistance(r.line[k - 1], r.line[k]);
            expect(Math.abs(back - Math.min(reference.along, ROAD_CONTEXT_REACH_M))).toBeLessThan(
              0.2,
            );
            attachedCount++;
          });
        });
      }
      // The layouts exercise both outcomes.
      expect(attachedCount).toBeGreaterThan(200);
      expect(rejectedCount).toBeGreaterThan(100);
    });
  });
});

describe("buildNavigationAlertsQuery", () => {
  it("queries hazards in the box with their road context", () => {
    const query = buildNavigationAlertsQuery({ south: 51.2, west: 6.6, north: 51.3, east: 6.7 });
    expect(query).toContain('node["highway"="stop"](51.2,6.6,51.3,6.7)');
    expect(query).toContain('way(bn.alerts)["highway"]->.roads;.roads out body geom;');
    expect(query).toContain("(.alerts; - .onRoad;)->.offRoad;");
  });
});
