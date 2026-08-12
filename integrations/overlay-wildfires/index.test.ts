import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csvToGeoJSON, parseAcqDateTime } from "./firms.js";
import { setup } from "./index.js";
import { WildfireSourceError } from "./types.js";

describe("parseAcqDateTime", () => {
  it("pads HHMM time and parses as UTC epoch ms", () => {
    // "0945" -> 09:45 UTC on 2026-03-10
    expect(parseAcqDateTime("2026-03-10", "0945")).toBe(Date.parse("2026-03-10T09:45:00Z"));
  });

  it("left-pads a short time string before splitting", () => {
    // "45" -> "0045" -> 00:45 UTC
    expect(parseAcqDateTime("2026-03-10", "45")).toBe(Date.parse("2026-03-10T00:45:00Z"));
  });
});

const VIIRS_HEADER =
  "latitude,longitude,bright_ti4,acq_date,acq_time,satellite,confidence,frp,daynight";
const MODIS_HEADER =
  "latitude,longitude,brightness,acq_date,acq_time,satellite,confidence,frp,daynight";

describe("csvToGeoJSON", () => {
  const NOW = Date.parse("2026-03-10T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty collection for header-only or blank CSV", () => {
    expect(csvToGeoJSON("", "VIIRS_SNPP_NRT")).toEqual({
      type: "FeatureCollection",
      features: [],
    });
    expect(csvToGeoJSON(VIIRS_HEADER, "VIIRS_SNPP_NRT").features).toEqual([]);
  });

  it("emits a [lng, lat] Point and maps bright_ti4 to brightness for VIIRS", () => {
    const csv = `${VIIRS_HEADER}\n37.5,-122.3,310.4,2026-03-10,1130,N,nominal,12.5,D`;

    const fc = csvToGeoJSON(csv, "VIIRS_SNPP_NRT");

    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    // GeoJSON order is [lng, lat] even though the CSV columns are lat,lng.
    expect(f.geometry.coordinates).toEqual([-122.3, 37.5]);
    expect(f.properties).toMatchObject({
      latitude: 37.5,
      longitude: -122.3,
      brightness: 310.4,
      frp: 12.5,
      confidence: "nominal",
      satellite: "N",
      acqDate: "2026-03-10",
      acqTime: "1130",
      dayNight: "D",
      source: "VIIRS_SNPP_NRT",
    });
    expect(f.properties.ageMs).toBe(NOW - Date.parse("2026-03-10T11:30:00Z"));
  });

  it("drops low-confidence VIIRS detections (low / l) but keeps nominal", () => {
    const csv = [
      VIIRS_HEADER,
      "1,1,300,2026-03-10,1100,N,low,5,D",
      "2,2,300,2026-03-10,1100,N,l,5,D",
      "3,3,300,2026-03-10,1100,N,nominal,5,D",
      "4,4,300,2026-03-10,1100,N,high,5,D",
    ].join("\n");

    const fc = csvToGeoJSON(csv, "VIIRS_SNPP_NRT");

    expect(fc.features.map((f) => f.properties.confidence)).toEqual(["nominal", "high"]);
  });

  it("drops MODIS detections with numeric confidence below 50", () => {
    const csv = [
      MODIS_HEADER,
      "1,1,330,2026-03-10,1100,T,30,8,D",
      "2,2,330,2026-03-10,1100,T,49,8,D",
      "3,3,330,2026-03-10,1100,T,50,8,D",
      "4,4,330,2026-03-10,1100,T,80,8,D",
    ].join("\n");

    const fc = csvToGeoJSON(csv, "MODIS_NRT");

    expect(fc.features.map((f) => f.properties.confidence)).toEqual(["50", "80"]);
    expect(fc.features[0].properties.brightness).toBe(330);
  });

  it("skips rows with non-numeric coordinates or too few columns", () => {
    const csv = [
      VIIRS_HEADER,
      "abc,-122,300,2026-03-10,1100,N,nominal,5,D",
      "37.5,-122.3,310,2026-03-10,1130,N,nominal,12,D",
      "1,2,300", // short row
    ].join("\n");

    const fc = csvToGeoJSON(csv, "VIIRS_SNPP_NRT");

    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.coordinates).toEqual([-122.3, 37.5]);
  });

  it("defaults frp and brightness to 0 when the cell is empty or non-numeric", () => {
    const csv = `${VIIRS_HEADER}\n10,20,,2026-03-10,1100,N,nominal,,D`;

    const fc = csvToGeoJSON(csv, "VIIRS_SNPP_NRT");

    expect(fc.features[0].properties.frp).toBe(0);
    expect(fc.features[0].properties.brightness).toBe(0);
  });
});

