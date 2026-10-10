import type { FirePixel, HazardsProvider, NaturalHazard } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

const NOW = "2026-10-09T12:00:00.000Z";

const POLYGON: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [-120.5, 38.1],
      [-120.4, 38.1],
      [-120.4, 38.2],
      [-120.5, 38.1],
    ],
  ],
};

function pixel(over: Partial<FirePixel> = {}): FirePixel {
  return {
    id: "N20:38.1234,-120.4567:2026-10-09T0930",
    point: [-120.4567, 38.1234],
    observedAt: "2026-10-09T09:30:00.000Z",
    frpMW: 12.5,
    brightnessK: 331.2,
    instrument: "viirs",
    satellite: "N20",
    confidence: { level: "nominal" },
    dayNight: "day",
    sources: ["nasa-firms-viirs-fires"],
    ...over,
  };
}

function hazard(over: Partial<NaturalHazard> = {}): NaturalHazard {
  return {
    id: "oc:situation:us-nifc-fires:{ABC-123}",
    type: "wildfire",
    subtype: "wildfire_perimeter",
    geometry: POLYGON,
    point: [-120.45, 38.15],
    name: "Pine Fire",
    ended: false,
    sources: ["us-nifc-fires"],
    attributions: [],
    ...over,
  };
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

interface Sent {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

async function call(
  path: string,
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
  const route = base.registered.routes.find((r) => r.path === path);
  if (!route) throw new Error(`no ${path} route`);

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

const VIEW = { west: "-121", south: "37.5", east: "-120", north: "38.5" };

type Body = {
  type: string;
  features: Array<{ id?: string; geometry: GeoJSON.Geometry; properties: Record<string, unknown> }>;
  [key: string]: unknown;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /wildfires", () => {
  it("refuses a view below zoom 7: hotspots there load as density cells", async () => {
    const getFirePixels = vi.fn<HazardsProvider["getFirePixels"]>(async () => ({ pixels: [] }));
    const sent = await call("/wildfires", [provider({ getFirePixels })], { ...VIEW, zoom: "6" });
    expect(sent.status).toBe(400);
    expect(getFirePixels).not.toHaveBeenCalled();
  });

  it("reads the detections of the rolling day range in the padded view", async () => {
    const getFirePixels = vi.fn<HazardsProvider["getFirePixels"]>(async () => ({
      pixels: [pixel()],
    }));
    const sent = await call("/wildfires", [provider({ getFirePixels })], {
      ...VIEW,
      zoom: "8",
      dayRange: "1",
    });

    expect(getFirePixels).toHaveBeenCalledWith([-121.1, 37.4, -119.9, 38.6], {
      since: "2026-10-08T12:00:00.000Z",
      instrument: "viirs",
      limit: 20_000,
    });
    expect(sent.status).toBe(200);
    expect(sent.headers).toMatchObject({
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "X-OpenMapX-Fetched-At": NOW,
      "X-OpenMapX-Stale": "false",
      "X-OpenMapX-Truncated": "false",
      "X-OpenMapX-Sources": "nasa-firms-viirs-fires",
    });
    expect(sent.body).toEqual({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "N20:38.1234,-120.4567:2026-10-09T0930",
          geometry: { type: "Point", coordinates: [-120.4567, 38.1234] },
          properties: {
            latitude: 38.1234,
            longitude: -120.4567,
            brightness: 331.2,
            frp: 12.5,
            confidence: "nominal",
            satellite: "N20",
            acqDate: "2026-10-09",
            acqTime: "0930",
            dayNight: "D",
            ageMs: 2.5 * 3_600_000,
            instrument: "viirs",
          },
        },
      ],
    });
  });

  it("labels MODIS confidence as a percentage and keeps a detection without optional values", async () => {
    const getFirePixels = vi.fn<HazardsProvider["getFirePixels"]>(async () => ({
      pixels: [
        pixel({
          instrument: "modis",
          confidence: { percent: 20 },
          brightnessK: undefined,
          satellite: undefined,
          dayNight: undefined,
          sources: ["nasa-firms-modis-fires"],
        }),
      ],
    }));
    const sent = await call("/wildfires", [provider({ getFirePixels })], {
      ...VIEW,
      zoom: "7",
      dayRange: "3",
      instrument: "modis",
    });

    expect(getFirePixels.mock.calls[0]?.[1]).toMatchObject({
      since: "2026-10-06T12:00:00.000Z",
      instrument: "modis",
    });
    expect((sent.body as Body).features[0]?.properties).toMatchObject({
      confidence: "20",
      brightness: null,
      satellite: null,
      dayNight: null,
      instrument: "modis",
    });
  });

  it("names only the sources of the detections it serves", async () => {
    const getFirePixels = async () => ({
      pixels: [
        pixel(),
        pixel({
          id: "unreadable",
          observedAt: "not a time",
          sources: ["other-viirs-feed"],
        }),
      ],
    });
    const sent = await call("/wildfires", [provider({ getFirePixels })], { ...VIEW, zoom: "8" });
    expect((sent.body as Body).features).toHaveLength(1);
    expect(sent.headers["X-OpenMapX-Sources"]).toBe("nasa-firms-viirs-fires");
  });

  it("says when the view is only partly read and when a source was unavailable", async () => {
    const truncated = await call(
      "/wildfires",
      [provider({ getFirePixels: async () => ({ pixels: [pixel()], partial: "area" }) })],
      { ...VIEW, zoom: "9" },
    );
    expect(truncated.headers["X-OpenMapX-Truncated"]).toBe("true");

    const stale = await call(
      "/wildfires",
      [
        provider({ getFirePixels: async () => ({ pixels: [pixel()] }) }),
        provider({
          id: "hazards-down",
          getFirePixels: async () => {
            throw new Error("down");
          },
        }),
      ],
      { ...VIEW, zoom: "9" },
    );
    expect(stale.headers["X-OpenMapX-Stale"]).toBe("true");
  });

  it("rejects an unknown day range, an unknown instrument and a malformed view", async () => {
    const view = { ...VIEW, zoom: "8" };
    expect((await call("/wildfires", [provider()], { ...view, dayRange: "4" })).status).toBe(400);
    expect(
      (await call("/wildfires", [provider()], { ...view, instrument: "VIIRS_SNPP_NRT" })).status,
    ).toBe(400);
    expect((await call("/wildfires", [provider()], { ...view, west: "x" })).status).toBe(400);
  });

  it("caches nearby views under one key", async () => {
    const keys: string[] = [];
    const cache = {
      ...createMockIntegrationContext().cache,
      withCache: async <T>(key: string, _ttl: number, fn: () => Promise<T>) => {
        keys.push(key);
        return fn();
      },
    };
    await call("/wildfires", [provider()], { ...VIEW, zoom: "8" }, cache);
    await call(
      "/wildfires",
      [provider()],
      { west: "-120.98765", south: "37.512345", east: "-120.0001", north: "38.4999", zoom: "8" },
      cache,
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("answers 503 when every provider failed", async () => {
    const getFirePixels = async () => {
      throw new Error("upstream down");
    };
    const sent = await call("/wildfires", [provider({ getFirePixels })], { ...VIEW, zoom: "8" });
    expect(sent.status).toBe(503);
  });
});

describe("GET /wildfires/density", () => {
  it("asks for one-degree cells at zoom 4 and serves them as points with their sources", async () => {
    const getFireDensity = vi.fn<HazardsProvider["getFireDensity"]>(async () => ({
      cells: [{ point: [11.25, -0.75], count: 3, frpSumMW: 9.5, frpMaxMW: 6.1 }],
      sources: ["nasa-firms-viirs-fires"],
    }));
    const sent = await call("/wildfires/density", [provider({ getFireDensity })], {
      west: "0",
      south: "-20",
      east: "40",
      north: "20",
      zoom: "4",
      dayRange: "2",
    });

    expect(getFireDensity).toHaveBeenCalledWith([-4, -24, 44, 24], {
      since: "2026-10-07T12:00:00.000Z",
      instrument: "viirs",
      cellDeg: 1,
    });
    expect(sent.status).toBe(200);
    expect(sent.headers["Cache-Control"]).toBe("public, max-age=300, s-maxage=300");
    expect(sent.body).toEqual({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [11.25, -0.75] },
          properties: { count: 3, frpSum: 9.5, frpMax: 6.1 },
        },
      ],
      sources: ["nasa-firms-viirs-fires"],
    });
  });

  it.each([
    ["1", 2],
    ["3", 2],
    ["5", 0.5],
    ["6", 0.25],
  ])("asks at zoom %s for %f-degree cells", async (zoom, cellDeg) => {
    const getFireDensity = vi.fn<HazardsProvider["getFireDensity"]>(async () => ({
      cells: [],
      sources: [],
    }));
    await call("/wildfires/density", [provider({ getFireDensity })], { ...VIEW, zoom });
    expect(getFireDensity.mock.calls[0]?.[1].cellDeg).toBe(cellDeg);
  });

  it("refuses a view too large for its cell size", async () => {
    const sent = await call("/wildfires/density", [provider()], {
      west: "-180",
      south: "-85",
      east: "180",
      north: "85",
      zoom: "6",
    });
    expect(sent.status).toBe(400);
  });

  it("answers 503 when every provider failed", async () => {
    const getFireDensity = async () => {
      throw new Error("upstream down");
    };
    const sent = await call("/wildfires/density", [provider({ getFireDensity })], {
      ...VIEW,
      zoom: "3",
    });
    expect(sent.status).toBe(503);
  });
});

