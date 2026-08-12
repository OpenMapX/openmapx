import type { IntegrationContext } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNifcUrl, loadNifc, normalizeNifcFeature } from "./nifc.js";
import { type NormalizedViewport, WildfireSourceError } from "./types.js";

const BOUNDS: NormalizedViewport = {
  west: -125,
  south: 32,
  east: -110,
  north: 49,
  zoom: 7,
};

const POLYGON = {
  type: "Polygon" as const,
  coordinates: [
    [
      [-120, 35],
      [-119, 35],
      [-119, 36],
      [-120, 35],
    ],
  ],
};

function nifcFeature(properties: Record<string, unknown>, geometry = POLYGON) {
  return {
    type: "Feature" as const,
    id: properties.OBJECTID as string | number,
    properties,
    geometry,
  };
}

function createContext() {
  return {
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as IntegrationContext;
}

describe("buildNifcUrl", () => {
  it("builds the NIFC query with the WF filter, requested fields, and zoom offset", () => {
    const url = new URL(buildNifcUrl(BOUNDS));

    expect(url.searchParams.get("where")).toBe("attr_IncidentTypeCategory='WF'");
    expect(url.searchParams.get("geometry")).toBe("-125,32,-110,49");
    expect(url.searchParams.get("geometryType")).toBe("esriGeometryEnvelope");
    expect(url.searchParams.get("spatialRel")).toBe("esriSpatialRelIntersects");
    expect(url.searchParams.get("outSR")).toBe("4326");
    expect(url.searchParams.get("f")).toBe("geojson");
    expect(url.searchParams.get("maxAllowableOffset")).toBe("0.005");
    expect(url.searchParams.get("geometryPrecision")).toBe("5");
    expect(url.searchParams.get("returnGeometry")).toBe("true");
    expect(url.searchParams.get("outFields")).toBe(
      [
        "OBJECTID",
        "poly_IncidentName",
        "poly_GISAcres",
        "poly_DateCurrent",
        "poly_PolygonDateTime",
        "attr_IncidentName",
        "attr_IncidentSize",
        "attr_PercentContained",
        "attr_FireDiscoveryDateTime",
        "attr_ModifiedOnDateTime_dt",
        "attr_POOState",
        "attr_FireCause",
        "attr_IncidentTypeCategory",
      ].join(","),
    );
  });
});

describe("normalizeNifcFeature", () => {
  it("normalizes names, area, update fallback, dates, and stable ids", () => {
    const result = normalizeNifcFeature(
      nifcFeature({
        OBJECTID: 42,
        attr_IncidentName: "Canyon Fire",
        attr_IncidentSize: 1234.5,
        poly_PolygonDateTime: Date.parse("2026-08-11T10:00:00Z"),
        attr_FireDiscoveryDateTime: Date.parse("2026-08-10T10:00:00Z"),
        attr_ModifiedOnDateTime_dt: Date.parse("2026-08-12T10:00:00Z"),
        attr_PercentContained: 25,
        attr_POOState: "CA",
        attr_FireCause: "Lightning",
        attr_IncidentTypeCategory: "WF",
      }),
    );

    expect(result).toMatchObject({
      type: "Feature",
      id: "nifc:42",
      geometry: POLYGON,
      properties: {
        id: "nifc:42",
        kind: "reported-perimeter",
        provider: "nifc",
        coverage: "United States",
        name: "Canyon Fire",
        areaAcres: 1234.5,
        observedAt: "2026-08-11T10:00:00.000Z",
        updatedAt: "2026-08-12T10:00:00.000Z",
        discoveredAt: "2026-08-10T10:00:00.000Z",
        containmentPercent: 25,
        region: "CA",
        cause: "Lightning",
      },
    });
  });

  it("uses polygon fields before attribute fallbacks", () => {
    const result = normalizeNifcFeature(
      nifcFeature({
        OBJECTID: "7",
        poly_IncidentName: "Perimeter Name",
        attr_IncidentName: "Attribute Name",
        poly_GISAcres: 99,
        attr_IncidentSize: 12,
        poly_DateCurrent: Date.parse("2026-08-12T01:00:00Z"),
        attr_ModifiedOnDateTime_dt: Date.parse("2026-08-11T01:00:00Z"),
        attr_IncidentTypeCategory: "WF",
      }),
    );

    expect(result?.properties).toMatchObject({
      name: "Perimeter Name",
      areaAcres: 99,
      updatedAt: "2026-08-12T01:00:00.000Z",
    });
  });

  it.each(["Polygon", "MultiPolygon"])("accepts %s geometry", (type) => {
    const geometry =
      type === "Polygon"
        ? POLYGON
        : { type: "MultiPolygon" as const, coordinates: [POLYGON.coordinates] };
    expect(
      normalizeNifcFeature(
        nifcFeature(
          { OBJECTID: 1, attr_IncidentName: "Fire", attr_IncidentTypeCategory: "WF" },
          geometry,
        ),
      ),
    ).not.toBeNull();
  });

  it("retains valid polygon holes and multipolygon members", () => {
    const polygonWithHole = {
      type: "Polygon" as const,
      coordinates: [
        [
          [-120, 35],
          [-119, 35],
          [-119, 36],
          [-120, 35],
        ],
        [
          [-119.8, 35.2],
          [-119.4, 35.2],
          [-119.4, 35.6],
          [-119.8, 35.2],
        ],
      ],
    };
    const multipolygon = {
      type: "MultiPolygon" as const,
      coordinates: [
        POLYGON.coordinates,
        [
          [
            [-118, 34],
            [-117, 34],
            [-117, 35],
            [-118, 34],
          ],
        ],
      ],
    };

    expect(
      normalizeNifcFeature(
        nifcFeature(
          { OBJECTID: 2, attr_IncidentName: "Hole", attr_IncidentTypeCategory: "WF" },
          polygonWithHole,
        ),
      )?.geometry,
    ).toEqual(polygonWithHole);
    expect(
      normalizeNifcFeature(
        nifcFeature(
          { OBJECTID: 3, attr_IncidentName: "Multi", attr_IncidentTypeCategory: "WF" },
          multipolygon,
        ),
      )?.geometry,
    ).toEqual(multipolygon);
  });

  it.each([
    { type: "Polygon", coordinates: [[POLYGON.coordinates]] },
    { type: "MultiPolygon", coordinates: [POLYGON.coordinates[0]] },
  ])("rejects finite geometry with invalid type nesting: %j", (geometry) => {
    expect(
      normalizeNifcFeature(
        nifcFeature(
          { OBJECTID: 4, attr_IncidentName: "Bad nesting", attr_IncidentTypeCategory: "WF" },
          geometry as never,
        ),
      ),
    ).toBeNull();
  });

  it.each([
    [
      [
        [-120, 35],
        [-119, 35],
        [-120, 35],
      ],
    ],
    [
      [
        [-120, 35],
        [-119, 35],
        [-119, 36],
        [-120, 36],
      ],
    ],
  ])("rejects too-short or unclosed linear rings: %j", (ring) => {
    expect(
      normalizeNifcFeature(
        nifcFeature(
          { OBJECTID: 5, attr_IncidentName: "Bad ring", attr_IncidentTypeCategory: "WF" },
          { type: "Polygon", coordinates: [ring] } as never,
        ),
      ),
    ).toBeNull();
  });

  it.each([[[-181, 35]], [[-120, 91]], [[Number.NaN, 35]], [[-120, Number.POSITIVE_INFINITY]]])(
    "rejects out-of-range or non-finite positions: %j",
    (position) => {
      expect(
        normalizeNifcFeature(
          nifcFeature(
            { OBJECTID: 6, attr_IncidentName: "Bad position", attr_IncidentTypeCategory: "WF" },
            {
              type: "Polygon",
              coordinates: [[position, [-119, 35], [-119, 36], position]],
            } as never,
          ),
        ),
      ).toBeNull();
    },
  );

  it.each([
    [180, 0],
    [-180, 0],
    [0, 90],
    [0, -90],
  ])("accepts valid 4326 boundary position [%i, %i]", (longitude, latitude) => {
    const position = [longitude, latitude];
    const geometry = {
      type: "Polygon" as const,
      coordinates: [[position, [0, 0], [longitude, 0], position]],
    };
    expect(
      normalizeNifcFeature(
        nifcFeature(
          { OBJECTID: 7, attr_IncidentName: "Boundary", attr_IncidentTypeCategory: "WF" },
          geometry,
        ),
      ),
    ).not.toBeNull();
  });

  it.each([null, { type: "Point", coordinates: [-120, 35] }, { type: "Polygon", coordinates: [] }])(
    "rejects invalid geometry %j",
    (geometry) => {
      expect(
        normalizeNifcFeature(
          nifcFeature(
            { OBJECTID: 1, attr_IncidentName: "Fire", attr_IncidentTypeCategory: "WF" },
            geometry as never,
          ),
        ),
      ).toBeNull();
    },
  );

  it("omits null numeric values and containment outside 0..100", () => {
    const result = normalizeNifcFeature(
      nifcFeature({
        OBJECTID: 1,
        attr_IncidentName: "Fire",
        poly_GISAcres: null,
        attr_IncidentSize: null,
        attr_PercentContained: 101,
        attr_IncidentTypeCategory: "WF",
      }),
    );

    expect(result?.properties).not.toHaveProperty("areaAcres");
    expect(result?.properties).not.toHaveProperty("containmentPercent");
  });

  it.each(["RX", "CX"])("defensively rejects %s incidents", (category) => {
    expect(
      normalizeNifcFeature(
        nifcFeature({
          OBJECTID: 1,
          attr_IncidentName: "Fire",
          attr_IncidentTypeCategory: category,
        }),
      ),
    ).toBeNull();
  });
});

describe("loadNifc", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("merges two antimeridian requests and deduplicates normalized ids", async () => {
    const bounds = { ...BOUNDS, west: 170, east: -170 };
    const responses = [
      {
        type: "FeatureCollection",
        features: [
          nifcFeature({ OBJECTID: 1, attr_IncidentName: "First", attr_IncidentTypeCategory: "WF" }),
        ],
      },
      {
        type: "FeatureCollection",
        features: [
          nifcFeature({
            OBJECTID: 1,
            attr_IncidentName: "Duplicate",
            attr_IncidentTypeCategory: "WF",
          }),
          nifcFeature({
            OBJECTID: 2,
            attr_IncidentName: "Second",
            attr_IncidentTypeCategory: "WF",
          }),
        ],
      },
    ];
    let responseIndex = 0;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responses[responseIndex++])));
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadNifc(createContext(), bounds);
    expect(result.source).toBe("nifc");
    expect(result.truncated).toBe(false);
    expect(result.features).toHaveLength(2);
    expect(result.features.map((feature) => feature.id)).toEqual(["nifc:1", "nifc:2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("times out an upstream fetch and clears its timer", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );

    const pending = loadNifc(createContext(), BOUNDS);
    const rejection = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("classifies an abort while reading the response body as a timeout", async () => {
    vi.useFakeTimers();
    const cause = new DOMException("Aborted", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          ({
            ok: true,
            status: 200,
            json: () =>
              new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(cause));
              }),
          }) as Response,
      ),
    );

    const pending = loadNifc(createContext(), BOUNDS);
    const rejection = expect(pending).rejects.toMatchObject({
      provider: "nifc",
      kind: "timeout",
      cause,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
  });

  it("rejects non-2xx, malformed JSON, and invalid feature collections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 502 })),
    );
    await expect(loadNifc(createContext(), BOUNDS)).rejects.toThrow("NIFC API returned 502");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json")),
    );
    await expect(loadNifc(createContext(), BOUNDS)).rejects.toThrow();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ type: "FeatureCollection" }))),
    );
    await expect(loadNifc(createContext(), BOUNDS)).rejects.toThrow(
      "Invalid NIFC FeatureCollection",
    );
  });

  it("classifies a known upstream status with provider metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    await expect(loadNifc(createContext(), BOUNDS)).rejects.toBeInstanceOf(WildfireSourceError);
    await expect(loadNifc(createContext(), BOUNDS)).rejects.toMatchObject({
      provider: "nifc",
      kind: "upstream-status",
      upstreamStatus: 503,
    });
  });

  it("caps normalized features at 2,000 and reports truncation", async () => {
    const features = Array.from({ length: 2_001 }, (_, i) =>
      nifcFeature({
        OBJECTID: i + 1,
        attr_IncidentName: `Fire ${i + 1}`,
        attr_IncidentTypeCategory: "WF",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ type: "FeatureCollection", features }))),
    );

    const result = await loadNifc(createContext(), BOUNDS);
    expect(result.features).toHaveLength(2_000);
    expect(result.truncated).toBe(true);
  });
});
