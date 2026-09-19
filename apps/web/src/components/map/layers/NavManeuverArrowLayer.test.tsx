import { cumulativeDistances, haversineDistance, positionAt } from "@openmapx/core";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, expectStyleSwapIsLossless } from "@/test";

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
  navState.progress = {
    currentStepIndex: 0,
    distanceToNextManeuver: 300,
    speedMps: 30,
    alongMeters: 700,
  };
});

describe("NavManeuverArrowLayer", () => {
  it("draws casing, body and arrowhead above the basemap labels inside the approach window", () => {
    render(<NavManeuverArrowLayer />);
    const ids = [...fake.state.layers.keys()];
    for (const id of [
      "nav-maneuver-arrow-casing",
      "nav-maneuver-arrow",
      "nav-maneuver-arrow-head",
    ]) {
      expect(ids).toContain(id);
      expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf("place-labels"));
    }
  });

  it("publishes one LineString and one Point feature, both carrying a bearing", () => {
    render(<NavManeuverArrowLayer />);
    const feats = features();
    expect(feats).toHaveLength(2);
    const line = feats.find((f) => f.geometry.type === "LineString");
    const point = feats.find((f) => f.geometry.type === "Point");
    expect(line).toBeTruthy();
    expect(point).toBeTruthy();
    expect(typeof line?.properties?.bearing).toBe("number");
    expect(typeof point?.properties?.bearing).toBe("number");
  });

  it("empties the source outside the approach window", () => {
    navState.progress = {
      currentStepIndex: 0,
      distanceToNextManeuver: 5000,
      speedMps: 30,
      alongMeters: 700,
    };
    render(<NavManeuverArrowLayer />);
    expect(features()).toHaveLength(0);
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
    const feats = features();
    expect(feats).toHaveLength(2);
    const line = feats.find(
      (f) => f.geometry.type === "LineString",
    ) as GeoJSON.Feature<GeoJSON.LineString>;
    const maneuverPoint = positionAt(geometry as [number, number][], cum, 1000).point as [
      number,
      number,
    ];
    const first = line.geometry.coordinates[0] as [number, number];
    const last = line.geometry.coordinates.at(-1) as [number, number];
    expect(haversine(first, maneuverPoint)).toBeGreaterThan(25);
    expect(haversine(first, maneuverPoint)).toBeLessThan(35);
    expect(haversine(last, maneuverPoint)).toBeGreaterThan(15);
    expect(haversine(last, maneuverPoint)).toBeLessThan(25);
    navState.mode = "driving";
  });

  it("republishes the source zero times across 100 progress updates in the same window", () => {
    render(<NavManeuverArrowLayer />);
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
      render(<NavManeuverArrowLayer />);
    }
    expect(fake.state.counts.setData.get(SOURCE)).toBeUndefined();
  });

  it("loses nothing across a style change", () => {
    render(<NavManeuverArrowLayer />);
    expectStyleSwapIsLossless(fake);
  });
});

/** haversine metres between two lng/lats. */
function haversine(a: [number, number], b: [number, number]): number {
  return haversineDistance(a, b);
}
