import { expect, it } from "vitest";
import { mergeStandaloneInventory } from "./inventory";

it("merges filesystem and database ownership without catalog availability or invented provenance", () => {
  const files = [
    {
      integrationId: "cli-installed",
      version: "1.0.0",
      contentDigest: "a".repeat(64),
      valid: true,
      denialReason: null,
    },
    {
      integrationId: "invalid-code",
      version: null,
      contentDigest: null,
      valid: false,
      denialReason: "Unsupported executable integration",
    },
  ];
  const rows = [
    {
      id: "database-only",
      installedVersion: "2.0",
      managedByExtension: "local-11111111-1111-4111-8111-111111111111",
    },
  ];
  const entries = mergeStandaloneInventory({
    files,
    integrations: rows,
    parents: [],
    components: [],
  });
  expect(entries.find((x) => x.integrationId === "cli-installed")).toMatchObject({
    ownership: "unmanaged",
    provenance: "legacy_unknown",
    adoptable: true,
    removable: true,
  });
  expect(entries.find((x) => x.integrationId === "invalid-code")).toMatchObject({
    adoptable: false,
    removable: false,
  });
  expect(entries.find((x) => x.integrationId === "database-only")).toMatchObject({
    ownership: "conflict",
    version: "2.0",
    contentDigest: null,
    adoptable: false,
    removable: false,
  });
});
it("refuses foreign or inconsistent owners and preserves catalog-owned rows", () => {
  const f = {
    integrationId: "fixture",
    version: "1.0",
    contentDigest: "b".repeat(64),
    valid: true,
    denialReason: null,
  };
  const catalog = mergeStandaloneInventory({
    files: [f],
    integrations: [{ id: "fixture", installedVersion: "1.0", managedByExtension: "catalog" }],
    parents: [{ id: "catalog", installationKind: "catalog", provenance: null }],
    components: [{ kind: "integration", componentId: "fixture", extensionId: "catalog" }],
  });
  expect(catalog[0]).toMatchObject({ ownership: "extension", adoptable: false, removable: false });
  const conflict = mergeStandaloneInventory({
    files: [f],
    integrations: [{ id: "fixture", installedVersion: "1.0", managedByExtension: "other" }],
    parents: [],
    components: [{ kind: "integration", componentId: "fixture", extensionId: "catalog" }],
  });
  expect(conflict[0]).toMatchObject({ ownership: "conflict", adoptable: false, removable: false });
});
