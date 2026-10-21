import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationManifest } from "@openmapx/integration-framework";
import { afterEach, expect, it, vi } from "vitest";

const database = { apiKey: "synthetic-db" };
vi.mock("../db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ config: database }] }) }),
    }),
  },
}));
vi.mock("../services/secrets", () => ({
  resolveVaultSecrets: async () => ({ apiKey: "synthetic-vault" }),
  listSecrets: async () => [
    { key: "apiKey", updatedAt: new Date("2026-10-20T00:00:00Z"), updatedBy: "fixture-actor" },
  ],
}));
vi.mock("../integration-host", async () => ({
  resolveConfigWithSources: (await import("../integration-config")).resolveConfigWithSources,
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
  vi.stubEnv("INTEGRATION_FIXTURE_APIKEY", "synthetic-env");
  writeFileSync(join(directory, "config.json"), JSON.stringify({ apiKey: "synthetic-file" }));
  expect((await computeCredentialStatus(integration))[0]).toMatchObject({
    source: "env",
    updatedBy: "fixture-actor",
  });
  vi.stubEnv("INTEGRATION_FIXTURE_APIKEY", "");
  expect((await computeCredentialStatus(integration))[0].source).toBe("config.json");
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
