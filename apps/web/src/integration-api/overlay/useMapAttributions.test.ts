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

it("renders a Commons artist's ampersand and licence correctly through the actual map-credit HTML path", async () => {
  const { parseCommonsPage } = await import("@openmapx/core");
  const photo = parseCommonsPage({
    title: "File:Artist.jpg",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg",
        mime: "image/jpeg",
        extmetadata: {
          Artist: { value: "One &amp; Co" },
          LicenseShortName: { value: "CC BY 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
        },
      },
    ],
  });
  const receipt = photo?.contributors?.[0];
  if (!receipt) throw new Error("complete file should have a receipt");
  const container = document.createElement("div");
  container.innerHTML = attributionToHtml(receipt);
  expect(container.textContent).toContain("One & Co");
  expect(container.textContent).not.toContain("&amp;");
  expect(
    container.querySelector('a[href="https://creativecommons.org/licenses/by/4.0/"]')?.textContent,
  ).toBe("CC BY 4.0");
});

it("renders decoded creator and permission query parameters in generic map credits", async () => {
  const { parseCommonsPage } = await import("@openmapx/core");
  const photo = parseCommonsPage({
    title: "File:Links.jpg",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Links.jpg",
        mime: "image/jpeg",
        extmetadata: {
          Artist: { value: '<a href="https://creator.example/?id=7&amp;view=full">Creator</a>' },
          Permission: {
            value: '<a href="https://permission.example/?id=7&amp;view=full">permission record</a>',
          },
          LicenseShortName: { value: "CC BY 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
        },
      },
    ],
  });
  const receipt = photo?.contributors?.[0];
  if (!receipt) throw new Error("complete file receipt missing");
  const dom = document.createElement("div");
  dom.innerHTML = attributionToHtml(receipt);
  const links = [...dom.querySelectorAll("a")].filter(
    (link) => link.textContent === "Creator" || link.textContent === "permission record",
  );
  expect(links).toHaveLength(2);
  expect(links.every((link) => new URL(link.href).searchParams.get("view") === "full")).toBe(true);
});
