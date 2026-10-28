import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeAdministrativeConfigurationRead,
  openAdministrativeConfigurationRead,
  withAdministrativeConfigurationReadScope,
} from "./administrative-configuration-context";
import {
  integrationOwnershipSnapshot,
  projectFieldOwnership,
} from "./configuration-ownership-view";
import { encrypt } from "./secrets";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe("effective configuration ownership metadata", () => {
  it.each(["default", "database", "vault", "config.json", "env"] as const)(
    "projects %s without values",
    (source) => {
      for (const secret of [false, true]) {
        const result = projectFieldOwnership({ source, secret, envVar: "SYNTHETIC_TOKEN" });
        expect(result.writable).toBe(!["env", "config.json"].includes(source));
        expect(result.secret).toBe(secret);
        expect(result.reason).toBe(
          source === "env"
            ? "host_environment"
            : source === "config.json"
              ? "host_file"
              : secret
                ? "vault_only"
                : null,
        );
        expect(Object.keys(result)).not.toContain("value");
      }
    },
  );
  it("reads the actual strict cascade, preserves empty env as unset, and locks a file winner", async () => {
    vi.stubEnv("OPENMAPX_SECRETS_KEY", "71".repeat(32));
    const root = mkdtempSync(join(tmpdir(), "openmapx-ownership-"));
    roots.push(root);
    mkdirSync(join(root, "fixture"));
    const directory = join(root, "fixture"),
      now = new Date(),
      configSchema = {
        properties: {
          TOKEN: { type: "string", "x-openmapx-secret": true, default: "default-private" },
          REGION: { type: "string", default: "default" },
        },
      };
    const context = openAdministrativeConfigurationRead({
      services: [],
      integrations: [
        {
          id: "fixture",
          manifest: { id: "fixture", version: "1", domains: [], configSchema },
          directory,
          config: {},
          enabled: true,
          isBuiltIn: true,
          strings: {},
          providers: new Map(),
          shutdownHandlers: [],
        },
      ],
      env: { INTEGRATION_FIXTURE_TOKEN: "" },
      serviceRows: [],
      serviceSecretRows: [],
      integrationRows: [
        {
          id: "row",
          integrationId: "fixture",
          config: { REGION: "saved" },
          createdAt: now,
          updatedAt: now,
        },
      ],
      integrationSecretRows: [
        {
          id: "secret",
          integrationId: "fixture",
          key: "TOKEN",
          ...encrypt("vault-private"),
          createdAt: now,
          updatedAt: now,
          updatedBy: null,
        },
      ],
    });
    try {
      await withAdministrativeConfigurationReadScope(context, async () => {
        const first = await integrationOwnershipSnapshot("fixture", context);
        expect(first.ownership.TOKEN).toMatchObject({
          source: "vault",
          writable: true,
          reason: "vault_only",
        });
        writeFileSync(join(directory, "config.json"), JSON.stringify({ TOKEN: "file-private" }));
        const next = openAdministrativeConfigurationRead({ ...context });
        let second: Awaited<ReturnType<typeof integrationOwnershipSnapshot>>;
        try {
          second = await withAdministrativeConfigurationReadScope(next, () =>
            integrationOwnershipSnapshot("fixture", next),
          );
        } finally {
          closeAdministrativeConfigurationRead(next);
        }
        expect(second.ownership.TOKEN).toMatchObject({
          source: "config.json",
          writable: false,
          adoption: "host_action_required",
        });
        expect(JSON.stringify(second.ownership)).not.toContain("private");
      });
    } finally {
      closeAdministrativeConfigurationRead(context);
    }
  });
  it("keeps managed credentials outside generic mutations", () => {
    expect(
      projectFieldOwnership({ source: "vault", secret: true, managedBy: "transit.credentials" }),
    ).toMatchObject({
      writable: false,
      managedBy: "transit.credentials",
      reason: "managed_workflow",
    });
  });
});
