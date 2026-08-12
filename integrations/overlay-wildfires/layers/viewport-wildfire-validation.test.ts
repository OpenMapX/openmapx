import { describe, expect, it } from "vitest";
import type { WildfireFeatureCollection } from "../types";
import { isViewportWildfireFeatureCollection } from "./viewport-wildfire-validation";

const GEOMETRY: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [8, 50],
      [9, 50],
      [9, 51],
      [8, 50],
    ],
  ],
};

function collection(
  source: "nifc" | "effis",
  properties: Record<string, unknown>,
): WildfireFeatureCollection {
  const id = `${source}:1`;
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", id, properties: { id, ...properties }, geometry: GEOMETRY }],
    source,
    fetchedAt: "2026-08-12T12:00:00.000Z",
    stale: false,
    truncated: false,
  };
}

const NIFC_PROPERTIES = {
  kind: "reported-perimeter",
  provider: "nifc",
  coverage: "United States",
  name: "Pine Fire",
};

const EFFIS_PROPERTIES = {
  kind: "satellite-burned-area",
  provider: "effis",
  areaHectares: 42,
};

describe("isViewportWildfireFeatureCollection timestamps", () => {
  it("accepts canonical UTC millisecond timestamps for both providers", () => {
    const nifc = collection("nifc", {
      ...NIFC_PROPERTIES,
      observedAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2024-02-29T23:59:59.999Z",
      discoveredAt: "2026-08-10T01:02:03.004Z",
    });
    const effis = collection("effis", {
      ...EFFIS_PROPERTIES,
      detectedAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
    });

    expect(isViewportWildfireFeatureCollection(nifc, "nifc")).toBe(true);
    expect(isViewportWildfireFeatureCollection(effis, "effis")).toBe(true);
  });

  it.each([
    0,
    "0",
    "2026-08-12",
    "2026-08-12T12:00:00Z",
    "2026-08-12T12:00:00.000+00:00",
    "2026-13-12T12:00:00.000Z",
    "2026-02-30T12:00:00.000Z",
    "arbitrary",
  ])("rejects non-canonical envelope fetchedAt %s", (fetchedAt) => {
    const value = { ...collection("nifc", NIFC_PROPERTIES), fetchedAt };
    expect(isViewportWildfireFeatureCollection(value, "nifc")).toBe(false);
  });

  it.each(["observedAt", "updatedAt", "discoveredAt"])("rejects invalid NIFC %s", (field) => {
    const value = collection("nifc", {
      ...NIFC_PROPERTIES,
      [field]: "2026-02-30T12:00:00.000Z",
    });
    expect(isViewportWildfireFeatureCollection(value, "nifc")).toBe(false);
  });

  it.each(["detectedAt", "updatedAt"])("rejects invalid EFFIS %s", (field) => {
    const value = collection("effis", {
      ...EFFIS_PROPERTIES,
      [field]: "2026-08-12T25:00:00.000Z",
    });
    expect(isViewportWildfireFeatureCollection(value, "effis")).toBe(false);
  });
});
