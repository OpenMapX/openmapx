import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationManifest } from "@openmapx/integration-framework";
import { afterEach, expect, it, vi } from "vitest";

import {
  closeAdministrativeConfigurationRead,
  openAdministrativeConfigurationRead,
  withAdministrativeConfigurationReadScope,
} from "./administrative-configuration-context";
import { encrypt, secretAad } from "./secrets";

let installed: { id: string; directory: string; manifest: IntegrationManifest };
vi.mock("./administrative-configuration-writer-owner", () => ({
  withAdministrativeConfigurationRead: async (
    _options: unknown,
    run: (context: ReturnType<typeof openAdministrativeConfigurationRead>) => Promise<unknown>,
  ) => {
    const date = new Date("2026-10-20T00:00:00Z"),
      context = openAdministrativeConfigurationRead({
        services: [],
        integrations: [
          {
            ...installed,
            enabled: true,
            isBuiltIn: true,
            config: {},
            strings: {},
            providers: new Map(),
            loadState: "loaded",
            shutdownHandlers: [],
          },
        ],
        env: { ...process.env },
        serviceRows: [],
        serviceSecretRows: [],
        integrationRows: [
          {
            integrationId: "fixture",
            config: { apiKey: "synthetic-db" },
            createdAt: date,
            updatedAt: date,
            ownerExtensionId: null,
            schemaVersion: 1,
          },
        ],
        integrationSecretRows: [
          {
            integrationId: "fixture",
            key: "apiKey",
            ...encrypt("synthetic-vault", secretAad.integrationSecret("fixture", "apiKey")),
            updatedAt: date,
            createdAt: date,
            updatedByUserId: "fixture-actor",
            ownerExtensionId: null,
          },
        ],
      });
    try {
      return await withAdministrativeConfigurationReadScope(context, () => run(context));
    } finally {
      closeAdministrativeConfigurationRead(context);
    }
  },
}));
const { computeCredentialStatus } = await import("./integration-credential-status");
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("uses the actual env > file > vault cascade and keeps separate vault audit without values", async () => {
  const directory = mkdtempSync(join(tmpdir(), "credential-status-"));
  roots.push(directory);
  const integration = {
    id: "fixture",
    directory,
    manifest: {
      id: "fixture",
      domains: ["test"],
      configSchema: {
        properties: {
          apiKey: { type: "string", "x-openmapx-secret": true, default: "synthetic-default" },
        },
      },
    } as IntegrationManifest,
  };
  installed = integration;
  vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(32, 0x71).toString("base64url"));
  vi.stubEnv("INTEGRATION_FIXTURE_API_KEY", "synthetic-env");
  writeFileSync(join(directory, "config.json"), JSON.stringify({ apiKey: "synthetic-file" }));
  expect((await computeCredentialStatus(integration))[0]).toMatchObject({
    source: "env",
    updatedBy: "fixture-actor",
  });
  vi.stubEnv("INTEGRATION_FIXTURE_API_KEY", "");
  expect((await computeCredentialStatus(integration))[0]?.source).toBe("config.json");
  rmSync(join(directory, "config.json"));
  const status = await computeCredentialStatus(integration);
  expect(status[0]).toMatchObject({ source: "vault", updatedAt: "2026-10-20T00:00:00.000Z" });
  expect(JSON.stringify(status)).not.toContain("synthetic-");
  writeFileSync(join(directory, "config.json"), JSON.stringify({ apiKey: "" }));
  expect((await computeCredentialStatus(integration))[0]).toMatchObject({
    source: "missing",
    updatedBy: "fixture-actor",
  });
});
