import { describe, expect, it } from "vitest";
import {
  buildSourceAttribution,
  extractSourcePrefix,
  pickIntegrationForSources,
} from "../utils/attribution";

describe("extractSourcePrefix", () => {
  it("returns full string when no separator", () => {
    expect(extractSourcePrefix("felyx")).toBe("felyx");
  });

  it("extracts prefix before /", () => {
    expect(extractSourcePrefix("tankerkoenig/abc-123")).toBe("tankerkoenig");
  });

  it("extracts prefix before :", () => {
    expect(extractSourcePrefix("ocm:12345")).toBe("ocm");
  });

  it("uses earlier separator when both present", () => {
    expect(extractSourcePrefix("parkapi-v2/Dresden:123")).toBe("parkapi-v2");
  });

  it("handles colon before slash", () => {
    expect(extractSourcePrefix("osm:node/456")).toBe("osm");
  });
});

describe("buildSourceAttribution", () => {
  const dataSources = [
    {
      sourceId: "tankerkoenig",
      name: "Tankerkoenig",
      url: "https://tankerkoenig.de",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      providerCountry: "DE",
      providerPrivacyUrl: "https://example.com",
    },
    {
      sourceId: "osm",
      name: "OpenStreetMap",
      url: "https://www.openstreetmap.org",
      license: "ODbL",
      licenseUrl: "https://opendatacommons.org/licenses/odbl/",
      providerCountry: "UK",
      providerPrivacyUrl: "https://example.com",
    },
  ];

  it("filters to matching sourceId", () => {
    const html = buildSourceAttribution(dataSources, ["tankerkoenig/abc"]);
    expect(html).toContain("Tankerkoenig");
    expect(html).not.toContain("OpenStreetMap");
  });

  it("returns multiple matching sources joined by middle dot", () => {
    const html = buildSourceAttribution(dataSources, ["tankerkoenig/abc", "osm:node/123"]);
    expect(html).toContain("Tankerkoenig");
    expect(html).toContain("OpenStreetMap");
    expect(html).toContain(" · ");
  });

  it("falls back to all sources when no match", () => {
    const html = buildSourceAttribution(dataSources, ["unknown-source"]);
    expect(html).toContain("Tankerkoenig");
    expect(html).toContain("OpenStreetMap");
  });

  it("uses custom attribution HTML when provided", () => {
    const ds = [
      {
        sourceId: "custom",
        name: "Custom",
        url: "https://example.com",
        license: "MIT",
        attribution: "Custom <b>attribution</b>",
        providerCountry: "US",
        providerPrivacyUrl: "https://example.com",
      },
    ];
    const html = buildSourceAttribution(ds, ["custom"]);
    expect(html).toBe("Custom <b>attribution</b>");
  });
});

describe("pickIntegrationForSources", () => {
  const osmEntry = {
    sourceId: "osm",
    name: "OpenStreetMap",
    url: "https://www.openstreetmap.org",
    license: "ODbL",
    providerCountry: "UK",
    providerPrivacyUrl: "https://example.com",
  };
  const evCharging = {
    id: "ev-charging",
    dataSources: [{ ...osmEntry }, { ...osmEntry, sourceId: "ocm" }],
  };
  const fuel = {
    id: "fuel",
    dataSources: [{ ...osmEntry }, { ...osmEntry, sourceId: "tankerkoenig" }],
  };
  const parking = {
    id: "parking",
    dataSources: [
      { ...osmEntry, sourceId: "nrw-mobidrom-parking" },
      { ...osmEntry, sourceId: "apag" },
      { ...osmEntry },
    ],
  };

  it("picks the integration with the highest sourceId coverage", () => {
    // Sources span apag + nrw + osm — only `parking` matches all three;
    // `ev-charging`/`fuel` would only match the shared "osm" prefix and
    // must not win the tie just by listing OSM earlier in the registry.
    const picked = pickIntegrationForSources(
      [evCharging, fuel, parking],
      ["nrw-mobidrom-parking", "apag", "osm"],
    );
    expect(picked?.id).toBe("parking");
  });

  it("returns null when no integration matches", () => {
    const picked = pickIntegrationForSources([evCharging, fuel], ["windy:cam-1"]);
    expect(picked).toBeNull();
  });

  it("returns the first integration on a tie", () => {
    // Only "osm" present → ev-charging, fuel, parking all score 1.
    const picked = pickIntegrationForSources([evCharging, fuel, parking], ["osm:way/123"]);
    expect(picked?.id).toBe("ev-charging");
  });
});
