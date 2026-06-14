import type { IntegrationDataSource } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import {
  attributionsForProviders,
  attributionsForSources,
  type DataSourceResolver,
  type ProviderMetaResolver,
} from "./attributionForProviders";

function ds(partial: Partial<IntegrationDataSource> & { sourceId: string }): IntegrationDataSource {
  return {
    name: partial.sourceId,
    url: `https://example.com/${partial.sourceId}`,
    license: "ODbL-1.0",
    providerCountry: "XX",
    providerPrivacyUrl: "-",
    ...partial,
  };
}

function resolver(map: Record<string, IntegrationDataSource[]>): ProviderMetaResolver {
  return { get: (id) => (id in map ? { dataSources: map[id] } : undefined) };
}

describe("attributionsForProviders", () => {
  const registry = resolver({
    "geocoding-maptiler": [ds({ sourceId: "maptiler", name: "MapTiler", license: "Proprietary" })],
    "geocoding-nominatim": [
      ds({ sourceId: "nominatim", name: "Nominatim (OpenStreetMap)", license: "ODbL 1.0" }),
    ],
    "geocoding-photon": [
      // Shares the OSM credit with Nominatim — used to assert dedup.
      ds({ sourceId: "nominatim", name: "Nominatim (OpenStreetMap)", license: "ODbL 1.0" }),
      ds({ sourceId: "photon", name: "Photon (Komoot)", license: "BSD-3-Clause" }),
    ],
  });

  it("credits only the served provider, not the whole domain", () => {
    const attrs = attributionsForProviders(registry, ["geocoding-maptiler"]);
    expect(attrs.map((a) => a.sourceId)).toEqual(["maptiler"]);
    expect(attrs[0].name).toBe("MapTiler");
    expect(attrs[0].spdxLicense).toBe("Proprietary");
  });

  it("dedupes shared sourceIds across multiple served providers (first seen wins)", () => {
    const attrs = attributionsForProviders(registry, ["geocoding-nominatim", "geocoding-photon"]);
    expect(attrs.map((a) => a.sourceId)).toEqual(["nominatim", "photon"]);
  });

  it("skips empty / unknown / null provider ids without throwing", () => {
    expect(attributionsForProviders(registry, [undefined, null, "does-not-exist"])).toEqual([]);
    // A real id mixed with junk still resolves the real one.
    expect(
      attributionsForProviders(registry, [undefined, "geocoding-maptiler"]).map((a) => a.sourceId),
    ).toEqual(["maptiler"]);
  });

  it("returns nothing for an empty id list (no geocoded results ⇒ no credit)", () => {
    expect(attributionsForProviders(registry, [])).toEqual([]);
  });
});

describe("attributionsForSources", () => {
  const bySource: Record<string, IntegrationDataSource> = {
    mangrove: ds({ sourceId: "mangrove", name: "Mangrove.reviews", license: "CC-BY-4.0" }),
  };
  const registry: DataSourceResolver = { findDataSource: (id) => bySource[id] };

  it("credits only the shown sourceId(s), deduped", () => {
    const attrs = attributionsForSources(registry, ["mangrove", "mangrove"]);
    expect(attrs.map((a) => a.sourceId)).toEqual(["mangrove"]);
    expect(attrs[0].name).toBe("Mangrove.reviews");
  });

  it("credits nothing for an unknown source — never a domain-wide fallback", () => {
    expect(attributionsForSources(registry, ["does-not-exist", undefined, null])).toEqual([]);
  });
});
