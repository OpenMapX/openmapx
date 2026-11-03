import { describe, expect, it } from "vitest";
import type { RawRoadAlert, RoadAlertRoad } from "../../api/roadAlerts";
import type { LngLat } from "../../types/geometry";
import { cumulativeDistances } from "../deadReckon";
import { projectRoadAlertsOntoRoute } from "../roadAlertProjection";

const BASE_LAT = 51.23;
const BASE_LNG = 6.62;
// Metres per degree on the sphere `cumulativeDistances` measures on.
const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;
const M_PER_DEG_LNG = Math.cos((BASE_LAT * Math.PI) / 180) * M_PER_DEG_LAT;

/** A position `x` metres east and `y` metres north of the test origin. */
function at(x: number, y: number): LngLat {
  return [BASE_LNG + x / M_PER_DEG_LNG, BASE_LAT + y / M_PER_DEG_LAT];
}

function line(...points: [number, number][]): LngLat[] {
  return points.map(([x, y]) => at(x, y));
}

function road(
  points: [number, number][],
  anchorIndex: number,
  overrides: Partial<RoadAlertRoad> = {},
): RoadAlertRoad {
  return {
    wayId: 1,
    line: line(...points),
    anchorIndex,
    forward: true,
    backward: true,
    ...overrides,
  };
}

function alert(roads: RoadAlertRoad[], overrides: Partial<RawRoadAlert> = {}): RawRoadAlert {
  const anchor = roads[0]?.line[roads[0].anchorIndex] ?? at(0, 0);
  return { id: "stop:1", type: "stop", lng: anchor[0], lat: anchor[1], roads, ...overrides };
}

function project(alerts: RawRoadAlert[], geometry: LngLat[]) {
  const cum = cumulativeDistances(geometry);
  return projectRoadAlertsOntoRoute(alerts, geometry, cum, {
    fromMeters: 0,
    toMeters: cum[cum.length - 1],
  });
}

// A north–south priority road through a junction at (0, 0), as at
// Maubisstraße × Grünstraße: the route drives it northbound.
const PRIORITY_ROUTE = line([0, -200], [0, -50], [0, 0], [0, 50], [0, 200]);
// The side street leaves the junction eastward; its stop sign stands 7 m in,
// for traffic heading back west to the junction (against its digitisation).
const SIDE_STREET_STOP = road(
  [
    [0, 0],
    [7, 0],
    [42, 0],
  ],
  1,
  { forward: false, backward: true },
);

