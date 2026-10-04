import { describe, expect, it } from "vitest";
import { dataSourceSchema, validateManifest } from "../manifest.js";

const base = {
  name: "x",
  url: "https://x",
  license: "L",
  providerCountry: "DE",
  providerPrivacyUrl: "https://x/p",
};

describe("dataSourceSchema.sourceId", () => {
  it("accepts a region-first id", () => {
    expect(dataSourceSchema.safeParse({ ...base, sourceId: "de-by-bamberg" }).success).toBe(true);
  });

  it("rejects an uppercase/underscore id", () => {
    expect(dataSourceSchema.safeParse({ ...base, sourceId: "Bamberg_DE" }).success).toBe(false);
  });

  it("validates optional source-governance fields without invalidating legacy entries", () => {
    expect(
      dataSourceSchema.safeParse({
        ...base,
        sourceId: "de-by-bamberg",
        owner: "Bavarian Environment Agency",
        termsUrl: "https://example.test/terms",
        methodologyUrl: "https://example.test/method",
        attribution: "© Example",
        dataUseClass: "attribution",
        credentialOwner: "instance-operator",
        reviewedAt: "2026-08-30",
      }).success,
    ).toBe(true);
    expect(
      dataSourceSchema.safeParse({ ...base, sourceId: "x", reviewedAt: "30-08-2026" }).success,
    ).toBe(false);
    expect(
      dataSourceSchema.safeParse({ ...base, sourceId: "x", termsUrl: "javascript:x" }).success,
    ).toBe(false);
  });
});

describe("dataSources[].domain", () => {
  const manifest = (domain: string) => ({
    id: "multi",
    domains: ["road-conditions", "fuel-stations"],
    dataSources: [
      { ...base, sourceId: "nl-ndw-events" },
      { ...base, sourceId: "osm-fuel", domain },
    ],
  });

  it("names one of the integration's own domains", () => {
    expect(validateManifest(manifest("fuel-stations"))).toEqual({ valid: true, errors: [] });
  });

  it("rejects a domain the integration does not declare", () => {
    expect(validateManifest(manifest("parking")).errors).toEqual([
      'dataSources[osm-fuel].domain "parking" is not one of the manifest domains',
    ]);
  });
});
