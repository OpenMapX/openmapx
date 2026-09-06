import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@openmapx/core/server", () => ({
  findRepoRoot: () => "/repo",
}));
vi.mock("../service-registry", () => ({
  getServiceRegistry: () => ({ list: () => [] }),
}));

const {
  ADMIN_OPERATIONS,
  describeAdminOperationCatalog,
  getAdminOperation,
  parseAdminOperationInput,
  validateAdminOperationCatalog,
} = await import("../admin-operation-catalog");
type AnyAdminOperationDefinition = (typeof ADMIN_OPERATIONS)[number];

function definition(
  overrides: Partial<AnyAdminOperationDefinition> = {},
): AnyAdminOperationDefinition {
  return {
    id: "download-fonts",
    version: 1,
    group: "build",
    title: "Fixture",
    description: "Fixture operation",
    risk: "normal",
    input: z.strictObject({}),
    fields: [],
    defaults: {},
    effect: () => ({ kind: "data.downloadFonts" }),
    preview: () => ["Download fonts"],
    ...overrides,
  } as AnyAdminOperationDefinition;
}

describe("validateAdminOperationCatalog", () => {
  it("accepts the shipped catalog", () => {
    expect(() => validateAdminOperationCatalog()).not.toThrow();
    expect(ADMIN_OPERATIONS.map((definition) => definition.id)).toEqual([
      "download-osm",
      "download-fonts",
      "update",
      "convert-overpass",
      "link",
      "clean",
      "generate-api-keys",
      "overture-sync",
      "overture-conflate",
      "search-index-build",
    ]);
  });

  it("rejects duplicate ids", () => {
    expect(() => validateAdminOperationCatalog([definition(), definition()])).toThrow(/duplicate/i);
  });

  it("rejects a form field the schema does not know", () => {
    const drifted = definition({
      fields: [{ name: "region", label: "Region", kind: "text" }],
    });
    expect(() => validateAdminOperationCatalog([drifted])).toThrow(/region/);
  });

  it("rejects a schema key without a form field", () => {
    const drifted = definition({
      input: z.strictObject({ region: z.string().optional() }),
    });
    expect(() => validateAdminOperationCatalog([drifted])).toThrow(/region/);
  });

  it("requires confirmation copy on destructive operations", () => {
    expect(() => validateAdminOperationCatalog([definition({ risk: "destructive" })])).toThrow(
      /confirmation/i,
    );
  });

  it("requires select fields to offer options", () => {
    const drifted = definition({
      input: z.strictObject({ target: z.string() }),
      fields: [{ name: "target", label: "Target", kind: "select" }],
    });
    expect(() => validateAdminOperationCatalog([drifted])).toThrow(/options/i);
  });

  it("rejects an effect outside the data operation family", () => {
    const drifted = definition({
      effect: () => ({ kind: "service.stop", serviceId: "valhalla" }),
    });
    expect(() => validateAdminOperationCatalog([drifted])).toThrow(/data\./);
  });

  it("rejects an invalid version", () => {
    expect(() => validateAdminOperationCatalog([definition({ version: 0 })])).toThrow(/version/);
  });
});

describe("shipped operation effects", () => {
  it.each([
    ["download-osm", {}, { kind: "data.downloadOsm" }],
    [
      "download-osm",
      { region: "europe/germany" },
      { kind: "data.downloadOsm", regionId: "europe/germany" },
    ],
    ["download-fonts", {}, { kind: "data.downloadFonts" }],
    [
      "update",
      { region: "europe/germany", countries: "de, at", failFast: true },
      {
        kind: "data.update",
        regionId: "europe/germany",
        countryCodes: ["DE", "AT"],
        failFast: true,
      },
    ],
    ["update", { region: "", countries: "", failFast: false }, { kind: "data.update" }],
    [
      "convert-overpass",
      { region: "germany" },
      { kind: "data.convertOverpass", regionId: "germany" },
    ],
    ["link", {}, { kind: "data.link" }],
    ["clean", { target: "osm" }, { kind: "data.clean", dataTypeId: "osm" }],
    [
      "generate-api-keys",
      {},
      { kind: "data.generateApiKeys", catalogRevisionId: "transitous-fixed-v1" },
    ],
    [
      "overture-sync",
      { region: "europe/germany" },
      { kind: "data.overtureSync", regionId: "europe/germany" },
    ],
    [
      "overture-conflate",
      { region: "europe/germany", restart: true },
      { kind: "data.overtureConflate", regionId: "europe/germany", restart: true },
    ],
    [
      "overture-conflate",
      { region: "europe/germany" },
      { kind: "data.overtureConflate", regionId: "europe/germany" },
    ],
    [
      "search-index-build",
      { region: "europe/germany" },
      { kind: "data.searchIndexBuild", regionId: "europe/germany" },
    ],
  ])("%s maps %j to a typed agent operation", (id, raw, expected) => {
    const operation = getAdminOperation(id);
    if (!operation) throw new Error(`missing ${id}`);
    const parsed = parseAdminOperationInput(operation, raw);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(operation.effect(parsed.input)).toEqual(expected);
    expect(operation.preview(parsed.input).length).toBeGreaterThan(0);
  });

  it.each([
    ["clean", {}],
    ["clean", { target: "--all" }],
    ["overture-sync", {}],
    ["overture-sync", { region: "../etc" }],
    ["search-index-build", { region: "Europe/Germany" }],
    ["download-fonts", { region: "europe/germany" }],
    ["generate-api-keys", { repoUrl: "https://attacker.example", output: "/etc/passwd" }],
    ["update", { region: "europe/germany", argv: ["--privileged"] }],
  ])("%s rejects %j", (id, raw) => {
    const operation = getAdminOperation(id);
    if (!operation) throw new Error(`missing ${id}`);
    const parsed = parseAdminOperationInput(operation, raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("marks cleanup as destructive with confirmation copy", () => {
    const clean = getAdminOperation("clean");
    expect(clean?.risk).toBe("destructive");
    expect(clean?.confirmation?.message).toMatch(/remove/i);
  });
});

describe("describeAdminOperationCatalog", () => {
  it("publishes only the browser contract", () => {
    const contract = describeAdminOperationCatalog();
    expect(contract).toHaveLength(ADMIN_OPERATIONS.length);
    for (const entry of contract) {
      expect(entry).not.toHaveProperty("effect");
      expect(entry).not.toHaveProperty("input");
      expect(entry).not.toHaveProperty("preview");
      expect(entry).not.toHaveProperty("audit");
      expect(typeof entry.version).toBe("number");
    }
    const update = contract.find((entry) => entry.id === "update");
    expect(update?.fields.map((field) => field.name)).toEqual(["region", "countries", "failFast"]);
    expect(update?.defaults).toEqual({ region: "", countries: "", failFast: false });
    const clean = contract.find((entry) => entry.id === "clean");
    expect(clean?.defaults).toEqual({ target: "all" });
  });
});
