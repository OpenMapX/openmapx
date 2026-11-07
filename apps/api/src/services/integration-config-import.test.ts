import { describe, expect, it } from "vitest";
import { exportIntegrationConfigs, prepareIntegrationImport } from "./integration-config-import";

const schema = {
  properties: {
    enabled: { type: "boolean" },
    label: { type: "string" },
    secret: { type: "string", "x-openmapx-secret": true },
    fixed: { type: "string", readOnly: true },
    nested: {
      type: "object",
      properties: { count: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    },
  },
};
const manifests = new Map([
  ["alpha", schema],
  ["beta", schema],
]);
const input = (config: Record<string, unknown> = { label: "new" }) => ({
  integrations: [{ integrationId: "alpha", config }],
});

describe("integration import preparation", () => {
  it.each([
    null,
    {},
    { integrations: [] },
    { integrations: [{ integrationId: "alpha", config: null }] },
    { integrations: [{ integrationId: "unknown", config: {} }] },
    { integrations: [...input().integrations, ...input().integrations] },
    input({ enabled: "false" }),
    input({ fixed: "x" }),
    input({ unknown: true }),
    input({ label: "***" }),
    input({ nested: { count: 0 } }),
  ])("rejects the entire invalid file before persistence: %j", (body) => {
    expect(() => prepareIntegrationImport(body, manifests)).toThrow("Invalid integration import");
  });
  it("bounds diagnostics and never echoes unknown keys, values or schema choice contents", () => {
    const schemas = new Map([
      ["alpha", { properties: { choice: { type: "string", enum: ["internal-schema-marker"] } } }],
    ]);
    try {
      prepareIntegrationImport(
        {
          integrations: [
            {
              integrationId: "alpha",
              config: { choice: "supplied-secret", "unknown-secret-name": "another-secret" },
            },
            ...Array.from({ length: 20 }, (_, index) => ({
              integrationId: `unknown-${index}`,
              config: {},
            })),
          ],
        },
        schemas,
      );
      throw Error("Expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const diagnostics = (error as { errors: string[] }).errors;
      expect(diagnostics).toHaveLength(8);
      expect(diagnostics[0]).toMatch(/Entry 1.*alpha.*choice.*allowed-choice constraint/);
      expect(diagnostics.every((entry) => entry.length <= 512)).toBe(true);
      expect(JSON.stringify(diagnostics)).not.toMatch(
        /internal-schema-marker|supplied-secret|unknown-secret-name|another-secret/,
      );
    }
  });
  it("omits declared secrets and preserves optional enabled and valid nested JSON", () => {
    expect(
      prepareIntegrationImport(
        input({ secret: "synthetic", enabled: false, nested: { count: 2 } }),
        manifests,
      ),
    ).toEqual([{ integrationId: "alpha", config: { enabled: false, nested: { count: 2 } } }]);
    expect(prepareIntegrationImport(input({}), manifests)[0].config).not.toHaveProperty("enabled");
  });
  it("exports only current writable nonsecret fields and round trips its metadata", () => {
    const exported = exportIntegrationConfigs(
      [
        {
          integrationId: "alpha",
          config: {
            label: "safe",
            secret: "synthetic",
            fixed: "x",
            retired: "old",
            enabled: false,
          },
        },
        { integrationId: "retired", config: { secret: "synthetic" } },
      ],
      manifests,
    );
    expect(exported.integrations).toEqual([
      { integrationId: "alpha", config: { label: "safe", enabled: false } },
    ]);
    expect(prepareIntegrationImport(exported, manifests)).toEqual(exported.integrations);
    expect(JSON.stringify(exported)).not.toContain("synthetic");
  });
});