describe("GET /perimeters/nifc", () => {
  it("serves reported perimeters in the view with the source as provider", async () => {
    const getNaturalHazards = vi.fn<HazardsProvider["getNaturalHazards"]>(async () => ({
      hazards: [
        hazard({
          areaHa: 40.468564224,
          containmentPct: 35,
          perimeterAt: "2026-10-09T08:00:00Z",
          discoveredAt: "2026-10-07T21:15:00Z",
          updatedAt: "2026-10-09T09:00:00.000Z",
          region: "US-CA",
          ignitionCause: "human",
        }),
        hazard({ id: "point-only", geometry: { type: "Point", coordinates: [-120.4, 38.1] } }),
      ],
      partial: "area",
    }));
    const sent = await call("/perimeters/nifc", [provider({ getNaturalHazards })], {
      ...VIEW,
      zoom: "8",
    });

    expect(getNaturalHazards).toHaveBeenCalledWith([-121.1, 37.4, -119.9, 38.6], {
      types: ["wildfire"],
      subtypes: ["wildfire_perimeter"],
      simplifyDeg: 0.005,
    });
    expect(sent.headers["Cache-Control"]).toBe("public, max-age=300, s-maxage=300");
    expect(sent.body).toEqual({
      type: "FeatureCollection",
      source: "nifc",
      truncated: true,
      stale: false,
      fetchedAt: NOW,
      sources: ["us-nifc-fires"],
      features: [
        {
          type: "Feature",
          id: "nifc:oc:situation:us-nifc-fires:{ABC-123}",
          geometry: POLYGON,
          properties: {
            id: "nifc:oc:situation:us-nifc-fires:{ABC-123}",
            kind: "reported-perimeter",
            provider: "us-nifc-fires",
            name: "Pine Fire",
            areaAcres: 100,
            observedAt: "2026-10-09T08:00:00.000Z",
            updatedAt: "2026-10-09T09:00:00.000Z",
            discoveredAt: "2026-10-07T21:15:00.000Z",
            containmentPercent: 35,
            region: "US-CA",
            cause: "human",
          },
        },
      ],
    });
  });

  it.each([
    ["3", 0.02],
    ["4", 0.02],
    ["6", 0.01],
    ["8", 0.005],
    ["12", 0.001],
  ])("simplifies perimeters read at zoom %s to %f degrees", async (zoom, simplifyDeg) => {
    const getNaturalHazards = vi.fn<HazardsProvider["getNaturalHazards"]>(async () => ({
      hazards: [],
    }));
    await call("/perimeters/nifc", [provider({ getNaturalHazards })], { ...VIEW, zoom });
    expect(getNaturalHazards.mock.calls[0]?.[1].simplifyDeg).toBe(simplifyDeg);
  });

  it("keys the cache on the simplification, not on the raw zoom", async () => {
    const keys: string[] = [];
    const cache = {
      ...createMockIntegrationContext().cache,
      withCache: async <T>(key: string, _ttl: number, fn: () => Promise<T>) => {
        keys.push(key);
        return fn();
      },
    };
    for (const zoom of ["9", "9.7", "13", "15.25"]) {
      await call("/perimeters/nifc", [provider()], { ...VIEW, zoom }, cache);
    }
    expect(new Set(keys).size).toBe(1);
  });

  it("answers 503 when every provider failed, and 400 for a malformed view", async () => {
    const getNaturalHazards = async () => {
      throw new Error("upstream down");
    };
    const down = await call("/perimeters/nifc", [provider({ getNaturalHazards })], {
      ...VIEW,
      zoom: "5",
    });
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ code: "nifc_unavailable" });
    const bad = await call("/perimeters/nifc", [provider()], { ...VIEW, south: "50" });
    expect(bad.status).toBe(400);
  });
});

