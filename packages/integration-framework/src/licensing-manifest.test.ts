import { describe, expect, it } from "vitest";
import { dataSourceSchema } from "./manifest";

const source = {
  sourceId: "example-data",
  name: "Example data",
  url: "https://example.test/data",
  providerCountry: "DE",
  providerPrivacyUrl: "https://example.test/privacy",
};
const licensing = {
  version: 1,
  bindings: [
    { scope: "data", subject: "Roads", license: { kind: "spdx", expression: "ODbL-1.0" } },
  ],
};

describe("one static/runtime licensing contract", () => {
  it("accepts a structured source without duplicate display identity", () => {
    const parsed = dataSourceSchema.parse({ ...source, licensing });
    expect(parsed.licensing).toEqual(licensing);
    expect(parsed).not.toHaveProperty("license");
  });

  it("rejects malformed declared metadata instead of silently stripping it", () => {
    expect(
      dataSourceSchema.safeParse({
        ...source,
        license: "ODbL-1.0",
        licensing: { version: 2, bindings: [] },
      }).success,
    ).toBe(false);
    expect(
      dataSourceSchema.safeParse({
        ...source,
        licensing: {
          ...licensing,
          bindings: [
            {
              scope: "data",
              subject: "Roads",
              license: { kind: "spdx", expression: "CC-BY-4.0 (tier conditions)" },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("requires the structured contract instead of supporting old declaration shapes", () => {
    expect(
      dataSourceSchema.safeParse({ ...source, license: "Per-file (copyright holder)" }).success,
    ).toBe(false);
  });
});

it("requires an explicit binding, including unknown, for a declared source", () => {
  expect(
    dataSourceSchema.safeParse({ ...source, licensing: { version: 1, bindings: [] } }).success,
  ).toBe(false);
});
