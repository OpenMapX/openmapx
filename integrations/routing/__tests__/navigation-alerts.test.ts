import { haversineDistance, type LngLat } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import kaarst from "../__fixtures__/kaarst-maubisstrasse-alerts.json";
import {
  type AlertOverpassElement,
  buildNavigationAlertsQuery,
  mapAlertElements,
  type RawRoadAlert,
  ROAD_CONTEXT_REACH_M,
} from "../navigation-alerts.js";

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
  const alerts = mapAlertElements(kaarst.elements as AlertOverpassElement[]);

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

describe("buildNavigationAlertsQuery", () => {
  it("queries hazards in the box with their road context", () => {
    const query = buildNavigationAlertsQuery({ south: 51.2, west: 6.6, north: 51.3, east: 6.7 });
    expect(query).toContain('node["highway"="stop"](51.2,6.6,51.3,6.7)');
    expect(query).toContain('way(bn.alerts)["highway"]->.roads;.roads out body geom;');
    expect(query).toContain("(.alerts; - .onRoad;)->.offRoad;");
  });
});