describe("GET /burned-areas/effis", () => {
  it("serves satellite-derived burned areas in the view", async () => {
    const getNaturalHazards = vi.fn<HazardsProvider["getNaturalHazards"]>(async () => ({
      hazards: [
        hazard({
          id: "oc:situation:eu-effis-fires:271828",
          subtype: "burned_area",
          name: undefined,
          start: "2026-10-02T00:00:00Z",
          updatedAt: "2026-10-03T06:00:00Z",
          areaHa: 52.4,
          country: "PT",
          region: "Centro",
          locality: "Leiria",
          sources: ["eu-effis-fires"],
        }),
      ],
    }));
    const sent = await call("/burned-areas/effis", [provider({ getNaturalHazards })], {
      ...VIEW,
      zoom: "6",
    });

    expect(getNaturalHazards.mock.calls[0]?.[1]).toEqual({
      types: ["wildfire"],
      subtypes: ["burned_area"],
      simplifyDeg: 0.01,
    });
    expect(sent.headers["Cache-Control"]).toBe("public, max-age=1800, s-maxage=1800");
    const body = sent.body as Body;
    expect(body).toMatchObject({
      source: "effis",
      truncated: false,
      stale: false,
      sources: ["eu-effis-fires"],
    });
    expect(body.features[0]).toMatchObject({
      id: "effis:oc:situation:eu-effis-fires:271828",
      properties: {
        id: "effis:oc:situation:eu-effis-fires:271828",
        kind: "satellite-burned-area",
        provider: "eu-effis-fires",
        detectedAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-03T06:00:00.000Z",
        countryCode: "PT",
        region: "Centro",
        locality: "Leiria",
        areaHectares: 52.4,
      },
    });
  });
});

