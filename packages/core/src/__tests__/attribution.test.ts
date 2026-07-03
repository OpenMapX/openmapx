import { describe, expect, it } from "vitest";
import {
  buildAttributionHtml,
  buildIntegrationAttribution,
  buildRuntimeAttributionHtml,
  buildSourceAttribution,
  extractSourcePrefix,
  pickIntegrationForSources,
  sanitizeAttributionHtml,
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

  it("sanitizes custom attribution HTML", () => {
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
    expect(html).toBe("Custom attribution");
  });
});

describe("buildRuntimeAttributionHtml", () => {
  it("escapes runtime attribution text and rejects non-http URLs", () => {
    const html = buildRuntimeAttributionHtml({
      text: "<Provider>",
      url: "javascript:alert(1)",
      license: "CC BY <4.0>",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    });

    expect(html).toContain("&lt;Provider&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("https://creativecommons.org/licenses/by/4.0/");
    expect(html).toContain("CC BY &lt;4.0&gt;");
  });
});

describe("sanitizeAttributionHtml", () => {
  it("escapes special characters in plain text", () => {
    expect(sanitizeAttributionHtml("A & B's data")).toBe("A &amp; B&#39;s data");
  });

  it("normalizes a bare anchor from a real manifest (ev-charging/osm)", () => {
    const input =
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
    expect(sanitizeAttributionHtml(input)).toBe(
      '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
    );
  });

  it("leaves an already-normalized anchor byte-identical (ev-charging/ocm)", () => {
    const input =
      '© <a href="https://openchargemap.org" target="_blank" rel="noopener noreferrer">OpenChargeMap</a> and its listed data providers (license varies per provider)';
    expect(sanitizeAttributionHtml(input)).toBe(input);
  });

  it("preserves <code> without attributes", () => {
    expect(sanitizeAttributionHtml("ships as <code>apag-mobidrom</code>")).toBe(
      "ships as <code>apag-mobidrom</code>",
    );
  });

  it("unwraps unknown tags, keeping children", () => {
    expect(sanitizeAttributionHtml("Custom <b>x</b>")).toBe("Custom x");
  });

  it("unwraps anchors with a non-http, relative, or missing href", () => {
    expect(sanitizeAttributionHtml('<a href="ftp://example.com">x</a>')).toBe("x");
    expect(sanitizeAttributionHtml('<a href="/local">x</a>')).toBe("x");
    expect(sanitizeAttributionHtml("<a>x</a>")).toBe("x");
  });

  it("drops extra attributes from allowed anchors", () => {
    expect(
      sanitizeAttributionHtml('<a href="https://example.com" title="t" data-x="1">x</a>'),
    ).toBe('<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>');
  });

  it("auto-closes an unclosed allowed tag", () => {
    expect(sanitizeAttributionHtml('<a href="https://example.com">x')).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it("escapes a non-tag < as text", () => {
    expect(sanitizeAttributionHtml("a < b")).toBe("a &lt; b");
    expect(sanitizeAttributionHtml("1 <3 you")).toBe("1 &lt;3 you");
  });
});

describe("buildAttributionHtml", () => {
  it("escapes generated-path fields and rejects non-http URLs", () => {
    const html = buildAttributionHtml({
      name: "<Provider>",
      url: "ftp://example.com",
      license: "CC BY <4.0>",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    });

    expect(html).toContain("&lt;Provider&gt;");
    expect(html).not.toContain("ftp:");
    expect(html).not.toContain('<a href="ftp');
    expect(html).toContain("https://creativecommons.org/licenses/by/4.0/");
    expect(html).toContain("CC BY &lt;4.0&gt;");
  });

  it("produces unchanged visible shape for a benign generated fixture (bike-sharing/citybikes)", () => {
    const html = buildAttributionHtml({
      name: "CityBikes",
      url: "https://citybik.es/",
      license: "Proprietary (custom terms, attribution required)",
    });

    expect(html).toBe(
      '© <a href="https://citybik.es/" target="_blank" rel="noopener noreferrer">CityBikes</a> (Proprietary (custom terms, attribution required))',
    );
  });

  it("dedups identical attribution strings across dataSources via buildIntegrationAttribution", () => {
    const ds = [
      {
        sourceId: "a",
        name: "A",
        url: "https://example.com",
        license: "MIT",
        attribution: '© <a href="https://osm.org/copyright">OSM</a>',
        providerCountry: "US",
        providerPrivacyUrl: "https://example.com",
      },
      {
        sourceId: "b",
        name: "B",
        url: "https://example.com",
        license: "MIT",
        attribution: '© <a href="https://osm.org/copyright">OSM</a>',
        providerCountry: "US",
        providerPrivacyUrl: "https://example.com",
      },
    ];
    const html = buildIntegrationAttribution(ds);
    expect(html).not.toContain(" · ");
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
