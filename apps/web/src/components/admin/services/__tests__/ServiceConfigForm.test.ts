import { describe, expect, it } from "vitest";
import { extractFields } from "../ServiceConfigForm";

const schema = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: true },
    region: { type: "string", title: "Region" },
    API_KEY: { type: "string", format: "password", "x-openmapx-secret": true },
    PASSWORD: { type: "string", "x-openmapx-secret": true },
  },
};

describe("ServiceConfigForm extractFields", () => {
  it("excludes x-openmapx-secret fields (they belong on the Credentials tab, not Config)", () => {
    const keys = extractFields(schema).map((f) => f.key);
    expect(keys).toContain("enabled");
    expect(keys).toContain("region");
    expect(keys).not.toContain("API_KEY");
    expect(keys).not.toContain("PASSWORD");
  });

  it("returns [] for a schema whose only fields are secrets (Config tab shows the empty state)", () => {
    const allSecret = {
      properties: {
        TOKEN: { type: "string", "x-openmapx-secret": true },
      },
    };
    expect(extractFields(allSecret)).toEqual([]);
  });

  it("returns [] for an undefined schema", () => {
    expect(extractFields(undefined)).toEqual([]);
  });
});