describe("projectRoadAlertsOntoRoute", () => {
  it("does not attach a side street's stop sign to the priority road", () => {
    expect(project([alert([SIDE_STREET_STOP])], PRIORITY_ROUTE)).toEqual([]);
  });

  it("attaches it to a route arriving along the side street toward the junction", () => {
    const route = line([150, 0], [42, 0], [7, 0], [0, 0], [0, 100]);
    const [projected] = project([alert([SIDE_STREET_STOP])], route);
    expect(projected).toMatchObject({ id: "stop:1", type: "stop" });
    expect(projected.alongMeters).toBeCloseTo(143, 0);
  });

  it("does not attach it to a route leaving the junction along the side street", () => {
    const route = line([0, -100], [0, 0], [7, 0], [42, 0], [150, 0]);
    expect(project([alert([SIDE_STREET_STOP])], route)).toEqual([]);
  });

  it("rejects a slip road merging at a shallow angle", () => {
    // The slip road joins the main road 20 m ahead at 15°; its stop sign sits
    // 2.5 m from the main road, inside a naive distance corridor.
    const t = Math.tan((15 * Math.PI) / 180);
    const slip = road(
      [
        [-40 * t, -60],
        [-9.3, -35],
        [-2.5 * 1, -9.3],
        [0, 0],
      ],
      2,
      { forward: true, backward: false },
    );
    const route = line([0, -200], [0, 0], [0, 200]);
    expect(project([alert([slip])], route)).toEqual([]);
  });

  it("rejects a side street's stop sign standing within the tolerance of the route", () => {
    // Mapped 2 m into the side street: close enough to pass the position
    // check, so only the road behind it can tell the route never drives it.
    const close = road(
      [
        [0, 0],
        [2, 0],
        [40, 0],
      ],
      1,
      { forward: false, backward: true },
    );
    expect(project([alert([close])], PRIORITY_ROUTE)).toEqual([]);
  });

  it("rejects a road merging at 8°", () => {
    const t = Math.tan((8 * Math.PI) / 180);
    const merge = road(
      [
        [-40 * t, -40],
        [-1, -1 / t],
        [0, 0],
      ],
      1,
      { forward: true, backward: false },
    );
    expect(project([alert([merge])], line([0, -200], [0, 200]))).toEqual([]);
  });

  it("rejects a hazard on a parallel road 8 m away, accepts it on that road", () => {
    const bump = alert(
      [
        road(
          [
            [8, -40],
            [8, 0],
            [8, 40],
          ],
          1,
        ),
      ],
      { id: "traffic_calming:2", type: "traffic_calming" },
    );
    expect(project([bump], line([0, -200], [0, 200]))).toEqual([]);
    expect(project([bump], line([8, -200], [8, 200]))).toHaveLength(1);
  });

  it("rejects a hazard on a road the route crosses over", () => {
    const below = road(
      [
        [-40, 0],
        [0, 0],
        [40, 0],
      ],
      1,
    );
    expect(project([alert([below])], line([0, -200], [0, 200]))).toEqual([]);
  });

  it("judges each pass of an out-and-back route on its own direction", () => {
    const route = line([0, -100], [0, 100], [0, -100]);
    const street = (forward: boolean, backward: boolean) =>
      road(
        [
          [0, -40],
          [0, 0],
          [0, 40],
        ],
        1,
        { forward, backward },
      );
    // Northbound is the way's forward direction: only the outbound pass.
    const northbound = project([alert([street(true, false)])], route);
    expect(northbound.map((a) => [a.id, Math.round(a.alongMeters)])).toEqual([["stop:1", 100]]);
    const southbound = project([alert([street(false, true)])], route);
    expect(southbound.map((a) => [a.id, Math.round(a.alongMeters)])).toEqual([["stop:1", 300]]);
    const both = project([alert([street(true, true)])], route);
    expect(both.map((a) => [a.id, Math.round(a.alongMeters)])).toEqual([
      ["stop:1", 100],
      ["stop:1#1", 300],
    ]);
  });

  it("attaches a hazard just ahead of the route start", () => {
    const route = line([0, -3], [0, 100]);
    const street = road(
      [
        [0, -40],
        [0, 0],
        [0, 40],
      ],
      1,
    );
    const [projected] = project([alert([street])], route);
    expect(projected.alongMeters).toBeCloseTo(3, 0);
  });

  it("survives duplicate route vertices", () => {
    const route = line([0, -200], [0, -50], [0, -50], [0, 200]);
    const street = road(
      [
        [0, -40],
        [0, 0],
        [0, 40],
      ],
      1,
    );
    const projected = project([alert([street])], route);
    expect(projected).toHaveLength(1);
    expect(Number.isFinite(projected[0].alongMeters)).toBe(true);
  });

  it("ignores an alert without roads and alerts outside the window", () => {
    expect(project([alert([])], PRIORITY_ROUTE)).toEqual([]);
    const street = road(
      [
        [0, 60],
        [0, 100],
        [0, 140],
      ],
      1,
    );
    const cum = cumulativeDistances(PRIORITY_ROUTE);
    expect(
      projectRoadAlertsOntoRoute([alert([street])], PRIORITY_ROUTE, cum, {
        fromMeters: 0,
        toMeters: 150,
      }),
    ).toEqual([]);
  });

  it("carries a speed camera's limit", () => {
    const camera = alert(
      [
        road(
          [
            [0, -40],
            [0, 0],
            [0, 40],
          ],
          1,
        ),
      ],
      { id: "speed_camera:3", type: "speed_camera", speedLimitKmh: 50 },
    );
    expect(project([camera], PRIORITY_ROUTE)).toEqual([
      expect.objectContaining({ id: "speed_camera:3", speedLimitKmh: 50 }),
    ]);
  });
});
