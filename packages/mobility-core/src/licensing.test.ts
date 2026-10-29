import { describe, expect, it } from "vitest";
import {
  canonicalLicenseExpression,
  dataLicenseExpression,
  formatLicensing,
  licensingFromDeclaration,
  licensingLinks,
  parseLicensing,
} from "./licensing.js";

const routeLicensing = {
  version: 1,
  bindings: [
    { scope: "software", subject: "Valhalla engine", license: { kind: "spdx", expression: "MIT" } },
    { scope: "data", subject: "OSM road data", license: { kind: "spdx", expression: "ODbL-1.0" } },
  ],
} as const;

describe("canonical licence expressions", () => {
  it("preserves choices, simultaneous obligations, exceptions and versions", () => {
    expect(
      canonicalLicenseExpression(
        "(mit OR Apache-2.0) AND LGPL-3.0-or-later WITH Classpath-exception-2.0",
      ),
    ).toBe("(MIT OR Apache-2.0) AND LGPL-3.0-or-later WITH Classpath-exception-2.0");
    expect(canonicalLicenseExpression("CC-BY-SA-3.0-DE OR CC-BY-SA-4.0")).toBe(
      "CC-BY-SA-3.0-DE OR CC-BY-SA-4.0",
    );
  });

  it("rejects prose, incomplete choices, unknown grants and undefined custom references", () => {
    for (const raw of [
      "MIT (software); CC-BY-4.0 (data)",
      "MIT OR",
      "ODbL-2.0",
      "LicenseRef-Proprietary",
      "CC-BY-4.0 / NLOD-2.0",
      "MIT WITH Unknown-exception",
    ]) {
      expect(canonicalLicenseExpression(raw)).toBeUndefined();
    }
  });
});

describe("portable licensing", () => {
  it("copies captured custom definitions and notices without consulting mutable registries", () => {
    const raw = {
      version: 1,
      bindings: [
        {
          scope: "service",
          subject: "Provider API",
          license: {
            kind: "custom",
            namespace: "extension:one",
            id: "LicenseRef-API",
            name: "Captured API terms",
            url: "https://example.test/terms/v1",
            version: "v1",
          },
          notice: "Required publisher notice",
          conditions: ["Preserve the logo"],
        },
      ],
    };
    const captured = parseLicensing(raw)!;
    raw.bindings[0].license.name = "Later registry revision";
    raw.bindings[0].conditions.push("Later condition");
    expect(captured.bindings[0].license).toMatchObject({
      namespace: "extension:one",
      name: "Captured API terms",
      version: "v1",
    });
    expect(captured.bindings[0].conditions).toEqual(["Preserve the logo"]);
    expect(captured.bindings[0].notice).toBe("Required publisher notice");
  });

  it("validates the whole receipt rather than dropping malformed binding fields", () => {
    for (const raw of [
      { version: 2, bindings: [] },
      {
        version: 1,
        bindings: [
          {
            scope: "data",
            subject: "Roads",
            license: { kind: "spdx", expression: "CC-BY-4.0 (free tier)" },
          },
        ],
      },
      {
        version: 1,
        bindings: [
          {
            scope: "data",
            subject: "Roads",
            license: { kind: "custom", id: "LicenseRef-API", name: "API" },
          },
        ],
      },
      {
        version: 1,
        bindings: [
          {
            scope: "data",
            subject: "Roads",
            license: { kind: "spdx", expression: "MIT", url: "javascript:alert(1)" },
          },
        ],
      },
      {
        version: 1,
        bindings: [
          {
            scope: "data",
            subject: "Roads",
            license: { kind: "spdx", expression: "MIT" },
            callback: "run",
          },
        ],
      },
    ])
      expect(parseLicensing(raw)).toBeUndefined();
    expect(parseLicensing({ version: 1, bindings: [] })).toEqual({ version: 1, bindings: [] });
  });

  it("keeps unknown, per-item, public-domain and public-domain-marker states distinct", () => {
    const states = parseLicensing({
      version: 1,
      bindings: [
        {
          scope: "data",
          subject: "Unknown feed",
          license: { kind: "unknown", raw: "Provider licensing pending" },
        },
        { scope: "imagery", subject: "Photos", license: { kind: "per-item", raw: "Per-file" } },
        {
          scope: "data",
          subject: "Federal data",
          license: { kind: "public-domain", name: "U.S. government works" },
        },
        { scope: "imagery", subject: "Photo", license: { kind: "status", id: "CC-PDM-1.0" } },
        {
          scope: "imagery",
          subject: "Waived photo",
          license: { kind: "spdx", expression: "CC0-1.0" },
        },
      ],
    })!;
    expect(states.bindings.map((b) => b.license.kind)).toEqual([
      "unknown",
      "per-item",
      "public-domain",
      "status",
      "spdx",
    ]);
    expect(dataLicenseExpression(states)).toBeUndefined();
  });
});

