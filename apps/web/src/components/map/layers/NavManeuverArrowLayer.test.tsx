import {
  bearingBetween,
  cumulativeDistances,
  haversineDistance,
  laneRejoinAlong,
  maneuverArrowSpans,
  maneuverStartMeters,
  numberAt,
  positionAt,
  type Route,
} from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import { createFakeMap, nth } from "@/test";

const fake = createFakeMap({
  styleLoaded: true,
  baseLayers: [{ id: "place-labels", type: "symbol" }],
});

const geometry: [number, number][] = [
  [8, 50],
  [8, 50.01],
  [8, 50.02],
];
const cum = cumulativeDistances(geometry);
// The maneuver sits 1000 m along the ~2.2 km route.
const route = {
  geometry,
  distance: 2200,
  duration: 120,
  mode: "driving",
  steps: [
    { instruction: "Head north", distance: 1000, duration: 60, maneuver: { type: "depart" } },
    {
      instruction: "Keep right",
      distance: 1000,
      duration: 60,
      maneuver: { type: "fork", modifier: "right" },
    },
    { instruction: "Arrive", distance: 200, duration: 30, maneuver: { type: "arrive" } },
  ],
};

const navState: Record<string, unknown> = {
  status: "navigating",
  route,
  mode: "driving",
  progress: {
    currentStepIndex: 0,
    distanceToNextManeuver: 300,
    speedMps: 30,
    alongMeters: 700,
  },
};

const mapRef: { current: unknown } = { current: fake.map };
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNavigationStore: Object.assign(
    (selector: (s: typeof navState) => unknown) => selector(navState),
    { getState: () => navState },
  ),
}));

import { NavManeuverArrowLayer } from "./NavManeuverArrowLayer";

const SOURCE = "nav-maneuver-arrow-source";

function features(): GeoJSON.Feature[] {
  const data = fake.state.sources.get(SOURCE)?.data as { features?: GeoJSON.Feature[] } | undefined;
  return data?.features ?? [];
}

afterEach(() => {
  navState.route = route;
  navState.progress = {
    currentStepIndex: 0,
    distanceToNextManeuver: 300,
    speedMps: 30,
    alongMeters: 700,
  };
});

describe("NavManeuverArrowLayer in 3D", () => {
  const RAISED = "nav-maneuver-arrow-raised";
  const visibility = (id: string) => fake.map.getLayoutProperty(id, "visibility") ?? "visible";
  const setZoom = (zoom: number) =>
    act(() => {
      fake.state.zoom = zoom;
      fake.emit("zoom");
    });
  afterEach(() => {
    act(() => useNavigationSceneStore.getState().setActive(false));
    fake.state.zoom = 10;
  });

  it("the raised arrow replaces the 2D arrow in 3D from z16.5", () => {
    render(<NavManeuverArrowLayer />);
    setZoom(17);
    act(() => useNavigationSceneStore.getState().setActive(true));
    expect(fake.state.layers.get(RAISED)).toMatchObject({ type: "fill-extrusion" });
    expect(layerRegistrations().find((r) => r.id === RAISED)).toMatchObject({
      slot: "scene-3d",
      order: 14,
    });
    expect(fake.state.paint.get(RAISED)).toMatchObject({
      "fill-extrusion-base": 0.8,
      "fill-extrusion-height": 1.1,
      "fill-extrusion-color": "#ffffff",
    });
    expect(visibility(RAISED)).toBe("visible");
    for (const id of ["nav-maneuver-arrow-casing", "nav-maneuver-arrow", "nav-maneuver-arrow-head"])
      expect(visibility(id)).toBe("none");
  });

  it("below z16.5 the 2D arrow stays", () => {
    render(<NavManeuverArrowLayer />);
    setZoom(16);
    act(() => useNavigationSceneStore.getState().setActive(true));
    expect(visibility("nav-maneuver-arrow")).toBe("visible");
    expect(fake.state.layers.has(RAISED) ? visibility(RAISED) : "none").toBe("none");
  });

  it("publishes the raised arrow's span so the route ghost can leave it white", () => {
    render(<NavManeuverArrowLayer />);
    setZoom(17);
    act(() => useNavigationSceneStore.getState().setActive(true));
    const along = maneuverStartMeters(route as unknown as Route, 1);
    const spans = maneuverArrowSpans("driving");
    expect(useNavigationSceneStore.getState().arrowSpan).toEqual({
      fromAlong: along - spans.before,
      toAlong: along + spans.after,
    });
    setZoom(16);
    expect(useNavigationSceneStore.getState().arrowSpan).toBeNull();
  });

  it("runs the arrow in the highlighted lane, back on the route line at its head", () => {
    render(<NavManeuverArrowLayer />);
    setZoom(17);
    act(() => useNavigationSceneStore.getState().setActive(true));
    const lineOf = () =>
      features().find((f) => f.geometry.type === "LineString")?.geometry as GeoJSON.LineString;
    const plain = lineOf().coordinates as [number, number][];
    const along = maneuverStartMeters(route as unknown as Route, 1);
    act(() =>
      useNavigationSceneStore.getState().setHighlightSpan({
        fromAlong: along - 80,
        toAlong: along - 5,
        rejoinAlong: laneRejoinAlong(along, "driving"),
        offsetMeters: 3,
      }),
    );
    const shifted = lineOf().coordinates as [number, number][];
    // The first vertex moved 3 m sideways; the tip did not.
    expect(haversineDistance(nth(shifted, 0), nth(plain, 0))).toBeCloseTo(3, 0);
    expect(nth(shifted, -1)).toEqual(nth(plain, -1));
    // It stays off the route line through the junction, cutting the corner
    // from the lane, and rejoins it only at the arrow head.
    const geometry = (route as unknown as Route).geometry;
    const turnPoint = positionAt(geometry, cumulativeDistances(geometry), along).point;
    const nearest = Math.min(...shifted.map((p) => haversineDistance(p, turnPoint)));
    expect(nearest).toBeGreaterThan(0.5);
  });

  it("3D off restores the 2D arrow", () => {
    render(<NavManeuverArrowLayer />);
    setZoom(17);
    act(() => useNavigationSceneStore.getState().setActive(true));
    act(() => useNavigationSceneStore.getState().setActive(false));
    expect(visibility("nav-maneuver-arrow")).toBe("visible");
    expect(fake.state.layers.has(RAISED) ? visibility(RAISED) : "none").toBe("none");
  });
});

