import { buildAttributionHtml } from "@openmapx/core";
import {
  dataSourceToAttribution,
  type IntegrationDataSource,
} from "@openmapx/integration-framework";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { describe, expect, it } from "vitest";
import { attributionToHtml } from "./useMapAttributions";

/**
 * Legal metadata and captured runtime receipts share the same safe HTML path.
 * Acquisition converts only the actual supplier through `dataSourceToAttribution`;
 * `attributionToHtml` must retain its full notice, licence and safe links.
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
    licensing: licensingFromDeclaration(
      "CC BY 4.0 (varies per source)",
      "https://docs.openaq.org/resources/licenses",
    ),
    ...COMPLIANCE_FIELDS,
  },
];

describe("attributionToHtml", () => {
  it("credits the license alongside the publisher", () => {
    const html = attributionToHtml(dataSourceToAttribution(MANIFEST_SOURCES[0]));
    expect(html).toContain("OpenAQ");
    expect(html).toContain("CC BY 4.0 (varies per source)");
    expect(html).toContain('href="https://docs.openaq.org/resources/licenses"');
  });

  it("preserves copyright wording outside the anchor and renders its declared grant", () => {
    const html = attributionToHtml({
      sourceId: "openstreetmap",
      name: "© OpenStreetMap contributors",
      url: "https://www.openstreetmap.org/copyright",
      licensing: licensingFromDeclaration("ODbL-1.0"),
    });
    expect(html).toContain('© <a href="https://www.openstreetmap.org/copyright"');
    expect(html).toContain("ODbL-1.0");
  });

  it("dedups against the manifest form of the same credit", () => {
    const fromBase = attributionToHtml({
      sourceId: "openstreetmap",
      name: "© OpenStreetMap contributors",
      url: "https://www.openstreetmap.org/copyright",
      licensing: licensingFromDeclaration("ODbL-1.0"),
    });
    const fromManifest = buildAttributionHtml({
      name: "OpenStreetMap",
      url: "https://www.openstreetmap.org",
      licensing: licensingFromDeclaration("ODbL-1.0", undefined),
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    });
    expect(fromManifest).toBe(fromBase);
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
  ).toBe("CC-BY-4.0");
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
