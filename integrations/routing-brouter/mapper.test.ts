import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/aachen.json";
import { mapBrouterRoute } from "./mapper";

const points: [number, number][] = [
  [6.08, 50.775],
  [6.09, 50.777],
  [6.1, 50.78],
];
const copy = () => structuredClone(fixture);
describe("BRouter route mapping", () => {
  it("maps a real three-stop route with aligned navigation and uniform heights", () => {
    const route = mapBrouterRoute(fixture, points, { lang: "de" });
    expect(route.mode).toBe("cycling");
    expect(route.distance).toBe(2104);
    expect(route.duration).toBe(326);
    expect(route.legs).toHaveLength(2);
    expect(route.steps[0].maneuver?.type).toBe("depart");
    expect(route.steps.at(-1)?.maneuver?.type).toBe("arrive");
    expect(route.steps[0].instruction).toBe("Losfahren");
    expect(route.legs.reduce((s, l) => s + l.distance, 0)).toBeCloseTo(route.distance);
    expect(
      route.legs
        .flatMap((l) => l.geometry.slice(0, -1))
        .concat([route.geometry[route.geometry.length - 1]]),
    ).toEqual(route.geometry);
    expect(route.steps.reduce((s, x) => s + x.duration, 0)).toBeCloseTo(route.duration);
    expect(route.elevation?.length).toBeGreaterThan(2);
    expect(route.elevationInterval).toBeGreaterThan(0);
  });
  it("does not fabricate missing elevations", () => {
    const f = copy();
    f.features[0].geometry.coordinates[3] = [6.08, 50.775];
    expect(mapBrouterRoute(f, points).elevation).toBeUndefined();
  });
  it.each(["times", "index", "geometry"])("rejects malformed %s", (kind) => {
    const f = copy();
    const line = f.features[0];
    if (kind === "times") line.properties.times[3] = -1;
    else if (kind === "index") line.properties.voicehints[0][0] = 999999;
    else line.geometry.coordinates[0][0] = 999;
    expect(() => mapBrouterRoute(f, points)).toThrow();
  });
  it("retains roundabout exits and u-turn direction", () => {
    const f = copy();
    f.features[0].properties.voicehints = [
      [2, 13, 3, 1, 0],
      [5, 10, 0, 1, 0],
      [7, 11, 0, 1, 0],
    ];
    const r = mapBrouterRoute(f, [points[0], points[2]]);
    expect(r.steps[1]).toMatchObject({ maneuver: { type: "roundabout" }, roundaboutExitCount: 3 });
    expect(r.steps[2].maneuver).toEqual({ type: "turn", modifier: "uturn" });
    expect(r.steps[3].maneuver).toEqual({ type: "turn", modifier: "uturn" });
  });
  it("matches repeated waypoints in travel order", () => {
    const raw = {
      features: [
        {
          geometry: {
            type: "LineString",
            coordinates: [
              [6, 50, 1],
              [6.01, 50, 2],
              [6, 50, 1],
              [6.02, 50, 2],
            ],
          },
          properties: {
            "track-length": "3000",
            "total-time": "600",
            times: [0, 200, 400, 600],
            voicehints: [],
          },
        },
      ],
    };
    const r = mapBrouterRoute(raw, [
      [6, 50],
      [6.01, 50],
      [6, 50],
      [6.02, 50],
    ]);
    expect(r.legs).toHaveLength(3);
    expect(r.legs[1].geometry).toEqual([
      [6.01, 50],
      [6, 50],
    ]);
  });
});

it("accepts a real short route with no voicehints and still provides departure/arrival", async () => {
  const { default: raw } = await import("./__fixtures__/no-turn.json");
  const r = mapBrouterRoute(raw, [
    [6.079894, 50.77494],
    [6.080191, 50.774728],
  ]);
  expect(r.distance).toBe(32);
  expect(r.steps.map((s) => s.maneuver?.type)).toEqual(["depart", "arrive"]);
});
it("normalizes signed left-driving roundabout exits", () => {
  const f = copy();
  f.features[0].properties.voicehints = [[2, 14, -3, 1, 0]];
  const r = mapBrouterRoute(f, [points[0], points[2]]);
  expect(r.steps[1]).toMatchObject({
    roundaboutExitCount: 3,
    drivingSide: "left",
    instruction: "At the roundabout, take exit 3",
  });
});
it("rejects explicitly malformed voicehints", () => {
  const f = copy();
  Object.assign(f.features[0].properties, { voicehints: null });
  expect(() => mapBrouterRoute(f, points)).toThrow(/maneuver/);
});
