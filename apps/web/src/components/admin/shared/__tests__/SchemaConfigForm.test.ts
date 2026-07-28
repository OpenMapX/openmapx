import { describe, expect, it } from "vitest";
import { buildConfigDiff, extractConfigFields } from "../SchemaConfigForm";

const schema = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: true },
    region: { type: "string", title: "Region" },
    timeout: { type: "integer", default: 30 },
    providers: { type: "array", default: [{ id: "keyword", type: "keyword" }] },
    API_KEY: { type: "string", format: "password", "x-openmapx-secret": true },
    PASSWORD: { type: "string", "x-openmapx-secret": true },
  },
};

describe("extractConfigFields", () => {
  it("excludes x-openmapx-secret fields (they belong on the Credentials tab)", () => {
    const keys = extractConfigFields(schema).map((f) => f.key);
    expect(keys).toContain("region");
    expect(keys).toContain("timeout");
    expect(keys).toContain("enabled");
    expect(keys).toContain("providers");
    expect(keys).not.toContain("API_KEY");
    expect(keys).not.toContain("PASSWORD");
  });

  it("honors excludeKeys (e.g. integration's dedicated `enabled` toggle)", () => {
    const keys = extractConfigFields(schema, ["enabled"]).map((f) => f.key);
    expect(keys).not.toContain("enabled");
    expect(keys).toContain("region");
  });

  it("returns [] when only secrets remain", () => {
    const allSecret = { properties: { TOKEN: { type: "string", "x-openmapx-secret": true } } };
    expect(extractConfigFields(allSecret)).toEqual([]);
  });

  it("returns [] for an undefined schema", () => {
    expect(extractConfigFields(undefined)).toEqual([]);
  });

  it("derives a humanized title when none is given", () => {
    const fields = extractConfigFields({ properties: { maxRetries: { type: "integer" } } });
    expect(fields[0]?.title).toBe("Max Retries");
  });

  it("preserves structured field metadata for the JSON editor", () => {
    const field = extractConfigFields(schema).find((candidate) => candidate.key === "providers");
    expect(field).toMatchObject({
      type: "array",
      default: [{ id: "keyword", type: "keyword" }],
    });
  });
});

describe("buildConfigDiff", () => {
  const fields = extractConfigFields(schema);

  it("parses structured JSON while preserving scalar types", () => {
    expect(
      buildConfigDiff(
        fields,
        {
          providers: '[{"id":"gemini","type":"google","model":"gemini-2.5-flash"}]',
          timeout: 45,
        },
        ["providers", "timeout"],
      ),
    ).toEqual({
      providers: [{ id: "gemini", type: "google", model: "gemini-2.5-flash" }],
      timeout: 45,
    });
  });

  it("rejects malformed structured JSON before calling the API", () => {
    expect(() => buildConfigDiff(fields, { providers: "not-json" }, ["providers"])).toThrow(
      "Providers must be valid JSON",
    );
  });
});
