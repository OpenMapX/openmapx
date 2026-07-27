import { buildAttributionHtml, buildIntegrationAttribution } from "@openmapx/core";
import {
  dataSourceToAttribution,
  type IntegrationDataSource,
} from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import { attributionToHtml } from "./useMapAttributions";

/**
 * The overlay legends render manifest data sources through
 * `buildAttributionHtml`; the bottom credits strip renders the same sources
 * through `attributionToHtml` after `dataSourceToAttribution`. The two have to
 * agree byte-for-byte — otherwise the strip states less than the legend (the
 * license used to be dropped here) and the substring dedup in
 * `dedupeAttributionHtml` cannot collapse a credit two layers both owe.
 */
const COMPLIANCE_FIELDS = {
  providerCountry: "US",
  providerPrivacyUrl: "https://example.com/privacy",
} as const;

const MANIFEST_SOURCES: IntegrationDataSource[] = [
  {
    // Bare publisher + license: the common manifest shape.
    sourceId: "openaq",
    name: "OpenAQ",
    url: "https://api.openaq.org/",
    license: "CC BY 4.0 (varies per source)",
    licenseUrl: "https://docs.openaq.org/resources/licenses",
    ...COMPLIANCE_FIELDS,
  },
  {
    // No licenseUrl — the license renders as plain text.
    sourceId: "gdacs",
    name: "GDACS",
    url: "https://www.gdacs.org/",
    license: "Proprietary (disclaimer-based)",
    ...COMPLIANCE_FIELDS,
  },
  {
    // Custom verbatim wording with an embedded publisher link.
    sourceId: "osm",
    name: "OpenStreetMap",
    url: "https://www.openstreetmap.org",
    license: "ODbL 1.0",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    ...COMPLIANCE_FIELDS,
  },
  {
    // Ampersands and quotes in the publisher name must be escaped identically.
    sourceId: "noaa-co-ops",
    name: 'NOAA Tides & Currents ("CO-OPS")',
    url: "https://tidesandcurrents.noaa.gov/",
    license: "U.S. Public Domain",
    ...COMPLIANCE_FIELDS,
  },
];

describe("attributionToHtml", () => {
  for (const ds of MANIFEST_SOURCES) {
    it(`matches the legend rendering of ${ds.sourceId}`, () => {
      expect(attributionToHtml(dataSourceToAttribution(ds))).toBe(buildAttributionHtml(ds));
    });
  }

  it("credits the license alongside the publisher", () => {
    const html = attributionToHtml(dataSourceToAttribution(MANIFEST_SOURCES[0]));
    expect(html).toContain("OpenAQ");
    expect(html).toContain("CC BY 4.0 (varies per source)");
    expect(html).toContain('href="https://docs.openaq.org/resources/licenses"');
  });

  it("renders a whole manifest's sources as the legend's combined string does", () => {
    const strip = MANIFEST_SOURCES.map((ds) => attributionToHtml(dataSourceToAttribution(ds)));
    expect(strip.join(" · ")).toBe(buildIntegrationAttribution(MANIFEST_SOURCES));
  });

  it("leaves a hand-authored copyright notice unsuffixed, © outside the anchor", () => {
    // The base-map credits (lib/map.ts, page.tsx) carry their own complete
    // wording; appending "(ODbL-1.0)" would rewrite an established notice, and
    // moving the © inside the anchor would break dedup against the
    // "© <a>Publisher</a>" form manifests author.
    expect(
      attributionToHtml({
        sourceId: "openstreetmap",
        name: "© OpenStreetMap contributors",
        url: "https://www.openstreetmap.org/copyright",
        spdxLicense: "ODbL-1.0",
        licenseUrl: "https://opendatacommons.org/licenses/odbl/",
      }),
    ).toBe(
      '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
    );
  });

  it("dedups against the manifest form of the same credit", () => {
    const fromBase = attributionToHtml({
      sourceId: "openstreetmap",
      name: "© OpenStreetMap contributors",
      url: "https://www.openstreetmap.org/copyright",
    });
    const fromManifest = buildAttributionHtml({
      name: "OpenStreetMap",
      url: "https://www.openstreetmap.org",
      license: "ODbL 1.0",
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    });
    expect(fromManifest).toBe(fromBase);
  });

  it("drops an unsafe href rather than emitting it", () => {
    const html = attributionToHtml({
      sourceId: "evil",
      name: "Evil",
      url: ["java", "script:alert(1)"].join(""),
    });
    expect(html).not.toContain("script:");
    expect(html).toBe("Evil");
  });

  it("falls back to plain text when the source has no url", () => {
    expect(attributionToHtml({ sourceId: "anon", name: "Anonymous feed" })).toBe("Anonymous feed");
  });
});
