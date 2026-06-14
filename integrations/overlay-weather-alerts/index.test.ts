import { createNoopLogger } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDWD, fetchECCC, fetchNOAA, isExpired, normalizeSeverity } from "./index.js";

const log = createNoopLogger();

function mockOk(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("normalizeSeverity", () => {
  it.each([
    ["Extreme", "Extreme"],
    ["severe", "Severe"],
    ["MODERATE", "Moderate"],
    ["minor", "Minor"],
    ["unknown", "Unknown"],
  ])("title-cases known CAP severity %s -> %s", (raw, expected) => {
    expect(normalizeSeverity(raw)).toBe(expected);
  });

  it("maps unknown / empty / nullish values to Unknown", () => {
    expect(normalizeSeverity("catastrophic")).toBe("Unknown");
    expect(normalizeSeverity("")).toBe("Unknown");
    expect(normalizeSeverity(null)).toBe("Unknown");
    expect(normalizeSeverity(undefined)).toBe("Unknown");
  });
});

describe("isExpired", () => {
  it("treats missing or unparseable timestamps as not expired", () => {
    expect(isExpired(null)).toBe(false);
    expect(isExpired(undefined)).toBe(false);
    expect(isExpired("not-a-date")).toBe(false);
  });

  it("flags past timestamps as expired and future ones as not expired", () => {
    expect(isExpired(new Date(Date.now() - 60_000).toISOString())).toBe(true);
    expect(isExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });
});

describe("fetchNOAA", () => {
  it("normalizes geometry-bearing alerts and drops zone-only / expired ones", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [-90, 30],
                  [-89, 30],
                  [-89, 31],
                  [-90, 30],
                ],
              ],
            },
            properties: {
              id: "urn:oid:1",
              headline: "Tornado Warning issued",
              event: "Tornado Warning",
              severity: "extreme",
              urgency: "Immediate",
              certainty: "Observed",
              description: "Take cover",
              instruction: "Move to a basement",
              effective: "2026-03-10T09:00:00Z",
              expires: new Date(Date.now() + 3_600_000).toISOString(),
              areaDesc: "Some County",
              web: "https://example.gov/alert",
            },
          },
          {
            // No geometry — zone-based, should be dropped.
            geometry: null,
            properties: { id: "urn:oid:2", event: "Flood Watch", severity: "moderate" },
          },
          {
            geometry: { type: "Polygon", coordinates: [] },
            properties: {
              id: "urn:oid:3",
              event: "Old Warning",
              severity: "severe",
              expires: new Date(Date.now() - 3_600_000).toISOString(),
            },
          },
        ],
      }),
    );

    const features = await fetchNOAA(log);

    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      type: "Feature",
      properties: {
        id: "noaa-urn:oid:1",
        title: "Tornado Warning issued",
        severity: "Extreme",
        event: "Tornado Warning",
        onset: "2026-03-10T09:00:00Z",
        source: "noaa",
        sourceUrl: "https://example.gov/alert",
        geometryType: "polygon",
      },
    });
    expect(features[0].geometry.type).toBe("Polygon");
  });

  it("returns an empty list when NOAA responds non-OK", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    expect(await fetchNOAA(log)).toEqual([]);
  });
});

describe("fetchECCC", () => {
  it("maps Canadian alert types to CAP severities", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            id: "w1",
            geometry: { type: "Polygon", coordinates: [[[0, 0]]] },
            properties: { alert_type: "warning", alert_name_en: "Snow Squall Warning" },
          },
          {
            id: "w2",
            geometry: { type: "Polygon", coordinates: [[[0, 0]]] },
            properties: { alert_type: "watch", alert_name_en: "Severe Thunderstorm Watch" },
          },
          {
            id: "w3",
            geometry: { type: "Polygon", coordinates: [[[0, 0]]] },
            properties: { alert_type: "advisory", alert_name_en: "Fog Advisory" },
          },
          {
            id: "w4",
            geometry: { type: "Polygon", coordinates: [[[0, 0]]] },
            properties: { alert_type: "special weather statement", alert_name_en: "Statement" },
          },
          {
            id: "w5",
            geometry: { type: "Polygon", coordinates: [[[0, 0]]] },
            properties: { alert_type: "ended", alert_name_en: "Ended" },
          },
        ],
      }),
    );

    const features = await fetchECCC(log);

    expect(features.map((f) => f.properties.severity)).toEqual([
      "Severe",
      "Moderate",
      "Minor",
      "Minor",
      "Unknown",
    ]);
    expect(features[0].properties.id).toBe("eccc-w1");
    expect(features[0].properties.source).toBe("eccc");
  });
});

describe("fetchDWD", () => {
  it("normalizes German uppercase property keys and builds a stable id", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            geometry: { type: "Polygon", coordinates: [[[10, 50]]] },
            properties: {
              IDENTIFIER: "DWD-123",
              HEADLINE: "Amtliche Warnung vor Sturm",
              EVENT: "WIND",
              SEVERITY: "severe",
              URGENCY: "Immediate",
              CERTAINTY: "Likely",
              DESCRIPTION: "Sturmböen",
              EXPIRES: new Date(Date.now() + 3_600_000).toISOString(),
              NAME: "Berlin",
            },
          },
        ],
      }),
    );

    const features = await fetchDWD(log);

    expect(features).toHaveLength(1);
    expect(features[0].properties).toMatchObject({
      id: "dwd-DWD-123",
      title: "Amtliche Warnung vor Sturm",
      severity: "Severe",
      event: "WIND",
      areaDesc: "Berlin",
      source: "dwd",
      geometryType: "polygon",
    });
  });
});
