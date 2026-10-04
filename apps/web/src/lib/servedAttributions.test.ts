import type { IntegrationDataSource } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import type { ProviderMetaResolver } from "./attributionForProviders";
import { servedAttributions } from "./servedAttributions";

function ds(sourceId: string, name: string): IntegrationDataSource {
  return {
    sourceId,
    name,
    url: `https://example.com/${sourceId}`,
    license: "Apache-2.0",
    providerCountry: "XX",
    providerPrivacyUrl: "-",
  };
}

const registry: ProviderMetaResolver = {
  get: (id) =>
    ({
      "geocoding-photon": {
        dataSources: [ds("photon", "Photon"), ds("komoot", "Photon (Komoot)")],
      },
      "geocoding-entur": { dataSources: [ds("entur", "Entur")] },
    })[id],
};

describe("servedAttributions", () => {
  it("narrows a provider to the backend its item reported", () => {
    const credits = servedAttributions(registry, [
      { provider: "geocoding-photon", sourceIds: ["photon"] },
    ]);
    expect(credits.map((a) => a.name)).toEqual(["Photon"]);
  });

  it("keeps every declared source of a contributor that reported none", () => {
    const credits = servedAttributions(registry, [
      {
        provider: "geocoding-entur",
        contributingProviders: ["geocoding-entur", "geocoding-photon"],
        sourceIds: ["komoot"],
      },
    ]);
    expect(credits.map((a) => a.name)).toEqual(["Entur", "Photon (Komoot)"]);
  });

  it("dedupes across items and skips unknown providers", () => {
    const credits = servedAttributions(registry, [
      { provider: "geocoding-photon", sourceIds: ["photon"] },
      { provider: "geocoding-photon", sourceIds: ["photon"] },
      { provider: "unknown" },
      null,
    ]);
    expect(credits.map((a) => a.name)).toEqual(["Photon"]);
  });
});
