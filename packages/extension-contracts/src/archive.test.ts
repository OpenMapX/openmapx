import { describe, expect, it } from "vitest";
import { integrationArchiveEntryKind, migrationSequenceProblem } from "./archive";
import { EXTENSION_SCHEMA_PATTERN, extensionSchemaName } from "./identifiers";

describe("integration archive layout", () => {
  it("classifies the archive's code, data and asset paths", () => {
    expect(integrationArchiveEntryKind("dist/backend/index.mjs")).toBe("backend-entry");
    expect(integrationArchiveEntryKind("dist/web/index.mjs")).toBe("web-entry");
    expect(integrationArchiveEntryKind("migrations/0001_create_reports.sql")).toBe("migration");
    expect(integrationArchiveEntryKind("messages/pt-br.json")).toBe("message");
    expect(integrationArchiveEntryKind("assets/icons/pin.svg")).toBe("asset");
    expect(integrationArchiveEntryKind(`assets/${"d/".repeat(7)}pin.svg`)).toBe("asset");
    for (const path of [
      "dist/backend/chunk.mjs",
      "migrations/1_x.sql",
      "migrations/0001_X.sql",
      "migrations/0001_a__b.sql",
      "messages/en.yaml",
      "assets/",
      "assets/../manifest.json",
      "assets/a b.png",
      "assets/.hidden",
      `assets/${"d/".repeat(8)}pin.svg`,
      `assets/${"a".repeat(101)}.png`,
      "strings/en.json",
    ])
      expect(integrationArchiveEntryKind(path), path).toBeNull();
  });
  it("requires migrations numbered from 0001 without gaps", () => {
    expect(migrationSequenceProblem([])).toBeNull();
    expect(migrationSequenceProblem(["0002_b.sql", "0001_a.sql"])).toBeNull();
    expect(migrationSequenceProblem(["0001_a.sql", "0003_c.sql"])).toContain(
      "expected 0002, found 0003",
    );
    expect(migrationSequenceProblem(["0002_b.sql"])).toContain("expected 0001, found 0002");
    expect(migrationSequenceProblem(["0001_a.sql", "0001_b.sql"])).toContain(
      "expected 0002, found 0001",
    );
    expect(migrationSequenceProblem(["create.sql"])).toBe(
      '"create.sql" is not a migration file name',
    );
  });
  it("maps an integration id to its schema name", () => {
    expect(extensionSchemaName("demo-overlay")).toBe("ext_demo_overlay");
    const longest = `${"a".repeat(23)}-${"b".repeat(24)}`;
    expect(extensionSchemaName(longest)).toHaveLength(52);
    expect(extensionSchemaName(longest)).toMatch(EXTENSION_SCHEMA_PATTERN);
    for (const id of ["Demo", "demo_overlay", "", "a".repeat(49), "demo--x"])
      expect(() => extensionSchemaName(id)).toThrow("Invalid integration id");
  });
});
