import type { IntegrationContext } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csvToGeoJSON, loadFirms, parseAcqDateTime } from "./firms.js";

describe("parseAcqDateTime", () => {
  it("pads HHMM time and parses as UTC epoch ms", () => {
    expect(parseAcqDateTime("2026-03-10", "0945")).toBe(Date.parse("2026-03-10T09:45:00Z"));
  });

  it("left-pads a short time string before splitting", () => {
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
      "1,2,300",
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

function createContext(entries: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(entries));
  const cache = {
    get: vi.fn(async <T>(key: string) => (values.get(key) as T | undefined) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
  const log = { warn: vi.fn(), error: vi.fn() };

  return {
    ctx: { cache, config: { firmsApiKey: "test-key" }, log } as unknown as IntegrationContext,
    cache,
  };
}

describe("loadFirms", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns stale FIRMS data when an aborted fetch fails", async () => {
    const stale = {
      value: csvToGeoJSON(
        `${VIIRS_HEADER}\n37.5,-122.3,310.4,2026-03-10,1130,N,nominal,12.5,D`,
        "VIIRS_SNPP_NRT",
      ),
      fetchedAt: "2026-08-12T10:00:00.000Z",
    };
    const { ctx } = createContext({ "fire:VIIRS_SNPP_NRT:1:stale": stale });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      }),
    );

    await expect(loadFirms(ctx, { dayRange: 1, source: "VIIRS_SNPP_NRT" })).resolves.toEqual(
      stale.value,
    );
  });

  it.each([
    [
      "successful",
      async () =>
        new Response(`${VIIRS_HEADER}\n37.5,-122.3,310.4,2026-03-10,1130,N,nominal,12.5,D`),
    ],
    ["rejected", async () => Promise.reject(new Error("upstream unavailable"))],
  ])("clears the timeout when the FIRMS fetch is %s", async (_outcome, fetchResponse) => {
    const { ctx } = createContext();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.stubGlobal("fetch", vi.fn(fetchResponse));

    await loadFirms(ctx, { dayRange: 1, source: "VIIRS_SNPP_NRT" }).catch(() => undefined);

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});