const VALID_VIEWPORT = {
  west: "-123",
  south: "37",
  east: "-122",
  north: "38",
  zoom: "10",
};

function response(status: number, body: unknown, contentType = "application/json"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": contentType }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function validNifcCollection() {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: 42,
        properties: {
          attr_IncidentName: "Test Fire",
          attr_IncidentTypeCategory: "WF",
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-123, 37],
              [-122, 37],
              [-122, 38],
              [-123, 37],
            ],
          ],
        },
      },
    ],
  };
}

function validEffisCollection() {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "42",
        properties: { AREA_HA: "12.5" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-123, 37],
              [-122, 37],
              [-122, 38],
              [-123, 37],
            ],
          ],
        },
      },
    ],
  };
}

function replyFake() {
  let body: unknown;
  let statusCode = 200;
  const headers = new Map<string, string>();
  const send = (data: unknown) => {
    body = data;
  };

  return {
    reply: {
      send,
      status: (code: number) => {
        statusCode = code;
        return { send };
      },
      header: (name: string, value: string) => {
        headers.set(name, value);
      },
      type: () => {},
    },
    result: () => ({ body, statusCode, headers }),
  };
}

function routeHandler(ctx: ReturnType<typeof createMockIntegrationContext>, path: string) {
  const registration = ctx.registered.routes.find((route) => route.path === path);
  if (!registration) throw new Error(`Route ${path} was not registered`);
  return registration.handler;
}

function recordingCache() {
  const writes: Array<{ key: string; ttl: number }> = [];
  return {
    cache: {
      get: async () => null,
      set: async (key: string, _value: unknown, ttl: number) => {
        writes.push({ key, ttl });
      },
      del: async () => undefined,
      withCache: async <_T>(_key: string, _ttl: number, load: () => Promise<_T>) => load(),
    },
    writes,
  };
}

