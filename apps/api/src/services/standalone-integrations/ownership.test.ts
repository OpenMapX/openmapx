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
  const rows = [{ id: "database-only", installedVersion: "2.0" }];
  const entries = mergeStandaloneInventory({
    files,
    integrations: rows,
    parents: [],
    components: [],
  });
  expect(entries.find((x) => x.integrationId === "cli-installed")).toMatchObject({
    ownership: "unmanaged",
    extensionId: null,
    provenance: null,
    removable: true,
  });
  expect(entries.find((x) => x.integrationId === "cli-installed")).not.toHaveProperty("adoptable");
  expect(entries.find((x) => x.integrationId === "invalid-code")).toMatchObject({
    removable: false,
  });
  expect(entries.find((x) => x.integrationId === "database-only")).toMatchObject({
    ownership: "conflict",
    version: "2.0",
    contentDigest: null,
    removable: false,
  });
});
it("resolves the owner from the component link alone", () => {
  const f = {
    integrationId: "fixture",
    version: "1.0",
    contentDigest: "c".repeat(64),
    valid: true,
    denialReason: null,
  };
  const parentId = "local-11111111-1111-4111-8111-111111111111";
  const [owned] = mergeStandaloneInventory({
    files: [f],
    integrations: [{ id: "fixture", installedVersion: "1.0" }],
    parents: [{ id: parentId, installationKind: "standalone", provenance: { kind: "source" } }],
    components: [{ kind: "integration", componentId: "fixture", extensionId: parentId }],
  });
  expect(owned).toMatchObject({
    ownership: "standalone",
    extensionId: parentId,
    provenance: "source",
    removable: true,
    denialReason: null,
  });
  // Without a component link the same row and parent are not an owner record.
  const [unlinked] = mergeStandaloneInventory({
    files: [f],
    integrations: [{ id: "fixture", installedVersion: "1.0" }],
    parents: [{ id: parentId, installationKind: "standalone", provenance: { kind: "source" } }],
    components: [],
  });
  expect(unlinked).toMatchObject({ ownership: "unmanaged", extensionId: null, provenance: null });
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
    integrations: [{ id: "fixture", installedVersion: "1.0" }],
    parents: [{ id: "catalog", installationKind: "catalog", provenance: null }],
    components: [{ kind: "integration", componentId: "fixture", extensionId: "catalog" }],
  });
  expect(catalog[0]).toMatchObject({ ownership: "extension", removable: false });
  const missingParent = mergeStandaloneInventory({
    files: [f],
    integrations: [{ id: "fixture", installedVersion: "1.0" }],
    parents: [],
    components: [{ kind: "integration", componentId: "fixture", extensionId: "catalog" }],
  });
  expect(missingParent[0]).toMatchObject({ ownership: "conflict", removable: false });
  const missingRow = mergeStandaloneInventory({
    files: [f],
    integrations: [],
    parents: [{ id: "catalog", installationKind: "catalog", provenance: null }],
    components: [{ kind: "integration", componentId: "fixture", extensionId: "catalog" }],
  });
  expect(missingRow[0]).toMatchObject({ ownership: "conflict", removable: false });
});