describe("GET /smoke/noaa", () => {
  it("serves the world's observed smoke with its analysis window", async () => {
    const getNaturalHazards = vi.fn<HazardsProvider["getNaturalHazards"]>(async () => ({
      hazards: [
        hazard({
          id: "oc:situation:us-noaa-hms-smoke:2026282_17",
          type: "smoke",
          subtype: undefined,
          name: undefined,
          density: "medium",
          detection: {
            satellite: "GOES-EAST",
            start: "2026-10-09T13:10:00Z",
            end: "2026-10-09T15:00:00Z",
          },
          sources: ["us-noaa-hms-smoke"],
        }),
        hazard({ id: "no-density", type: "smoke", density: undefined }),
      ],
    }));
    const sent = await call("/smoke/noaa", [provider({ getNaturalHazards })]);

    expect(getNaturalHazards).toHaveBeenCalledWith([-180, -90, 180, 90], { types: ["smoke"] });
    expect(sent.headers["Cache-Control"]).toBe("public, max-age=600, s-maxage=600");
    const body = sent.body as Body;
    expect(body).toMatchObject({ source: "noaa-hms", sources: ["us-noaa-hms-smoke"] });
    expect(body.features).toEqual([
      {
        type: "Feature",
        id: "noaa-hms:oc:situation:us-noaa-hms-smoke:2026282_17",
        geometry: POLYGON,
        properties: {
          id: "noaa-hms:oc:situation:us-noaa-hms-smoke:2026282_17",
          kind: "observed-smoke",
          provider: "us-noaa-hms-smoke",
          density: "medium",
          satellite: "GOES-EAST",
          startedAt: "2026-10-09T13:10:00.000Z",
          endedAt: "2026-10-09T15:00:00.000Z",
        },
      },
    ]);
  });

  it("answers 503 when every provider failed", async () => {
    const getNaturalHazards = async () => {
      throw new Error("upstream down");
    };
    const sent = await call("/smoke/noaa", [provider({ getNaturalHazards })]);
    expect(sent.status).toBe(503);
    expect(sent.body).toEqual({ code: "noaa_hms_unavailable" });
  });
});
