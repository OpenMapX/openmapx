import { describe, expect, it } from "vitest";
import { dataSourceSchema } from "../manifest.js";

const base = {
  name: "x",
  url: "https://x",
  license: "L",
  providerCountry: "DE",
  providerPrivacyUrl: "https://x/p",
};

describe("dataSourceSchema.sourceId", () => {
  it("accepts a region-first id", () => {
    expect(dataSourceSchema.safeParse({ ...base, sourceId: "de-by-bamberg" }).success).toBe(true);
  });

  it("rejects an uppercase/underscore id", () => {
    expect(dataSourceSchema.safeParse({ ...base, sourceId: "Bamberg_DE" }).success).toBe(false);
  });
});