describe("wildfire source routes", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers FIRMS and each independent source route as GET", () => {
    const ctx = createMockIntegrationContext();

    setup(ctx);

    expect(ctx.registered.routes.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/wildfires" },
      { method: "GET", path: "/perimeters/nifc" },
      { method: "GET", path: "/burned-areas/effis" },
      { method: "GET", path: "/smoke/noaa" },
    ]);
  });

  it("rejects an invalid NIFC viewport before fetching upstream", async () => {
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const result = replyFake();

    await routeHandler(ctx, "/perimeters/nifc")(
      {
        query: { ...VALID_VIEWPORT, north: "not-a-number" },
        params: {},
        body: undefined,
        headers: {},
      },
      result.reply,
    );

    expect(result.result()).toMatchObject({ statusCode: 400 });
    expect(result.result().headers.get("Cache-Control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a fresh NIFC envelope with its cache policy", async () => {
    fetchMock.mockResolvedValueOnce(response(200, validNifcCollection()));
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const result = replyFake();

    await routeHandler(ctx, "/perimeters/nifc")(
      { query: VALID_VIEWPORT, params: {}, body: undefined, headers: {} },
      result.reply,
    );

    expect(result.result()).toMatchObject({
      statusCode: 200,
      body: {
        source: "nifc",
        fetchedAt: "2026-08-12T12:00:00.000Z",
        stale: false,
        truncated: false,
      },
    });
    expect(result.result().headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=300");
  });

  it("returns a fresh EFFIS envelope with its cache policy", async () => {
    fetchMock.mockResolvedValueOnce(response(200, validEffisCollection()));
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const result = replyFake();

    await routeHandler(ctx, "/burned-areas/effis")(
      { query: VALID_VIEWPORT, params: {}, body: undefined, headers: {} },
      result.reply,
    );

    expect(result.result()).toMatchObject({
      statusCode: 200,
      body: {
        source: "effis",
        fetchedAt: "2026-08-12T12:00:00.000Z",
        stale: false,
        truncated: false,
      },
    });
    expect(result.result().headers.get("Cache-Control")).toBe(
      "public, max-age=1800, s-maxage=1800",
    );
  });

  it.each([
    {
      path: "/perimeters/nifc",
      payload: validNifcCollection(),
      query: VALID_VIEWPORT,
      cacheKey: "wildfires:nifc:-123.1:36.9:-121.9:38.1:offset:0.001",
      freshTtl: 300,
      staleTtl: 86_400,
    },
    {
      path: "/burned-areas/effis",
      payload: validEffisCollection(),
      query: VALID_VIEWPORT,
      cacheKey: "wildfires:effis:-123.1:36.9:-121.9:38.1",
      freshTtl: 1_800,
      staleTtl: 172_800,
    },
    {
      path: "/smoke/noaa",
      payload: { type: "FeatureCollection", features: [] },
      query: {},
      cacheKey: "wildfires:noaa-hms",
      freshTtl: 600,
      staleTtl: 86_400,
    },
  ])(
    "uses the exact cache key and TTLs for $path",
    async ({ path, payload, query, cacheKey, freshTtl, staleTtl }) => {
      fetchMock.mockResolvedValueOnce(response(200, payload));
      const recorder = recordingCache();
      const ctx = createMockIntegrationContext({ cache: recorder.cache });
      setup(ctx);
      const result = replyFake();

      await routeHandler(ctx, path)(
        { query, params: {}, body: undefined, headers: {} },
        result.reply,
      );

      expect(recorder.writes).toEqual([
        { key: `${cacheKey}:fresh`, ttl: freshTtl },
        { key: `${cacheKey}:stale`, ttl: staleTtl },
      ]);
    },
  );

  it("returns a fresh NOAA envelope with its 600-second cache policy", async () => {
    fetchMock.mockResolvedValueOnce(response(200, { type: "FeatureCollection", features: [] }));
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const result = replyFake();

    await routeHandler(ctx, "/smoke/noaa")(
      { query: {}, params: {}, body: undefined, headers: {} },
      result.reply,
    );

    expect(result.result()).toMatchObject({
      statusCode: 200,
      body: { source: "noaa-hms", stale: false },
    });
    expect(result.result().headers.get("Cache-Control")).toBe("public, max-age=600, s-maxage=600");
  });

  it("serves stale NIFC data with its original fetched time", async () => {
    fetchMock.mockRejectedValueOnce(new Error("NIFC API returned 502"));
    const ctx = createMockIntegrationContext({
      cache: {
        get: async (key) =>
          key.endsWith(":stale")
            ? {
                value: {
                  type: "FeatureCollection",
                  features: [],
                  source: "nifc",
                  truncated: false,
                },
                fetchedAt: "2026-08-12T11:00:00.000Z",
              }
            : null,
        set: async () => undefined,
        del: async () => undefined,
        withCache: async <_T>(_key, _ttl, load) => load(),
      },
    });
    setup(ctx);
    const result = replyFake();

    await routeHandler(ctx, "/perimeters/nifc")(
      { query: VALID_VIEWPORT, params: {}, body: undefined, headers: {} },
      result.reply,
    );

    expect(result.result()).toMatchObject({
      statusCode: 200,
      body: { fetchedAt: "2026-08-12T11:00:00.000Z", stale: true },
    });
    expect(result.result().headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=300");
  });

  it("rethrows a lookalike programmer error instead of serving stale NIFC data", async () => {
    const payload = {
      type: "FeatureCollection",
      get features(): never {
        throw new Error("NIFC API returned 503 while formatting a response");
      },
    };
    fetchMock.mockResolvedValueOnce(response(200, payload));
    const ctx = createMockIntegrationContext({
      cache: {
        get: async (key) =>
          key.endsWith(":stale")
            ? {
                value: {
                  type: "FeatureCollection",
                  features: [],
                  source: "nifc",
                  truncated: false,
                },
                fetchedAt: "2026-08-12T11:00:00.000Z",
              }
            : null,
        set: async () => undefined,
        del: async () => undefined,
        withCache: async <_T>(_key, _ttl, load) => load(),
      },
    });
    setup(ctx);
    const result = replyFake();

    await expect(
      routeHandler(ctx, "/perimeters/nifc")(
        { query: VALID_VIEWPORT, params: {}, body: undefined, headers: {} },
        result.reply,
      ),
    ).rejects.toThrow("NIFC API returned 503 while formatting a response");
  });

  it("rethrows a different provider's typed failure instead of serving stale NIFC data", async () => {
    const payload = {
      type: "FeatureCollection",
      get features(): never {
        throw new WildfireSourceError("EFFIS API returned 503", {
          provider: "effis",
          kind: "upstream-status",
          upstreamStatus: 503,
        });
      },
    };
    fetchMock.mockResolvedValueOnce(response(200, payload));
    const ctx = createMockIntegrationContext({
      cache: {
        get: async (key) =>
          key.endsWith(":stale")
            ? {
                value: {
                  type: "FeatureCollection",
                  features: [],
                  source: "nifc",
                  truncated: false,
                },
                fetchedAt: "2026-08-12T11:00:00.000Z",
              }
            : null,
        set: async () => undefined,
        del: async () => undefined,
        withCache: async <_T>(_key, _ttl, load) => load(),
      },
    });
    setup(ctx);
    const result = replyFake();

    await expect(
      routeHandler(ctx, "/perimeters/nifc")(
        { query: VALID_VIEWPORT, params: {}, body: undefined, headers: {} },
        result.reply,
      ),
    ).rejects.toMatchObject({ provider: "effis", kind: "upstream-status" });
  });

  it("serves stale NOAA data with its fresh cache policy", async () => {
    fetchMock.mockRejectedValueOnce(new Error("upstream connection closed"));
    const ctx = createMockIntegrationContext({
      cache: {
        get: async (key) =>
          key.endsWith(":stale")
            ? {
                value: {
                  type: "FeatureCollection",
                  features: [],
                  source: "noaa-hms",
                  truncated: false,
                },
                fetchedAt: "2026-08-12T11:00:00.000Z",
              }
            : null,
        set: async () => undefined,
        del: async () => undefined,
        withCache: async <_T>(_key, _ttl, load) => load(),
      },
    });
    setup(ctx);
    const result = replyFake();

    await routeHandler(ctx, "/smoke/noaa")(
      { query: {}, params: {}, body: undefined, headers: {} },
      result.reply,
    );

    expect(result.result()).toMatchObject({
      statusCode: 200,
      body: { fetchedAt: "2026-08-12T11:00:00.000Z", stale: true },
    });
    expect(result.result().headers.get("Cache-Control")).toBe("public, max-age=600, s-maxage=600");
  });

  it.each([
    ["/perimeters/nifc", "nifc_unavailable"],
    ["/burned-areas/effis", "effis_unavailable"],
    ["/smoke/noaa", "noaa_hms_unavailable"],
  ])("returns a no-store 503 when %s is unavailable", async (path, code) => {
    fetchMock.mockResolvedValueOnce(response(503, { error: "upstream failure" }));
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const result = replyFake();

    await routeHandler(ctx, path)(
      {
        query: path === "/smoke/noaa" ? {} : VALID_VIEWPORT,
        params: {},
        body: undefined,
        headers: {},
      },
      result.reply,
    );

    expect(result.result()).toMatchObject({ statusCode: 503, body: { code } });
    expect(result.result().headers.get("Cache-Control")).toBe("no-store");
  });

  it("maps an HTTP-200 NOAA ArcGIS error payload to a no-store source failure", async () => {
    fetchMock.mockResolvedValueOnce(response(200, { error: { code: 400 } }));
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const result = replyFake();

    await routeHandler(ctx, "/smoke/noaa")(
      { query: {}, params: {}, body: undefined, headers: {} },
      result.reply,
    );

    expect(result.result()).toMatchObject({
      statusCode: 503,
      body: { code: "noaa_hms_unavailable" },
    });
    expect(result.result().headers.get("Cache-Control")).toBe("no-store");
  });

  it("rethrows a programmer error that only resembles an NOAA source failure", async () => {
    const payload = {
      type: "FeatureCollection",
      get features(): never {
        throw new Error("NOAA API returned 503 while formatting a response");
      },
    };
    fetchMock.mockResolvedValueOnce(response(200, payload));
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const result = replyFake();

    await expect(
      routeHandler(ctx, "/smoke/noaa")(
        { query: {}, params: {}, body: undefined, headers: {} },
        result.reply,
      ),
    ).rejects.toThrow("NOAA API returned 503 while formatting a response");
  });

  it("rethrows an unexpected NIFC error for monitoring", async () => {
    const payload = {
      type: "FeatureCollection",
      get features(): never {
        throw new Error("programmer failure");
      },
    };
    fetchMock.mockResolvedValueOnce(response(200, payload));
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const result = replyFake();

    await expect(
      routeHandler(ctx, "/perimeters/nifc")(
        { query: VALID_VIEWPORT, params: {}, body: undefined, headers: {} },
        result.reply,
      ),
    ).rejects.toThrow("programmer failure");
  });
});
