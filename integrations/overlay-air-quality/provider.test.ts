import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IntegrationContext, ProviderCallContext } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import type { OpenAQClient } from "./openaq-client.js";
import { buildOpenAQEvidence, createOpenAQProvider } from "./provider.js";
import type { OpenAQHour, OpenAQLocation } from "./schemas.js";

const fixtureDir = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const fixture = <T>(name: string): T => JSON.parse(readFileSync(`${fixtureDir}${name}`, "utf8"));
const location = fixture<{ results: OpenAQLocation[] }>("locations-page-1.json").results[0];
const hours = fixture<{ results: OpenAQHour[] }>("sensor-hours.json").results;
const call: ProviderCallContext = {
  signal: new AbortController().signal,
  deadlineAt: Date.now() + 3_000,
};

describe("OpenAQ provider normalization", () => {
  it("keeps every series at one location and preserves sensor/source/license provenance", () => {
    const evidence = buildOpenAQEvidence(location, [{ sensor: location.sensors[1], hours }], {
      requestedPoint: [35.13, -106.58],
    });
    expect(evidence).not.toBeNull();
    expect(new Set(evidence?.series.map((series) => series.coherenceKey)).size).toBe(1);
    expect(evidence?.series[0]).toMatchObject({
      pollutant: "pm25",
      sensorId: "3920",
      cadenceMinutes: 60,
      originalUnit: "µg/m³",
    });
    expect(evidence?.originRecords).toEqual(
      expect.arrayContaining([{ sourceId: "openaq", recordId: expect.stringContaining("3920") }]),
    );
    expect(evidence?.spatial).toMatchObject({
      id: "openaq-location-2178",
      stationClass: "reference",
      mobile: false,
    });
    expect(evidence?.sources[0]).toMatchObject({
      sourceId: "openaq",
      owner: "Unknown Governmental Organization",
      license: { name: "US Public Domain", url: null },
    });
    expect(evidence?.qualityStatus).toBe("preliminary");
  });

  it("keeps low-cost and mobile metadata raw-only instead of upgrading it", () => {
    const lowCost = fixture<{ results: OpenAQLocation[] }>("locations-page-1.json").results[1];
    const mobile = fixture<{ results: OpenAQLocation[] }>("locations-page-2.json").results[0];
    expect(
      buildOpenAQEvidence(lowCost, [{ sensor: lowCost.sensors[0], hours }])?.spatial.stationClass,
    ).toBe("low-cost");
    expect(
      buildOpenAQEvidence(mobile, [{ sensor: mobile.sensors[0], hours }])?.spatial,
    ).toMatchObject({ mobile: true, stationClass: "unknown" });
  });

  it("rejects unsupported units instead of relabeling their concentration", () => {
    const unsupported = structuredClone(location);
    unsupported.sensors[0].parameter.units = "particles/cm³";
    const altered = hours.map((hour) => ({
      ...hour,
      parameter: { ...hour.parameter, name: "pm10", units: "particles/cm³" },
    }));
    expect(
      buildOpenAQEvidence(unsupported, [{ sensor: unsupported.sensors[0], hours: altered }]),
    ).toBeNull();
  });

  it("passes request cancellation through discovery, latest, and hourly calls", async () => {
    const seen: AbortSignal[] = [];
    const windows: { from: string; to: string; maxSamples: number }[] = [];
    const client = {
      listLocations: vi.fn(async (_query, signal) => {
        seen.push(signal);
        return { items: [location], truncated: false, pages: 1 };
      }),
      getLatest: vi.fn(async (_id, signal) => {
        seen.push(signal);
        return {
          items: [
            {
              sensorsId: 3920,
              locationsId: 2178,
              value: 9.75,
              datetime: { utc: "2026-08-30T11:00:00Z", local: "2026-08-30T05:00:00-06:00" },
              coordinates: location.coordinates,
            },
          ],
          truncated: false,
          pages: 1,
        };
      }),
      listLicenses: vi.fn(async (signal) => {
        seen.push(signal);
        return { items: [], truncated: false, pages: 1 };
      }),
      getSensorHours: vi.fn(async (_id, window, signal) => {
        seen.push(signal);
        windows.push(window);
        return { items: hours, truncated: false, pages: 1 };
      }),
    } as unknown as OpenAQClient;
    const provider = createOpenAQProvider(
      createMockIntegrationContext({ id: "overlay-air-quality" }) as IntegrationContext,
      client,
    );
    const result = await provider.getCurrent?.(
      {
        latitude: 35.13,
        longitude: -106.58,
        evaluatedAt: "2026-08-30T12:34:56Z",
        countryCode: "US",
      },
      call,
    );
    expect(result).toHaveLength(1);
    expect(seen).toEqual([call.signal, call.signal, call.signal, call.signal]);
    expect(windows).toEqual([
      {
        from: "2026-08-28T12:00:00.000Z",
        to: "2026-08-30T12:00:00.000Z",
        maxSamples: 48,
      },
    ]);
  });

  it("does not spend a license-catalog request when discovery returns no locations", async () => {
    const client = {
      listLocations: vi.fn(async () => ({ items: [], truncated: false, pages: 1 })),
      listLicenses: vi.fn(),
    } as unknown as OpenAQClient;
    const provider = createOpenAQProvider(createMockIntegrationContext(), client);
    const result = await provider.getCurrent?.(
      {
        latitude: 35.13,
        longitude: -106.58,
        evaluatedAt: "2026-08-30T12:00:00Z",
        countryCode: "US",
      },
      call,
    );
    expect(result).toEqual([]);
    expect(client.listLicenses).not.toHaveBeenCalled();
  });

  it("isolates a failed location when another location can still provide evidence", async () => {
    const sibling = structuredClone(location);
    sibling.id = 3001;
    const client = {
      listLocations: vi.fn(async () => ({
        items: [location, sibling],
        truncated: false,
        pages: 1,
      })),
      listLicenses: vi.fn(async () => ({ items: [], truncated: false, pages: 1 })),
      getLatest: vi.fn(async (id: number) => {
        if (id === location.id) throw new Error("first station unavailable");
        return {
          items: [
            {
              sensorsId: 3920,
              locationsId: sibling.id,
              value: 9.75,
              datetime: { utc: "2026-08-30T11:00:00Z", local: "2026-08-30T05:00:00-06:00" },
              coordinates: sibling.coordinates,
            },
          ],
          truncated: false,
          pages: 1,
        };
      }),
      getSensorHours: vi.fn(async () => ({ items: hours, truncated: false, pages: 1 })),
    } as unknown as OpenAQClient;
    const provider = createOpenAQProvider(createMockIntegrationContext(), client);
    const result = await provider.getCurrent?.(
      {
        latitude: 35.13,
        longitude: -106.58,
        evaluatedAt: "2026-08-30T12:00:00Z",
        countryCode: "US",
      },
      call,
    );
    expect(result).toHaveLength(1);
    expect(result?.[0].spatial.id).toBe("openaq-location-3001");
  });

  it("returns explicit station demand and quota diagnostics", async () => {
    const client = {
      listLocations: vi.fn(async () => ({ items: [location], truncated: false, pages: 1 })),
      getLatest: vi.fn(async () => ({
        items: [
          {
            sensorsId: 3920,
            locationsId: 2178,
            value: 9.75,
            datetime: { utc: "2026-08-30T11:00:00Z", local: "2026-08-30T05:00:00-06:00" },
            coordinates: location.coordinates,
          },
        ],
        truncated: false,
        pages: 1,
      })),
    } as unknown as OpenAQClient;
    const provider = createOpenAQProvider(createMockIntegrationContext(), client);
    const page = await provider.getStations?.(
      { south: 35, west: -107, north: 36, east: -106, zoom: 8, pollutant: "pm25", limit: 20 },
      call,
    );
    expect(page?.diagnostics).toEqual({
      candidateCount: 1,
      servedCount: 1,
      skippedCount: 0,
      quotaDeniedCount: 0,
      failureCount: 0,
    });
  });

  it("declares and implements the precise framework capabilities", () => {
    const provider = createOpenAQProvider(createMockIntegrationContext(), {} as OpenAQClient);
    expect(provider.capabilities).toEqual(new Set(["current", "stations", "pollutants"]));
    expect(provider.sourceIds).toEqual(["openaq"]);
    expect(provider.getForecast).toBeUndefined();
  });
});
