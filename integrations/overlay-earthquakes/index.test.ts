import type { HazardsProvider, NaturalHazard } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ageCategory,
  depthCategory,
  enrichFeatures,
  hazardsToFeatureCollection,
  magLabel,
  setup,
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
    sources: ["usgs-quakes"],
    features: features.map((f, i) => ({
      type: "Feature" as const,
      id: `q${i}`,
      geometry: { type: "Point" as const, coordinates: f.coordinates },
      properties: {
        mag: f.mag,
        place: "somewhere",
        time: f.time,
        url: null,
        felt: null,
        mmi: null,
        alert: null,
        tsunami: 0,
        sources: ["usgs-quakes"],
      },
    })),
  };
}

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

  it("keeps a negative depth (above sea level) negative", () => {
    const fc = makeFeatureCollection([{ coordinates: [10, 20, -5], mag: 3, time: NOW }]);

    const props = enrichFeatures(fc).features[0].properties as unknown as EnrichedProps;
    expect(props.depth).toBe(-5);
    expect(props.depthCategory).toBe("shallow");
  });

  it("returns an empty feature list unchanged", () => {
    const out = enrichFeatures(makeFeatureCollection([]));
    expect(out.features).toEqual([]);
    expect(out.type).toBe("FeatureCollection");
  });
});

function quake(over: Partial<NaturalHazard> = {}): NaturalHazard {
  return {
    id: "oc:situation:usgs-quakes:us7000abcd",
    type: "earthquake",
    geometry: { type: "Point", coordinates: [-122.5, 38.8] },
    point: [-122.5, 38.8],
    name: "5 km NW of The Geysers, CA",
    start: "2026-10-09T05:00:00Z",
    ended: true,
    magnitude: { value: 4.2, scale: "ml" },
    depthM: 8200,
    detailUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
    sources: ["usgs-quakes"],
    attributions: [],
    ...over,
  };
}

