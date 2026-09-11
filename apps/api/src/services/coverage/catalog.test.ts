import type { IntegrationManifest, LoadedIntegration } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import { buildCoverageCatalog } from "./catalog.js";

function integration(dataSources: IntegrationManifest["dataSources"]): LoadedIntegration {
  return {
    id: "fixture-integration",
    manifest: {
      id: "fixture-integration",
      domains: ["poi-search"],
      dataSources,
    },
    config: {},
    directory: "/fixture",
    isBuiltIn: true,
    enabled: true,
    providers: new Map(),
    strings: {},
    shutdownHandlers: [],
  };
}

const baseSource = {
  sourceId: "fixture-source",
  name: "Fixture source",
  url: "https://example.com/source",
  license: "Recorded license",
  providerCountry: "DE",
  providerPrivacyUrl: "https://example.com/privacy",
};

describe("coverage governance catalog", () => {
  it("keeps same-owner conflicting assertions visible and marked", () => {
    const catalog = buildCoverageCatalog([
      integration([
        { ...baseSource, commercialUse: "yes" },
        { ...baseSource, commercialUse: "no" },
      ]),
    ]);

    expect(catalog.rights).toHaveLength(2);
    expect(new Set(catalog.rights.map((record) => record.qualifiedDatasetKey)).size).toBe(1);
    expect(catalog.rights.every((record) => record.conflict === true)).toBe(true);
    expect(new Set(catalog.rights.map((record) => record.key)).size).toBe(2);
  });

  it("does not conflate equal source ids owned by different integrations", () => {
    const catalog = buildCoverageCatalog([
      integration([{ ...baseSource, commercialUse: "yes" }]),
      {
        ...integration([{ ...baseSource, commercialUse: "no" }]),
        id: "other-integration",
        manifest: {
          ...integration([{ ...baseSource, commercialUse: "no" }]).manifest,
          id: "other-integration",
        },
      },
    ]);

    expect(catalog.rights.map((record) => record.qualifiedDatasetKey)).toEqual([
      "fixture-integration:fixture-source",
      "other-integration:fixture-source",
    ]);
    expect(catalog.rights.some((record) => record.conflict)).toBe(false);
  });
});
