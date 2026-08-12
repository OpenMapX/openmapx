import type { IntegrationContext } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildNoaaSmokeUrl,
  loadNoaaSmoke,
  normalizeNoaaSmokeFeature,
  normalizeSmokeDensity,
  parseHmsUtc,
} from "./noaa-smoke.js";
import { WildfireSourceError } from "./types.js";

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

function smokeFeature(
  properties: Record<string, unknown> = {},
  geometry: unknown = POLYGON,
  id: string | number | undefined = properties.FID as string | number | undefined,
) {
  return {
    type: "Feature" as const,
    ...(id === undefined ? {} : { id }),
    properties: {
      FID: 42,
      Satellite: "GOES-WEST",
      Start: "2026224 1200",
      End_: "2026224 1500",
      Density: "Light",
      ...properties,
    },
    geometry,
  };
}

function createContext() {
  return {
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as IntegrationContext;
}

describe("buildNoaaSmokeUrl", () => {
  it("builds a global HMS ArcGIS GeoJSON query with only the required fields", () => {
    const url = new URL(buildNoaaSmokeUrl());

    expect(url.hostname).toBe("services2.arcgis.com");
    expect(url.pathname).toBe(
      "/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_%28v1%29/FeatureServer/0/query",
    );
    expect(url.searchParams.get("where")).toBe("1=1");
    expect(url.searchParams.get("outFields")).toBe("FID,Satellite,Start,End_,Density");
    expect(url.searchParams.get("outSR")).toBe("4326");
    expect(url.searchParams.get("returnGeometry")).toBe("true");
    expect(url.searchParams.get("f")).toBe("geojson");
    expect(url.searchParams.get("orderByFields")).toBe("FID ASC");
    expect(url.searchParams.get("resultOffset")).toBe("0");
    expect(url.searchParams.get("resultRecordCount")).toBe("1000");
    expect(url.searchParams.has("geometry")).toBe(false);
  });
});

describe("parseHmsUtc", () => {
  it("parses HMS year/day-of-year timestamps as UTC", () => {
    expect(parseHmsUtc("2026224 1200")).toBe("2026-08-12T12:00:00.000Z");
  });

  it("accepts day 366 only in a Gregorian leap year", () => {
    expect(parseHmsUtc("2024366 1200")).toBe("2024-12-31T12:00:00.000Z");
    expect(parseHmsUtc("2000366 1200")).toBe("2000-12-31T12:00:00.000Z");
    expect(parseHmsUtc("2026366 1200")).toBeUndefined();
    expect(parseHmsUtc("2100366 1200")).toBeUndefined();
  });

  it.each([
    ["2026001 0000", "2026-01-01T00:00:00.000Z"],
    ["2026365 2359", "2026-12-31T23:59:00.000Z"],
  ])("preserves valid HMS boundary timestamp %s", (raw, expected) => {
    expect(parseHmsUtc(raw)).toBe(expected);
  });

  it.each([
    "",
    "2026224 2460",
    "2026224 2400",
    "2026224 1260",
    "2026224 120",
    "2026000 1200",
    "2026366 1200",
    "2026367 1200",
  ])("rejects invalid HMS timestamp %j", (value) => expect(parseHmsUtc(value)).toBeUndefined());
});

describe("normalizeSmokeDensity", () => {
  it.each([
    ["Light", "light"],
    ["MEDIUM", "medium"],
    [" heavy ", "heavy"],
  ])("normalizes %s density", (raw, expected) => {
    expect(normalizeSmokeDensity(raw)).toBe(expected);
  });

  it.each([undefined, null, "", "Unknown"])("rejects unsupported density %j", (value) => {
    expect(normalizeSmokeDensity(value)).toBeUndefined();
  });
});

describe("normalizeNoaaSmokeFeature", () => {
  it("normalizes HMS smoke attributes, timestamps, and stable IDs", () => {
    expect(
      normalizeNoaaSmokeFeature(smokeFeature({ FID: 7, Satellite: " GOES-EAST " })),
    ).toMatchObject({
      type: "Feature",
      id: "noaa-hms:7",
      geometry: POLYGON,
      properties: {
        id: "noaa-hms:7",
        kind: "observed-smoke",
        provider: "noaa-hms",
        density: "light",
        satellite: "GOES-EAST",
        startedAt: "2026-08-12T12:00:00.000Z",
        endedAt: "2026-08-12T15:00:00.000Z",
      },
    });
  });

  it("rejects unknown density and non-polygon geometry", () => {
    expect(normalizeNoaaSmokeFeature(smokeFeature({ Density: "Unknown" }))).toBeNull();
    expect(
      normalizeNoaaSmokeFeature(smokeFeature({}, { type: "Point", coordinates: [-120, 35] })),
    ).toBeNull();
  });

  it.each(["Polygon", "MultiPolygon"])("accepts valid %s geometry", (type) => {
    const geometry =
      type === "Polygon"
        ? POLYGON
        : { type: "MultiPolygon" as const, coordinates: [POLYGON.coordinates] };
    expect(normalizeNoaaSmokeFeature(smokeFeature({}, geometry))).not.toBeNull();
  });

  it.each([
    { type: "Polygon", coordinates: [] },
    {
      type: "Polygon",
      coordinates: [
        [
          [-120, 35],
          [-119, 35],
          [-119, 36],
          [-120, 36],
        ],
      ],
    },
    {
      type: "Polygon",
      coordinates: [
        [
          [-181, 35],
          [-119, 35],
          [-119, 36],
          [-181, 35],
        ],
      ],
    },
  ])("rejects invalid smoke geometry %j", (geometry) => {
    expect(normalizeNoaaSmokeFeature(smokeFeature({}, geometry))).toBeNull();
  });
});

describe("loadNoaaSmoke", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads an empty global HMS collection without a viewport request", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ type: "FeatureCollection", features: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadNoaaSmoke(createContext())).resolves.toEqual({
      type: "FeatureCollection",
      features: [],
      source: "noaa-hms",
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("where=1%3D1"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("fetches every requested global page in deterministic FID order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "FeatureCollection",
            properties: { exceededTransferLimit: true },
            features: [smokeFeature({ FID: 1 })],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "FeatureCollection",
            features: [smokeFeature({ FID: 2 })],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadNoaaSmoke(createContext());

    expect(result.features.map((feature) => feature.id)).toEqual(["noaa-hms:1", "noaa-hms:2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("resultOffset")).toBe("1000");
  });

  it("rejects incomplete global data rather than returning a truncated collection", async () => {
    const page = {
      type: "FeatureCollection",
      properties: { exceededTransferLimit: true },
      features: [smokeFeature()],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(page))),
    );

    await expect(loadNoaaSmoke(createContext())).rejects.toThrow("feature cap");
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

    const pending = loadNoaaSmoke(createContext());
    const rejection = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects failed, malformed, and ArcGIS error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    await expect(loadNoaaSmoke(createContext())).rejects.toThrow("NOAA API returned 503");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json")),
    );
    await expect(loadNoaaSmoke(createContext())).rejects.toThrow("Invalid NOAA JSON response");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 400 } }))),
    );
    await expect(loadNoaaSmoke(createContext())).rejects.toThrow("NOAA ArcGIS error response");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ type: "FeatureCollection" }))),
    );
    await expect(loadNoaaSmoke(createContext())).rejects.toThrow("Invalid NOAA FeatureCollection");
  });

  it("classifies HTTP-200 ArcGIS error payloads as typed NOAA source failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 400 } }))),
    );

    await expect(loadNoaaSmoke(createContext())).rejects.toBeInstanceOf(WildfireSourceError);
    await expect(loadNoaaSmoke(createContext())).rejects.toMatchObject({
      provider: "noaa-hms",
      kind: "upstream-payload",
    });
  });
});
