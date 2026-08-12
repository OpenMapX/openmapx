import type { IntegrationContext } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEffisUrl, EffisSourceError, loadEffis, normalizeEffisFeature } from "./effis.js";
import type { NormalizedViewport } from "./types.js";

const BOUNDS: NormalizedViewport = {
  west: -10,
  south: 35,
  east: 30,
  north: 60,
  zoom: 6,
};

const POLYGON = {
  type: "Polygon" as const,
  coordinates: [
    [
      [10, 45],
      [11, 45],
      [11, 46],
      [10, 45],
    ],
  ],
};

function effisFeature(
  properties: Record<string, unknown>,
  geometry = POLYGON,
  topLevelId: string | number | undefined = properties.ID as string | number | undefined,
) {
  return {
    type: "Feature" as const,
    ...(topLevelId === undefined ? {} : { id: topLevelId }),
    properties,
    geometry,
  };
}

function createContext() {
  return {
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as IntegrationContext;
}

describe("buildEffisUrl", () => {
  it("pins the weekly MODIS burned-area WFS query to the viewport", () => {
    const url = new URL(buildEffisUrl(BOUNDS));

    expect(url.searchParams.get("service")).toBe("WFS");
    expect(url.searchParams.get("version")).toBe("1.1.0");
    expect(url.searchParams.get("request")).toBe("GetFeature");
    expect(url.searchParams.get("typename")).toBe("ms:modis.ba.poly.week");
    expect(url.searchParams.get("outputformat")).toBe("geojson");
    expect(url.searchParams.get("bbox")).toBe("35,-10,60,30,EPSG:4326");
    expect(url.searchParams.get("maxfeatures")).toBe("2001");
  });

  it("uses the EFFIS WFS 1.1 latitude-longitude axis order from the live contract", () => {
    const url = new URL(buildEffisUrl({ west: 19, south: 35, east: 29, north: 43, zoom: 6 }));

    expect(url.searchParams.get("bbox")).toBe("35,19,43,29,EPSG:4326");
  });
});

describe("normalizeEffisFeature", () => {
  it("normalizes a representative live EFFIS feature without a top-level id", () => {
    const result = normalizeEffisFeature(
      effisFeature(
        {
          id: "weekly-42",
          AREA_HA: " 123.5 ",
          FIREDATE: "2026-08-10 11:30:00",
          LASTUPDATE: "2026-08-11 12:45:00.123456",
          COUNTRY: " ES ",
          PROVINCE: " Galicia ",
          COMMUNE: " N.A. ",
          CLASS: " MODIS ",
        },
        POLYGON,
        undefined,
      ),
    );

    expect(result).toMatchObject({
      type: "Feature",
      id: "effis:weekly-42",
      geometry: POLYGON,
      properties: {
        id: "effis:weekly-42",
        kind: "satellite-burned-area",
        provider: "effis",
        areaHectares: 123.5,
        detectedAt: "2026-08-10T11:30:00.000Z",
        updatedAt: "2026-08-11T12:45:00.123Z",
        countryCode: "ES",
        region: "Galicia",
        sourceClass: "MODIS",
      },
    });
    expect(result?.properties.locality).toBeUndefined();
  });

  it.each([
    { type: "Point", coordinates: [10, 45] },
    { type: "Polygon", coordinates: [] },
    {
      type: "Polygon",
      coordinates: [
        [
          [10, 45],
          [11, 45],
          [11, 46],
          [10, 46],
        ],
      ],
    },
    {
      type: "Polygon",
      coordinates: [
        [
          [181, 45],
          [11, 45],
          [11, 46],
          [181, 45],
        ],
      ],
    },
  ])("rejects invalid burned-area geometry: %j", (geometry) => {
    expect(
      normalizeEffisFeature(effisFeature({ ID: 1, AREA_HA: "1" }, geometry as never)),
    ).toBeNull();
  });

  it.each([undefined, null, "", "not a number", Number.POSITIVE_INFINITY])(
    "rejects an invalid AREA_HA value: %j",
    (area) => {
      expect(normalizeEffisFeature(effisFeature({ ID: 1, AREA_HA: area }))).toBeNull();
    },
  );

  it("accepts a valid multipolygon", () => {
    expect(
      normalizeEffisFeature(
        effisFeature(
          { ID: 1, AREA_HA: 1 },
          { type: "MultiPolygon", coordinates: [POLYGON.coordinates] },
        ),
      ),
    ).not.toBeNull();
  });
});

describe("loadEffis", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requests GeoJSON and returns a valid empty upstream collection", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ type: "FeatureCollection", features: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadEffis(createContext(), BOUNDS);

    expect(result).toEqual({
      type: "FeatureCollection",
      features: [],
      source: "effis",
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Accept: "application/geo+json, application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects upstream failures instead of treating them as an empty collection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    await expect(loadEffis(createContext(), BOUNDS)).rejects.toThrow(EffisSourceError);
    await expect(loadEffis(createContext(), BOUNDS)).rejects.toThrow("EFFIS API returned 503");
  });

  it("rejects OGC XML exceptions returned with HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            '<?xml version="1.0"?><ServiceExceptionReport><ServiceException>invalid layer</ServiceException></ServiceExceptionReport>',
            { headers: { "content-type": "application/xml" } },
          ),
      ),
    );

    await expect(loadEffis(createContext(), BOUNDS)).rejects.toThrow(EffisSourceError);
    await expect(loadEffis(createContext(), BOUNDS)).rejects.toThrow(
      "Invalid EFFIS upstream response",
    );
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
            headers: new Headers(),
            text: () =>
              new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(cause));
              }),
          }) as Response,
      ),
    );

    const pending = loadEffis(createContext(), BOUNDS);
    const rejection = expect(pending).rejects.toMatchObject({
      provider: "effis",
      kind: "timeout",
      cause,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
  });

  it("splits wrapped viewports, deduplicates feature ids, and caps the merged result", async () => {
    const wrapped: NormalizedViewport = { west: 170, south: 10, east: -170, north: 20, zoom: 6 };
    const first = Array.from({ length: 2_001 }, (_, index) =>
      effisFeature({ ID: index + 1, AREA_HA: 1 }),
    );
    const second = [effisFeature({ ID: 1, AREA_HA: 1 }), effisFeature({ ID: 2_002, AREA_HA: 1 })];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ type: "FeatureCollection", features: first })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ type: "FeatureCollection", features: second })),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadEffis(createContext(), wrapped);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.features).toHaveLength(2_000);
    expect(result.features[0].id).toBe("effis:1");
    expect(result.truncated).toBe(true);
    expect(result).not.toHaveProperty("fetchedAt");
    expect(result).not.toHaveProperty("stale");
  });

  it("reports truncation when an upstream segment reaches the request cap before normalization", async () => {
    const invalidAtCap = [
      effisFeature(
        { id: "invalid", AREA_HA: "1" },
        { type: "Point", coordinates: [10, 45] },
        undefined,
      ),
      ...Array.from({ length: 2_000 }, () =>
        effisFeature({ id: "duplicate", AREA_HA: "1" }, POLYGON, undefined),
      ),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ type: "FeatureCollection", features: invalidAtCap })),
      ),
    );

    const result = await loadEffis(createContext(), BOUNDS);

    expect(result.features).toHaveLength(1);
    expect(result.features[0].id).toBe("effis:duplicate");
    expect(result.truncated).toBe(true);
  });
});