describe("NavManeuverArrowLayer", () => {
  it("centres the map arrow on the same physical maneuver as the countdown", () => {
    navState.route = {
      ...route,
      steps: route.steps.map((step, i) => ({
        ...step,
        coordinates:
          i === 0
            ? [geometry[0], geometry[1]]
            : i === 1
              ? [geometry[1], geometry[2]]
              : [geometry[2]],
      })),
    };
    const view = render(<NavManeuverArrowLayer />);
    const ids = [...fake.state.layers.keys()];
    for (const id of [
      "nav-maneuver-arrow-casing",
      "nav-maneuver-arrow",
      "nav-maneuver-arrow-head",
    ]) {
      expect(ids).toContain(id);
      expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf("place-labels"));
    }
    const feats = features().filter((f) => f.geometry.type !== "Polygon");
    expect(feats).toHaveLength(2);
    const point = feats.find((f) => f.geometry.type === "Point");
    expect(point).toBeTruthy();
    expect(typeof point?.properties?.bearing).toBe("number");
    const line = features().find(
      (feature) => feature.geometry.type === "LineString",
    ) as GeoJSON.Feature<GeoJSON.LineString>;
    expect(line).toBeTruthy();
    expect(typeof line.properties?.bearing).toBe("number");
    const nearest = Math.min(
      ...line.geometry.coordinates.map((p) => haversineDistance(p as [number, number], [8, 50.01])),
    );
    expect(nearest).toBeLessThan(0.5);
    navState.progress = {
      currentStepIndex: 0,
      distanceToNextManeuver: 5000,
      speedMps: 30,
      alongMeters: 700,
    };
    view.rerender(<NavManeuverArrowLayer />);
    expect(features()).toHaveLength(0);
  });

  it("irons a sideways step in the route out of the arrow", () => {
    // 3 m sideways, 25 m before the maneuver, as where a road splits into two
    // carriageways.
    const stepped: [number, number][] = [
      [8, 50],
      [8, 50.008768],
      [8.000042, 50.008795],
      [8.000042, 50.02],
    ];
    navState.route = { ...route, geometry: stepped };
    render(<NavManeuverArrowLayer />);
    const line = features().find((f) => f.geometry.type === "LineString")
      ?.geometry as GeoJSON.LineString;
    const points = line.coordinates as [number, number][];
    let sharpest = 0;
    for (let i = 2; i < points.length; i++) {
      const turn = Math.abs(
        ((bearingBetween(nth(points, i - 1), nth(points, i)) -
          bearingBetween(nth(points, i - 2), nth(points, i - 1)) +
          540) %
          360) -
          180,
      );
      sharpest = Math.max(sharpest, turn);
    }
    expect(sharpest).toBeLessThan(10);
  });

  it("uses the short spans for a walking route", () => {
    navState.mode = "walking";
    navState.progress = {
      currentStepIndex: 0,
      distanceToNextManeuver: 20,
      speedMps: 1.4,
      alongMeters: 980,
    };
    render(<NavManeuverArrowLayer />);
    const feats = features().filter((f) => f.geometry.type !== "Polygon");
    expect(feats).toHaveLength(2);
    const line = feats.find(
      (f) => f.geometry.type === "LineString",
    ) as GeoJSON.Feature<GeoJSON.LineString>;
    const maneuverPoint = positionAt(geometry as [number, number][], cum, 1000).point as [
      number,
      number,
    ];
    const coordinates = line.geometry.coordinates;
    const first = nth(coordinates, 0);
    const last = nth(coordinates, coordinates.length - 1);
    expect(haversine(first, maneuverPoint)).toBeGreaterThan(25);
    expect(haversine(first, maneuverPoint)).toBeLessThan(35);
    expect(haversine(last, maneuverPoint)).toBeGreaterThan(15);
    expect(haversine(last, maneuverPoint)).toBeLessThan(25);
    navState.mode = "driving";
  });

  it("republishes the source zero times across 100 progress updates in the same window", () => {
    const view = render(<NavManeuverArrowLayer />);
    fake.state.counts.setData.delete(SOURCE);
    for (let i = 0; i < 100; i += 1) {
      navState.progress = {
        currentStepIndex: 0,
        distanceToNextManeuver: 300 - i,
        speedMps: 30,
        alongMeters: 700 + i,
      };
      // The features memo keys on route, upcoming index and approaching only —
      // a re-render with new progress but the same window must not touch data.
      view.rerender(<NavManeuverArrowLayer />);
    }
    expect(fake.state.counts.setData.get(SOURCE)).toBeUndefined();
  });
});

/** haversine metres between two lng/lats; a short position gives NaN and fails the comparison. */
function haversine(a: readonly number[], b: readonly number[]): number {
  return haversineDistance([numberAt(a, 0), numberAt(a, 1)], [numberAt(b, 0), numberAt(b, 1)]);
}
