import { describe, expect, it } from "vitest";
import { validateDataSource, validateManifest } from "./integration";

const source = {
  sourceId: "example-feed",
  name: "Example publisher",
  url: "https://example.test/",
  providerCountry: "DE",
  providerPrivacyUrl: "https://example.test/privacy",
  licensing: {
    version: 1,
    bindings: [
      { scope: "data", subject: "Readings", license: { kind: "spdx", expression: "CC-BY-4.0" } },
    ],
  },
};
const manifest = (dataSource: Record<string, unknown>) => ({
  id: "example",
  domains: ["weather"],
  dataSources: [dataSource],
});

describe("manifest data sources", () => {
  it("accepts the credit text under the field the host reads", () => {
    expect(validateManifest(manifest({ ...source, attribution: "© Example" }))).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("refuses a key the host does not read", () => {
    expect(validateManifest(manifest({ ...source, attributionText: "© Example" }))).toEqual({
      valid: false,
      errors: ['dataSources.0: Unrecognized key: "attributionText"'],
    });
  });

  it("leaves sources supplied at runtime to the stripping validator", () => {
    const result = validateDataSource({ ...source, attributionText: "© Example" }, ["weather"]);
    expect(result.valid).toBe(true);
    expect(result.valid && result.dataSource).not.toHaveProperty("attributionText");
  });
});
