import type { IntegrationDataSource } from "@openmapx/integration-framework";
import { formatLicensing, licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { describe, expect, it, vi } from "vitest";
import {
  attributionsForProviders,
  attributionsForSources,
  type DataSourceResolver,
  dataSourceLayerCredits,
  mergeAttributions,
  type ProviderMetaResolver,
} from "./attributionForProviders";

function ds(partial: Partial<IntegrationDataSource> & { sourceId: string }): IntegrationDataSource {
  return {
    name: partial.sourceId,
    url: `https://example.com/${partial.sourceId}`,
    licensing: {
      version: 1,
      bindings: [
        { scope: "data", subject: "Data", license: { kind: "spdx", expression: "ODbL-1.0" } },
      ],
    } as const,
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
    "geocoding-maptiler": [
      ds({
        sourceId: "maptiler",
        name: "MapTiler",
        licensing: licensingFromDeclaration("Proprietary", undefined),
      }),
    ],
    "geocoding-nominatim": [
      ds({
        sourceId: "nominatim",
        name: "Nominatim (OpenStreetMap)",
        licensing: licensingFromDeclaration("ODbL 1.0", undefined),
      }),
    ],
    "geocoding-photon": [
      // Shares the OSM credit with Nominatim — used to assert dedup.
      ds({
        sourceId: "nominatim",
        name: "Nominatim (OpenStreetMap)",
        licensing: licensingFromDeclaration("ODbL 1.0", undefined),
      }),
      ds({
        sourceId: "photon",
        name: "Photon (Komoot)",
        licensing: licensingFromDeclaration("BSD-3-Clause", undefined),
      }),
    ],
  });

  it("credits only the served provider, not the whole domain", () => {
    const attrs = attributionsForProviders(registry, ["geocoding-maptiler"]);
    expect(attrs.map((a) => a.sourceId)).toEqual(["maptiler"]);
    expect(attrs[0].name).toBe("MapTiler");
    expect(formatLicensing(attrs[0].licensing!)).toBe("Proprietary");
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
    mangrove: ds({
      sourceId: "mangrove",
      name: "Mangrove.reviews",
      licensing: licensingFromDeclaration("CC-BY-4.0", undefined),
    }),
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

describe("mergeAttributions", () => {
  it("retains first-seen order while deduplicating identical credits", () => {
    const first = { sourceId: "osm", name: "OpenStreetMap" };
    const duplicate = { ...first };
    const second = { sourceId: "ourairports", name: "OurAirports" };

    expect(mergeAttributions([first], [duplicate, second])).toEqual([first, second]);
  });

  it("returns an empty list for empty groups", () => {
    expect(mergeAttributions([], [])).toEqual([]);
  });
});

describe("dataSourceLayerCredits", () => {
  const mtsk = {
    sourceId: "MTS-K via Tankerkönig",
    name: "MTS-K via Tankerkönig",
    url: "https://creativecommons.tankerkoenig.de/",
    licensing: {
      version: 1,
      bindings: [
        { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
      ],
    } as const,
  };

  it("credits per-record attributions of a source whose manifest declares none, without a warning", () => {
    const warn = vi.fn();
    const credits = dataSourceLayerCredits({
      sourceLabel: "fuel",
      dataSources: [],
      envelope: [{ sourceId: "de-mtsk", name: "MTS-K via Tankerkönig" }],
      results: [{ attributions: [mtsk] }, { attributions: [mtsk] }],
      isFetching: false,
      warn,
    });

    expect(credits).toEqual([
      {
        sourceId: "MTS-K via Tankerkönig",
        name: "MTS-K via Tankerkönig",
        url: "https://creativecommons.tankerkoenig.de/",
        licensing: {
          version: 1,
          bindings: [
            { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
          ],
        } as const,
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("still warns when the envelope credits a source neither declared nor carried per record", () => {
    const warn = vi.fn();
    dataSourceLayerCredits({
      sourceLabel: "parking",
      dataSources: [ds({ sourceId: "osm" })],
      envelope: [{ sourceId: "mystery", name: "Mystery feed" }],
      results: [{}],
      isFetching: false,
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("narrows declared manifest credits to the envelope and appends per-record credits", () => {
    const credits = dataSourceLayerCredits({
      sourceLabel: "ev-charging",
      dataSources: [ds({ sourceId: "ocm", name: "Open Charge Map" }), ds({ sourceId: "osm" })],
      envelope: [{ sourceId: "ocm", name: "Open Charge Map" }],
      results: [
        {
          source: "ocm",
          attributions: [
            { sourceId: "Ville de Paris", name: "Ville de Paris", url: "https://paris.fr" },
          ],
        },
      ],
      isFetching: false,
    });
    expect(credits.map((c) => c.name)).toEqual(["Open Charge Map", "Ville de Paris"]);
  });

  it("keeps retained per-record credits while a refresh is in flight", () => {
    expect(
      dataSourceLayerCredits({
        sourceLabel: "fuel",
        dataSources: [ds({ sourceId: "osm" })],
        envelope: [],
        results: [{ attributions: [mtsk] }],
        isFetching: true,
      }),
    ).toEqual([mtsk]);
  });
});

describe("exact data-source record credits", () => {
  const a = { sourceId: "a", name: "A", attributionText: "Captured notice" };
  const b = { sourceId: "b", name: "B" };
  const input = {
    sourceLabel: "mixed",
    dataSources: [ds({ sourceId: "a" }), ds({ sourceId: "b" })],
    envelope: [a, b],
    isFetching: false,
  };
  it("clears when client filters remove every record", () => {
    expect(dataSourceLayerCredits({ ...input, results: [] })).toEqual([]);
  });
  it("uses immutable canonical receipts during a failed refresh", () => {
    expect(
      dataSourceLayerCredits({
        ...input,
        envelope: [],
        isFetching: true,
        results: [{ contributors: [a] }],
      }),
    ).toEqual([a]);
  });
  it("does not expand unknown mixed records to all declared provider sources", () => {
    expect(dataSourceLayerCredits({ ...input, results: [{ source: "unknown" }] })).toEqual([]);
  });
  it("narrows legacy source IDs to their captured envelope and treats explicit empty receipts as authoritative", () => {
    expect(dataSourceLayerCredits({ ...input, results: [{ source: "a" }] })).toEqual([a]);
    expect(
      dataSourceLayerCredits({ ...input, results: [{ source: "a", contributors: [] }] }),
    ).toEqual([]);
  });
});

it("keeps every distinct notice for exact legacy source IDs and excludes unrelated sources", () => {
  const first = { sourceId: "feed", name: "Feed", attributionText: "Required notice A" };
  const second = { sourceId: "feed", name: "Feed", attributionText: "Required notice B" };
  const input = {
    sourceLabel: "mixed",
    dataSources: [],
    envelope: [first, { sourceId: "other", name: "Other" }, second],
    isFetching: false,
  };
  expect(dataSourceLayerCredits({ ...input, results: [{ source: "feed" }] })).toEqual([
    first,
    second,
  ]);
  expect(
    dataSourceLayerCredits({ ...input, results: [{ source: "feed", contributors: [] }] }),
  ).toEqual([]);
});

it("preserves distinct mandatory notices from one source and copies publisher metadata", () => {
  const first = {
    sourceId: "one",
    name: "One",
    attributionText: "Required first",
    publisher: { name: "Publisher" },
  };
  const second = { ...first, attributionText: "Required second" };
  const merged = mergeAttributions([first], [second]);
  expect(merged).toEqual([first, second]);
  first.publisher.name = "Changed";
  expect(merged[0].publisher?.name).toBe("Publisher");
});
