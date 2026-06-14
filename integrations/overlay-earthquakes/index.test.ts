import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ageCategory,
  buildFeedUrl,
  depthCategory,
  enrichFeatures,
  magLabel,
  magnitudeToThreshold,
} from "./index.js";

// `enrichFeatures` adds runtime-only properties not present on the typed
// interface; this is the shape the map layer actually consumes.
interface EnrichedProps {
  mag: number;
  depth: number;
  depthCategory: string;
  magLabel: string;
  ageMs: number;
  ageCategory: string;
}

function makeFeatureCollection(
  features: Array<{
    coordinates: [number, number, number];
    mag: number | null;
    time: number;
  }>,
) {
  return {
    type: "FeatureCollection" as const,
    metadata: { generated: 0, url: "", title: "", count: features.length },
    features: features.map((f) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: f.coordinates },
      properties: {
        mag: f.mag,
        place: "somewhere",
        time: f.time,
        updated: f.time,
        url: "",
        detail: "",
        felt: null,
        cdi: null,
        mmi: null,
        alert: null,
        status: "reviewed",
        tsunami: 0,
        sig: 0,
        net: "us",
        code: "x",
        magType: "mb",
        type: "earthquake",
        title: "M 5.0",
      },
    })),
  };
}

describe("magnitudeToThreshold", () => {
  it.each([
    [6.0, "4.5"],
    [4.5, "4.5"],
    [4.49, "2.5"],
    [2.5, "2.5"],
    [2.49, "1.0"],
    [1.0, "1.0"],
    [0.9, "all"],
    [0, "all"],
  ])("maps min magnitude %s to feed threshold %s", (min, expected) => {
    expect(magnitudeToThreshold(min)).toBe(expected);
  });
});

describe("buildFeedUrl", () => {
  it("composes the USGS summary feed URL from threshold and range", () => {
    expect(buildFeedUrl("week", "2.5")).toBe(
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson",
    );
    expect(buildFeedUrl("hour", "all")).toBe(
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
    );
  });
});

describe("depthCategory", () => {
  it.each([
    [0, "shallow"],
    [69.9, "shallow"],
    [70, "intermediate"],
    [299, "intermediate"],
    [300, "deep"],
    [700, "deep"],
  ])("classifies depth %s km as %s", (depth, expected) => {
    expect(depthCategory(depth)).toBe(expected);
  });
});

describe("magLabel", () => {
  it.each([
    [1.5, "Micro"],
    [2.0, "Minor"],
    [3.9, "Minor"],
    [4.0, "Light"],
    [5.0, "Moderate"],
    [6.0, "Strong"],
    [7.0, "Major"],
    [8.0, "Great"],
    [9.1, "Great"],
  ])("labels magnitude %s as %s", (mag, expected) => {
    expect(magLabel(mag)).toBe(expected);
  });
});

describe("ageCategory", () => {
  it.each([
    [0, "recent"],
    [3_599_999, "recent"],
    [3_600_000, "today"],
    [86_399_999, "today"],
    [86_400_000, "this_week"],
    [604_799_999, "this_week"],
    [604_800_000, "older"],
  ])("classifies age %s ms as %s", (age, expected) => {
    expect(ageCategory(age)).toBe(expected);
  });
});

describe("enrichFeatures", () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives depth/mag/age categories and preserves [lng,lat,depth] order", () => {
    // 6 hours ago -> within a day but past the 1-hour "recent" window.
    const sixHoursAgo = NOW - 6 * 3_600_000;
    const fc = makeFeatureCollection([
      { coordinates: [-122.5, 38.8, 8.2], mag: 6.4, time: sixHoursAgo },
    ]);

    const out = enrichFeatures(fc);
    const f = out.features[0];
    const props = f.properties as unknown as EnrichedProps;

    // Geometry is GeoJSON [lng, lat, depth] and must round-trip untouched.
    expect(f.geometry.coordinates).toEqual([-122.5, 38.8, 8.2]);
    expect(props.depth).toBe(8.2);
    expect(props.depthCategory).toBe("shallow");
    expect(props.mag).toBe(6.4);
    expect(props.magLabel).toBe("Strong");
    expect(props.ageMs).toBe(6 * 3_600_000);
    expect(props.ageCategory).toBe("today");
  });

  it("labels a sub-hour-old quake as recent", () => {
    const fc = makeFeatureCollection([{ coordinates: [0, 0, 5], mag: 4, time: NOW - 1_800_000 }]);
    const props = enrichFeatures(fc).features[0].properties as unknown as EnrichedProps;
    expect(props.ageCategory).toBe("recent");
  });

  it("coerces a null magnitude to 0 and labels it Micro", () => {
    const fc = makeFeatureCollection([{ coordinates: [0, 0, 10], mag: null, time: NOW }]);

    const props = enrichFeatures(fc).features[0].properties as unknown as EnrichedProps;
    expect(props.mag).toBe(0);
    expect(props.magLabel).toBe("Micro");
  });

  it("clamps a negative depth to 0", () => {
    const fc = makeFeatureCollection([{ coordinates: [10, 20, -5], mag: 3, time: NOW }]);

    const props = enrichFeatures(fc).features[0].properties as unknown as EnrichedProps;
    expect(props.depth).toBe(0);
    expect(props.depthCategory).toBe("shallow");
  });

  it("returns an empty feature list unchanged", () => {
    const out = enrichFeatures(makeFeatureCollection([]));
    expect(out.features).toEqual([]);
    expect(out.type).toBe("FeatureCollection");
  });
});