describe("shared licence presentation", () => {
  it("projects the data grant separately from the engine licence", () => {
    const captured = parseLicensing(routeLicensing)!;
    expect(dataLicenseExpression(captured)).toBe("ODbL-1.0");
    expect(formatLicensing(captured, { scopes: ["data"] })).toBe("ODbL-1.0");
    expect(formatLicensing(captured, { fullNames: true, scopes: ["software"] })).toBe(
      "MIT License",
    );
    expect(formatLicensing(captured)).toContain("Valhalla engine");
    expect(formatLicensing(captured)).toContain("OSM road data");
  });

  it("preserves all links and the choice without linking a composite only to its first grant", () => {
    const captured = parseLicensing({
      version: 1,
      bindings: [
        {
          scope: "data",
          subject: "Weather",
          license: { kind: "spdx", expression: "CC-BY-4.0 OR NLOD-2.0" },
        },
      ],
    })!;
    const [shown] = licensingLinks(captured);
    expect(shown.label).toBe("CC-BY-4.0 OR NLOD-2.0");
    expect(shown.url).toBeUndefined();
    expect(shown.licenses?.map((l) => l.label)).toEqual(["CC-BY-4.0", "NLOD-2.0"]);
    expect(shown.licenses?.every((l) => l.url && /^https?:\/\//.test(l.url))).toBe(true);
  });

  it("preserves an explicit supplied licence link and custom title", () => {
    const captured = parseLicensing({
      version: 1,
      bindings: [
        {
          scope: "data",
          subject: "Dataset",
          license: {
            kind: "custom",
            namespace: "publisher:a",
            id: "LicenseRef-Data",
            name: "Dataset terms",
            url: "https://example.test/data/terms",
          },
        },
      ],
    })!;
    expect(licensingLinks(captured)[0]).toMatchObject({
      label: "Dataset terms",
      url: "https://example.test/data/terms",
    });
  });
});

describe("conservative upstream declaration acquisition", () => {
  it("recognizes only exact versioned aliases and preserves ambiguous declarations", () => {
    expect(
      dataLicenseExpression(
        licensingFromDeclaration("Datenlizenz Deutschland – Zero – Version 2.0"),
      ),
    ).toBe("DL-DE-ZERO-2.0");
    expect(
      licensingFromDeclaration("MIT (software); CC BY 4.0 (data)").bindings[0].license,
    ).toEqual({
      kind: "unknown",
      raw: "MIT (software); CC BY 4.0 (data)",
    });
    expect(licensingFromDeclaration("ODbL 2.0").bindings[0].license.kind).toBe("unknown");
    expect(licensingFromDeclaration("Per-file (copyright holder)").bindings[0].license.kind).toBe(
      "per-item",
    );
  });
});

it("keeps original declarations as evidence while deriving canonical display identity", () => {
  const url = "https://creativecommons.org/licenses/by-sa/4.0/";
  expect(licensingFromDeclaration("CC BY-SA 4.0", url).declarations).toEqual([
    { text: "CC BY-SA 4.0", url },
  ]);
});

it("recognizes a pure declared standard expression without interpreting prose composites", () => {
  expect(licensingFromDeclaration("CC-BY-4.0 OR NLOD-2.0").bindings[0].license).toEqual({
    kind: "spdx",
    expression: "CC-BY-4.0 OR NLOD-2.0",
  });
});
