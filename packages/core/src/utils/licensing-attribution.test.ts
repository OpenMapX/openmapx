import { describe, expect, it } from "vitest";
import { buildAttributionPresentation, buildRuntimeAttributionHtml } from "./attribution";

describe("scoped licence attribution presentation", () => {
  it("renders all content choices and preserves captured notices without software-as-data credit", () => {
    const licensing = {
      version: 1 as const,
      bindings: [
        {
          scope: "software" as const,
          subject: "Engine",
          license: { kind: "spdx" as const, expression: "MIT" },
        },
        {
          scope: "data" as const,
          subject: "Weather",
          license: { kind: "spdx" as const, expression: "CC-BY-4.0 OR NLOD-2.0" },
          notice: "Original <publisher>",
          conditions: ["Preserve observation date"],
        },
      ],
    };
    const html = buildRuntimeAttributionHtml({ sourceId: "weather", name: "Weather", licensing });
    expect(html).toContain("CC-BY-4.0 OR NLOD-2.0");
    expect(html).toContain("creativecommons.org");
    expect(html).toContain("data.norge.no");
    expect(html).toContain("Original &lt;publisher&gt;");
    expect(html).toContain("Preserve observation date");
    expect(html).not.toContain("MIT");
  });
});

it("retains every atom link even when a compound grant includes its publisher's declaration URL", () => {
  const html = buildRuntimeAttributionHtml({
    sourceId: "weather",
    name: "Weather",
    licensing: {
      version: 1,
      bindings: [
        {
          scope: "data",
          subject: "Weather",
          license: {
            kind: "spdx",
            expression: "CC-BY-4.0 OR NLOD-2.0",
            url: "https://example.test/licences",
          },
        },
      ],
    },
  });
  expect(html).toContain("https://example.test/licences");
  expect(html).toContain("creativecommons.org");
  expect(html).toContain("data.norge.no");
});

describe("placement-aware complete and visible credits", () => {
  it("moves eligible full notices into details while retaining every scoped subject", () => {
    const attr = {
      sourceId: "weather",
      name: "Weather",
      attributionText: "Required original provider notice",
      notes: "Changed format only",
      licensing: {
        version: 1 as const,
        bindings: [
          {
            scope: "software" as const,
            subject: "Engine",
            license: { kind: "spdx" as const, expression: "MIT" },
          },
          {
            scope: "data" as const,
            subject: "Dataset",
            license: { kind: "spdx" as const, expression: "CC-BY-4.0" },
            notice: "© Original author",
            conditions: ["Preserve observation date"],
          },
        ],
      },
    };
    const credit = buildAttributionPresentation(attr, "map");
    expect(credit.visibleHtml).toBe("");
    expect(credit.fullHtml).toContain("Required original provider notice");
    expect(credit.fullHtml).toContain("MIT");
    expect(credit.fullHtml).toContain("© Original author");
    expect(credit.fullHtml).toContain("Preserve observation date");
    expect(credit.fullHtml).toContain("Changed format only");
  });
  it("keeps unknown source wording visible and does not inherit its sibling software licence", () => {
    const attr = {
      sourceId: "unknown",
      name: "Unknown",
      attributionText: 'Exact <a href="https://source.test/">source notice</a>',
      licensing: {
        version: 1 as const,
        bindings: [
          {
            scope: "software" as const,
            subject: "Client",
            license: { kind: "spdx" as const, expression: "MIT" },
          },
          { scope: "data" as const, subject: "Result", license: { kind: "unknown" as const } },
        ],
      },
    };
    expect(buildAttributionPresentation(attr, "map").visibleHtml).toContain("Exact");
    expect(buildAttributionPresentation(attr, "map").visibleHtml).toContain(
      'href="https://source.test/"',
    );
  });
  it("uses only a certified minimal provider notice and preserves the full original separately", () => {
    const attr = {
      sourceId: "provider",
      name: "Provider",
      attributionText: "Long complete required disclaimer",
      licensing: {
        version: 1 as const,
        bindings: [
          {
            scope: "data" as const,
            subject: "Data",
            license: { kind: "spdx" as const, expression: "CC-BY-4.0" },
            attribution: {
              placement: "visible" as const,
              surfaces: ["map" as const],
              basis: "provider-terms" as const,
              reviewedAt: "2026-10-14",
              evidenceUrls: ["https://provider.test/terms"],
              reason: "Visible linked name; full disclaimer may be in details",
              compactText:
                '<a href="https://provider.test/">Provider</a><img src=x onerror=alert(1)>',
              logo: "openweather" as const,
            },
          },
        ],
      },
    };
    const credit = buildAttributionPresentation(attr, "map");
    expect(credit.visibleHtml).toContain('href="https://provider.test/"');
    expect(credit.visibleHtml).not.toContain("onerror");
    expect(credit.visibleHtml).not.toContain("Long complete");
    expect(credit.fullHtml).toContain("Long complete required disclaimer");
    expect(credit.logos).toEqual(["openweather"]);
  });
  it("does not let one compact override abbreviate another unresolved binding", () => {
    const attr = {
      sourceId: "mixed",
      name: "Mixed",
      attributionText: "Required unknown original wording",
      licensing: {
        version: 1 as const,
        bindings: [
          { scope: "data" as const, subject: "Data", license: { kind: "unknown" as const } },
          {
            scope: "service" as const,
            subject: "API",
            license: { kind: "unknown" as const },
            attribution: {
              placement: "visible" as const,
              surfaces: ["map" as const],
              basis: "provider-terms" as const,
              reviewedAt: "2026-10-14",
              evidenceUrls: ["https://provider.test/terms"],
              reason: "API name required",
              compactText: "API",
            },
          },
        ],
      },
    };
    expect(buildAttributionPresentation(attr, "map").visibleHtml).toContain(
      "Required unknown original wording",
    );
    expect(buildAttributionPresentation(attr, "map").visibleHtml).toContain("API");
  });
  it("retains the full visible notice when compact markup sanitizes to nothing", () => {
    const credit = buildAttributionPresentation(
      {
        sourceId: "provider",
        name: "Provider",
        attributionText: "Required notice",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "Dataset",
              license: { kind: "unknown" },
              attribution: {
                placement: "visible",
                surfaces: ["map"],
                basis: "provider-terms",
                reviewedAt: "2026-10-14",
                evidenceUrls: ["https://provider.test/terms"],
                reason: "Reviewed minimum",
                compactText: '<img src="x">',
              },
            },
          ],
        },
      },
      "map",
    );
    expect(credit.visibleHtml).toContain("Required notice");
  });

  it("keeps the actual issuing publisher beside a provider-required compact notice", () => {
    const credit = buildAttributionPresentation(
      {
        sourceId: "meteoalarm",
        name: "MeteoAlarm",
        publisher: { name: "Actual NMHS <issuer>" },
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "Warnings",
              license: { kind: "spdx", expression: "CC-BY-4.0" },
              attribution: {
                placement: "visible",
                surfaces: ["map"],
                basis: "provider-terms",
                reviewedAt: "2026-10-14",
                evidenceUrls: ["https://meteoalarm.org/terms"],
                reason: "National issuer required",
                compactText: "MeteoAlarm",
                includePublisher: true,
              },
            },
          ],
        },
      },
      "map",
    );
    expect(credit.visibleHtml).toContain("Actual NMHS &lt;issuer&gt;");
  });
});

