import { describe, expect, it, vi } from "vitest";
import { configurationMigrationDocumentSchema } from "../../../../../packages/core/src/api/contracts/integration-admin/configuration-migration";

const state = vi.hoisted(() => ({
  read: {
    services: [],
    integrations: [{ id: "example" }],
    bindingRows: [],
    integrationRows: [
      {
        integrationId: "example",
        config: {
          VALUE: "portable",
          HOST: "host-private",
          TOKEN: "plaintext-secret-in-invalid-row",
          UNKNOWN: "unknown-private",
        },
      },
    ],
    serviceRows: [],
    env: {},
  },
}));
vi.mock("../../db", () => ({ db: { select: () => ({ from: async () => [] }) } }));
vi.mock("../administrative-configuration-writer-owner", () => ({
  withAdministrativeConfigurationRead: async (_options: unknown, run: (read: unknown) => unknown) =>
    run(state.read),
}));
vi.mock("./sources", () => ({
  migrationSources: async () => ({
    revisionId: null,
    sourceRevision: "00000000-0000-4000-8000-000000000001",
    services: [],
  }),
}));
vi.mock("../standalone-integrations/ownership", () => ({
  standaloneInventory: async () => ({ entries: [] }),
}));
vi.mock("../configuration-ownership-view", () => ({
  projectFieldOwnership: ({ source, secret }: { source: string; secret: boolean }) => ({
    source,
    secret,
    writable: source !== "env",
    adoption: source === "env" ? "host_action_required" : "direct",
    reason: source === "env" ? "host_environment" : secret ? "vault_only" : null,
  }),
  integrationOwnershipSnapshot: async () => ({
    ownership: {
      VALUE: {
        source: "database",
        secret: false,
        writable: true,
        adoption: "direct",
        reason: null,
      },
      HOST: {
        source: "env",
        secret: false,
        writable: false,
        adoption: "host_action_required",
        reason: "host_environment",
        envVar: "PRIVATE_ENV",
      },
      TOKEN: {
        source: "vault",
        secret: true,
        writable: true,
        adoption: "direct",
        reason: "vault_only",
      },
    },
    resolved: {
      VALUE: { value: "portable", source: "database" },
      HOST: { value: "host-private", source: "env" },
      TOKEN: { value: "synthetic-vault-secret", source: "vault" },
    },
  }),
}));

import { configurationMigrationInventory } from "./inventory";

describe("portable migration boundary", () => {
  it("exports only declared database non-secrets and names explicit omissions without host labels or masking sentinels", async () => {
    const result = await configurationMigrationInventory();
    expect(result.document.integrations).toEqual([
      { integrationId: "example", config: { VALUE: "portable" } },
    ]);
    expect(result.document.prerequisites).toEqual(
      expect.arrayContaining([
        { scope: "integration", id: "example", key: "HOST", source: "env", reason: "host_owned" },
        {
          scope: "integration",
          id: "example",
          key: "TOKEN",
          source: "vault",
          reason: "credential_required",
        },
      ]),
    );
    for (const forbidden of [
      "host-private",
      "synthetic-vault-secret",
      "plaintext-secret-in-invalid-row",
      "unknown-private",
      "PRIVATE_ENV",
      "***",
    ])
      expect(JSON.stringify(result)).not.toContain(forbidden);
  });
  it("rejects unknown metadata and the1000field bound before candidate construction", () => {
    const document = {
      format: "openmapx-configuration",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {},
      integrations: [],
      serviceConfigs: [],
      bindings: [],
      installations: [],
      prerequisites: [],
    };
    expect(
      configurationMigrationDocumentSchema.safeParse({
        ...document,
        privateMetadata: "not-portable",
      }).success,
    ).toBe(false);
    expect(
      configurationMigrationDocumentSchema.safeParse({
        ...document,
        integrations: Array.from({ length: 8 }, (_, n) => ({
          integrationId: `example-${n}`,
          config: Object.fromEntries(
            Array.from({ length: 128 }, (_, key) => [`KEY${key}`, "value"]),
          ),
        })),
      }).success,
    ).toBe(false);
  });
});