interface Sent {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

async function callEarthquakes(
  providers: HazardsProvider[],
  query: Record<string, string> = {},
  cache?: ReturnType<typeof createMockIntegrationContext>["cache"],
) {
  const base = createMockIntegrationContext(cache ? { cache } : {});
  const ctx = {
    ...base,
    getIntegrationsByDomain: (domain: string) =>
      domain === "hazards"
        ? providers.map((p) => ({ id: p.id, providers: new Map([["hazards", [p]]]) }))
        : [],
  } as unknown as Parameters<typeof setup>[0];
  setup(ctx);
  const route = base.registered.routes.find((r) => r.path === "/earthquakes");
  if (!route) throw new Error("no /earthquakes route");

  const sent: Sent = { status: 200, headers: {}, body: undefined };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    header(name: string, value: string) {
      sent.headers[name] = value;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  await route.handler({ query, params: {}, headers: {} } as never, reply as never);
  return sent;
}

function provider(over: Partial<HazardsProvider> = {}): HazardsProvider {
  return {
    id: "hazards-test",
    coverage: { all: true },
    getAlerts: async () => ({ alerts: [] }),
    getNaturalHazards: async () => ({ hazards: [] }),
    getFirePixels: async () => ({ pixels: [] }),
    getFireDensity: async () => ({ cells: [], sources: [] }),
    ...over,
  };
}

type EnrichedBody = {
  sources: string[];
  features: Array<{
    geometry: { coordinates: number[] };
    properties: Record<string, unknown> & { depth: number };
  }>;
};

describe("hazardsToFeatureCollection", () => {
  it("builds the feature the layer reads from the earthquake", () => {
    const fc = hazardsToFeatureCollection(
      [
        quake({
          feltReports: 12,
          mmi: 4.1,
          severity: { label: "minor", declared: "green" },
          tsunamiFlag: true,
        }),
      ],
      0,
    );
    expect(fc.sources).toEqual(["usgs-quakes"]);
    expect(fc.features[0]).toEqual({
      type: "Feature",
      id: "oc:situation:usgs-quakes:us7000abcd",
      geometry: { type: "Point", coordinates: [-122.5, 38.8, 8.2] },
      properties: {
        mag: 4.2,
        place: "5 km NW of The Geysers, CA",
        time: Date.parse("2026-10-09T05:00:00Z"),
        url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
        felt: 12,
        mmi: 4.1,
        alert: "green",
        tsunami: 1,
        sources: ["usgs-quakes"],
      },
    });
  });

  it("filters on the magnitude exactly: M6 drops an M5.9 and keeps an M6.0", () => {
    const fc = hazardsToFeatureCollection(
      [
        quake({ id: "m59", magnitude: { value: 5.9, scale: "mww" } }),
        quake({ id: "m60", magnitude: { value: 6.0, scale: "mww" } }),
      ],
      6,
    );
    expect(fc.features.map((f) => f.id)).toEqual(["m60"]);
  });

  it("keeps a quake without a magnitude only when no minimum is asked for", () => {
    const unrated = quake({ magnitude: undefined });
    expect(hazardsToFeatureCollection([unrated], 0).features).toHaveLength(1);
    expect(hazardsToFeatureCollection([unrated], 0.1).features).toHaveLength(0);
  });
});

describe("GET /earthquakes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the earthquakes of the range from the world, in the requested language", async () => {
    const getNaturalHazards = vi.fn<HazardsProvider["getNaturalHazards"]>(async () => ({
      hazards: [
        quake({ id: "high", depthM: -1500 }),
        quake({ id: "m59", magnitude: { value: 5.9, scale: "mww" } }),
      ],
    }));

    const sent = await callEarthquakes([provider({ getNaturalHazards })], {
      timeRange: "day",
      minMagnitude: "6",
      lang: "en",
    });

    expect(getNaturalHazards).toHaveBeenCalledWith([-180, -90, 180, 90], {
      types: ["earthquake"],
      since: "2026-10-08T12:00:00.000Z",
      lang: "en",
    });
    expect(sent.status).toBe(200);
    expect(sent.headers["Cache-Control"]).toBe("public, max-age=120");
    expect((sent.body as EnrichedBody).features).toHaveLength(0);
  });

  it("serves the magnitude-filtered features with the depth in km, unclamped", async () => {
    const getNaturalHazards = async () => ({
      hazards: [
        quake({ id: "high", depthM: -1500, magnitude: { value: 6.3, scale: "mww" } }),
        quake({ id: "m59", magnitude: { value: 5.9, scale: "mww" } }),
      ],
    });

    const sent = await callEarthquakes([provider({ getNaturalHazards })], { minMagnitude: "6" });

    const body = sent.body as EnrichedBody;
    expect(body.sources).toEqual(["usgs-quakes"]);
    expect(body.features).toHaveLength(1);
    expect(body.features[0].geometry.coordinates[2]).toBe(-1.5);
    expect(body.features[0].properties.depth).toBe(-1.5);
    expect(sent.headers["Cache-Control"]).toBe("public, max-age=300");
  });

  it("rejects an unknown range and a malformed or out-of-range magnitude", async () => {
    expect((await callEarthquakes([provider()], { timeRange: "year" })).status).toBe(400);
    for (const minMagnitude of ["big", "-1", "11", "Infinity", "1e999"]) {
      expect((await callEarthquakes([provider()], { minMagnitude })).status).toBe(400);
    }
  });

  it("reads any language other than German as English", async () => {
    const getNaturalHazards = vi.fn<HazardsProvider["getNaturalHazards"]>(async () => ({
      hazards: [],
    }));
    await callEarthquakes([provider({ getNaturalHazards })], { lang: "fr" });
    await callEarthquakes([provider({ getNaturalHazards })], { lang: "de-CH" });
    expect(getNaturalHazards.mock.calls.map((call) => call[1].lang)).toEqual(["en", "de"]);
  });

  it("caches the unfiltered world once per range and language, whatever the magnitude", async () => {
    const keys: string[] = [];
    const cache = {
      ...createMockIntegrationContext().cache,
      withCache: async <T>(key: string, _ttl: number, fn: () => Promise<T>) => {
        keys.push(key);
        return fn();
      },
    };
    const getNaturalHazards = async () => ({
      hazards: [quake({ magnitude: { value: 5.9, scale: "mww" } })],
    });
    for (const minMagnitude of ["0", "2.5", "5.123456"]) {
      const sent = await callEarthquakes(
        [provider({ getNaturalHazards })],
        { minMagnitude },
        cache,
      );
      expect((sent.body as EnrichedBody).features).toHaveLength(1);
    }
    expect(new Set(keys).size).toBe(1);
  });

  it("answers 503 when every provider failed", async () => {
    const getNaturalHazards = async () => {
      throw new Error("upstream down");
    };
    const sent = await callEarthquakes([provider({ getNaturalHazards })]);
    expect(sent.status).toBe(503);
    expect(sent.headers["Cache-Control"]).toBe("no-store");
  });

  it("answers 503 when no hazards provider is configured: no source is not no earthquakes", async () => {
    const sent = await callEarthquakes([]);
    expect(sent.status).toBe(503);
    expect(sent.headers["Cache-Control"]).toBe("no-store");
  });
});