it("removes credentials from compact and complete attribution links while retaining their labels", () => {
  const bad = "https://user:password@provider.test/?api_key=secret";
  const value = {
    sourceId: "provider",
    name: "Provider",
    attributionText: `<a href="${bad}">Original notice</a>`,
    licensing: {
      version: 1 as const,
      bindings: [
        {
          scope: "service" as const,
          subject: "API",
          license: { kind: "unknown" as const },
          attribution: {
            placement: "visible" as const,
            surfaces: ["map" as const],
            basis: "provider-terms" as const,
            reviewedAt: "2026-10-14",
            evidenceUrls: ["https://provider.test/terms"],
            reason: "Provider linked minimum",
            compactText: `<a href="${bad}">Provider</a>`,
          },
        },
      ],
    },
  };
  const projected = buildAttributionPresentation(value, "map");
  expect(projected.visibleHtml).toBe("Provider");
  expect(projected.fullHtml).toContain("Original notice");
  expect(projected.fullHtml).not.toContain("password");
  expect(projected.fullHtml).not.toContain("api_key");
});

it("keeps captured source identity and its own URL alongside a disclaimer-only notice in details", () => {
  const result = buildAttributionPresentation(
    {
      sourceId: "dataset",
      name: "Dataset publisher",
      url: "https://dataset.test/source",
      attributionText:
        'Required disclaimer — <a href="https://other.test/notice">Other publisher</a>',
      licensing: {
        version: 1,
        bindings: [
          { scope: "data", subject: "Dataset", license: { kind: "spdx", expression: "CC-BY-4.0" } },
        ],
      },
    },
    "map",
  );
  expect(result.visibleHtml).toBe("");
  expect(result.fullHtml).toContain('href="https://dataset.test/source"');
  expect(result.fullHtml).toContain("Dataset publisher");
  expect(result.fullHtml).toContain("Required disclaimer");
  expect(result.fullHtml).toContain('href="https://other.test/notice"');
});

it("cannot certify an empty linked compact notice as visible text", () => {
  const attr = {
    sourceId: "supplier",
    name: "Supplier",
    attributionText: "Prescribed notice",
    licensing: {
      version: 1 as const,
      bindings: [
        {
          scope: "service" as const,
          subject: "API",
          license: { kind: "unknown" as const },
          attribution: {
            placement: "visible" as const,
            surfaces: ["map" as const],
            basis: "provider-terms" as const,
            reviewedAt: "2026-10-14",
            evidenceUrls: ["https://supplier.test/terms"],
            reason: "Minimum",
            compactText: '<a href="https://supplier.test/"></a>',
          },
        },
      ],
    },
  };
  expect(buildAttributionPresentation(attr, "map").visibleHtml).toContain("Prescribed notice");
});
