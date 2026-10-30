import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApiClient } from "@openmapx/core";
import {
  applyAdminConfigurationMigration,
  applyAdminCredentialTransfer,
  exportAdminConfigurationMigration,
  exportAdminCredentialTransfer,
  previewAdminConfigurationMigration,
  previewAdminCredentialTransfer,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import { closeControlInstallation, openControlInstallation } from "@openmapx/core/build-artifacts";
import type { services } from "@openmapx/core/server";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ownedServiceHost } from "../../../../ops-agent/src/__fixtures__/owned-service-host";
import { ArtifactTransferStore } from "../../../../ops-agent/src/artifact-transfer/store";
import { openOpsJobJournal } from "../../../../ops-agent/src/journal";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import { installStandaloneIntegrationRuntime } from "../../../../ops-agent/src/standalone-integration-runtime";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";

const state = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
  loaded: [] as services.LoadedService[],
}));
vi.mock("../../db", () => ({
  get db() {
    return state.fixture.db;
  },
  get sql() {
    return state.fixture.sql;
  },
}));
vi.mock("../service-registry", async (actual) => ({
  ...(await actual<typeof import("../service-registry")>()),
  getServiceRegistry: () => ({
    list: () => state.loaded,
    get: (id: string) => state.loaded.find((s) => s.manifest.id === id),
    applyEnabledIds: () => {},
  }),
}));

import type { ConfigurationMigrationDocument } from "../../../../../packages/core/src/api/contracts/integration-admin/configuration-migration";
import { integrationConfig, systemSettings, user } from "../../db/schema";
import { createDurableOpsKey } from "../ops-client";

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "configuration migration / production candidate / actual agent / owned PostgreSQL",
  () => {
    let host: Awaited<ReturnType<typeof ownedServiceHost>>,
      agent: ReturnType<typeof buildOpsAgentServer>,
      api: ReturnType<typeof Fastify>,
      installation: ReturnType<typeof openControlInstallation>,
      store: ArtifactTransferStore;
    beforeAll(async () => {
      state.fixture = await createMigratedPostgresFixture();
      host = await ownedServiceHost();
      state.loaded = host.loaded;
      await state.fixture.db.insert(user).values({
        id: "migration-admin",
        email: "migration-admin@example.test",
        name: "Migration admin",
        role: "admin",
      });
      const root = join(host.root, "integrations");
      mkdirSync(root);
      for (const id of ["alpha", "beta"]) {
        const directory = join(root, id);
        mkdirSync(directory);
        writeFileSync(
          join(directory, "manifest.json"),
          JSON.stringify({
            id,
            version: "1.0.0",
            domains: ["knowledge"],
            quality: "built-in",
            configSchema: {
              properties: {
                VALUE: { type: "string", default: "default" },
                TOKEN: { type: "string", "x-openmapx-secret": true },
              },
            },
          }),
        );
      }
      store = new ArtifactTransferStore({
        dataRoot: join(host.root, "stages"),
        privateRoot: join(host.root, "stage-meta"),
        token: host.token,
        capacity: () => ({ bytes: 2 * 1024 ** 3, inodes: 100000 }),
      });
      installStandaloneIntegrationRuntime(host.runtime, { rootDir: host.root, store });
      installation = openControlInstallation({
        infraDir: host.infraDir,
        role: "ops-agent",
        serviceIds: host.loaded.map((s) => s.manifest.id),
      });
      agent = buildOpsAgentServer({
        tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
        runtime: host.runtime,
        resourceClaimer: host.claimer,
        journal: await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json")),
        controlInstallation: installation,
      });
      const baseUrl = await agent.listen({ host: "127.0.0.1", port: 0 }),
        tokenFile = join(host.root, "api-token");
      writeFileSync(tokenFile, host.token, { mode: 0o600 });
      for (const [key, value] of Object.entries({
        OPS_AGENT_URL: baseUrl,
        OPS_AGENT_TOKEN_FILE: tokenFile,
        OPS_TRUSTED_CONFIG_DIR: host.queue,
        OPS_TRUSTED_CONFIG_UID: String(statSync(host.queue).uid),
        OPS_TRUSTED_CONFIG_GID: String(statSync(host.queue).gid),
        OPENMAPX_SECRETS_KEY: "71".repeat(32),
        OPENMAPX_LOCAL_ADMIN_TOKEN: "migration-local-synthetic",
        OPENMAPX_DISABLE_LOCALHOST_AUTH: "0",
        BETTER_AUTH_SECRET: "migration-owned-synthetic-auth-secret",
        BETTER_AUTH_URL: "http://localhost:3001",
      }))
        vi.stubEnv(key, value);
      api = Fastify({ logger: false });
      await (await import("../../integration-host")).initIntegrations(api, [
        { directory: root, isBuiltIn: true },
      ]);
      await api.register(
        (await import("../../routes/admin-configuration-migration"))
          .adminConfigurationMigrationRoute,
        { prefix: "/api" },
      );
      await api.register(
        (await import("../../routes/admin-credential-transfer")).adminCredentialTransferRoute,
        { prefix: "/api" },
      );
      await api.listen({ host: "127.0.0.1", port: 0 });
    }, 90000);
    afterAll(async () => {
      await (await import("../../integration-host")).shutdownIntegrations();
      await api?.close();
      await agent?.close();
      if (installation) closeControlInstallation(installation);
      store?.close();
      await state.fixture?.stop();
      if (host) rmSync(host.root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });
    function document(value: string): ConfigurationMigrationDocument {
      return {
        format: "openmapx-configuration",
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: { instanceName: "Migrated synthetic instance" },
        integrations: [
          { integrationId: "alpha", config: { VALUE: value } },
          { integrationId: "beta", config: { VALUE: value } },
        ],
        serviceConfigs: [],
        bindings: [],
        installations: [],
        prerequisites: [],
      };
    }
    it("previews without writes, commits one exact ordinary batch, preserves unrelated settings and replays its durable result", async () => {
      await state.fixture.db
        .insert(systemSettings)
        .values({ key: "unrelated-synthetic-setting", value: "preserved" });
      const { jobRunner } = await import("../job-runner");
      const preview = await jobRunner.runImmediateConfigurationMigrationPreview({
        actorId: "migration-admin",
        operationKey: createDurableOpsKey("migration.test.preview", randomUUID()),
        document: document("migrated"),
      });
      expect(preview.denials).toEqual([]);
      expect(await state.fixture.db.select().from(integrationConfig)).toHaveLength(0);
      const input = {
          actorId: "migration-admin",
          operationKey: createDurableOpsKey("migration.test.apply", randomUUID()),
          previewId: preview.previewId,
          fingerprint: preview.fingerprint,
          kind: "migration" as const,
        },
        result = await jobRunner.runImmediateConfigurationMigration(input);
      expect(result.outcome).toBe("applied");
      expect(await jobRunner.runImmediateConfigurationMigration(input)).toEqual(result);
      expect(
        (await state.fixture.db.select().from(integrationConfig)).map((r) => r.config.VALUE),
      ).toEqual(["migrated", "migrated"]);
      expect(
        (await state.fixture.db.select().from(systemSettings)).find(
          (r) => r.key === "unrelated-synthetic-setting",
        )?.value,
      ).toBe("preserved");
      await (await import("./inventory")).configurationMigrationInventory();
      const address = api.server.address();
      if (!address || typeof address === "string") throw Error("HTTP fixture unavailable");
      const client = createApiClient({
          baseUrl: `http://127.0.0.1:${address.port}/api`,
          headerInterceptor: () => ({ "x-openmapx-local-admin": "migration-local-synthetic" }),
        }),
        portable = unwrapAdminResponse(
          await exportAdminConfigurationMigration({
            client,
            maxJsonBytes: 1048576,
            maxErrorBytes: 65536,
          }),
        );
      expect(portable.integrations).toEqual(
        expect.arrayContaining([{ integrationId: "alpha", config: { VALUE: "migrated" } }]),
      );
      expect(JSON.stringify(portable)).not.toContain("***");
      expect(JSON.stringify(portable)).not.toContain("OPENMAPX_SECRETS_KEY");
    }, 90000);
    it("denies secret injection and stale source with zero selected writes", async () => {
      const { jobRunner } = await import("../job-runner");
      const invalid = document("not-written");
      invalid.integrations[0]!.config.TOKEN = "synthetic-secret";
      const denied = await jobRunner.runImmediateConfigurationMigrationPreview({
        actorId: "migration-admin",
        operationKey: createDurableOpsKey("migration.test.denial", randomUUID()),
        document: invalid,
      });
      expect(denied.denials).toContain("integration:alpha:TOKEN:not_portable");
      const preview = await jobRunner.runImmediateConfigurationMigrationPreview({
        actorId: "migration-admin",
        operationKey: createDurableOpsKey("migration.test.stale", randomUUID()),
        document: document("stale-write"),
      });
      await state.fixture
        .sql`update integration_config set config = '{"VALUE":"external-race"}'::jsonb where integration_id='beta'`;
      await expect(
        jobRunner.runImmediateConfigurationMigration({
          actorId: "migration-admin",
          operationKey: createDurableOpsKey("migration.test.refuse", randomUUID()),
          previewId: preview.previewId,
          fingerprint: preview.fingerprint,
          kind: "migration",
        }),
      ).rejects.toThrow();
      expect(
        (await state.fixture.db.select().from(integrationConfig)).find(
          (r) => r.integrationId === "alpha",
        )?.config.VALUE,
      ).toBe("migrated");
    }, 90000);
    it("round trips actual full-admin sessions and purpose proofs through generated HTTP migration and vault clients", async () => {
      const schema = await import("../../db/schema"),
        { hashPassword } = await import("better-auth/crypto"),
        { eq } = await import("drizzle-orm");
      const password = "synthetic-migration-password-1234";
      await state.fixture.db
        .update(schema.user)
        .set({ emailVerified: true })
        .where(eq(schema.user.id, "migration-admin"));
      await state.fixture.db.insert(schema.account).values({
        id: randomUUID(),
        accountId: "migration-admin",
        providerId: "credential",
        userId: "migration-admin",
        password: await hashPassword(password),
      });
      const { auth } = await import("../../auth");
      let cookie = "";
      const login = async () => {
        const response = await auth.api.signInEmail({
          body: { email: "migration-admin@example.test", password },
          asResponse: true,
        });
        expect(response.status).toBe(200);
        cookie = response.headers
          .getSetCookie()
          .map((v) => v.split(";")[0])
          .join("; ");
        const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
        if (!session) throw Error("Synthetic administrator session unavailable");
        return session;
      };
      await login();
      const address = api.server.address();
      if (!address || typeof address === "string") throw Error("HTTP fixture unavailable");
      const client = createApiClient({
        baseUrl: `http://127.0.0.1:${address.port}/api`,
        headerInterceptor: () => ({ cookie }),
      });
      const preview = unwrapAdminResponse(
        await previewAdminConfigurationMigration(
          document("http-migrated"),
          { "idempotency-key": randomUUID() },
          { client, maxJsonBytes: 1048576, maxErrorBytes: 65536 },
        ),
      );
      const applied = unwrapAdminResponse(
        await applyAdminConfigurationMigration(
          { previewId: preview.previewId, fingerprint: preview.fingerprint },
          { "idempotency-key": randomUUID() },
          { client, maxJsonBytes: 1048576, maxErrorBytes: 65536 },
        ),
      );
      expect(applied.outcome).toBe("applied");
      expect(applied.steps.some((s) => s.id === "alpha" && s.status === "applied")).toBe(true);
      const { AdminActionReauthentication, ADMIN_REAUTH_COOKIE_NAME } = await import(
          "../../account/admin-reauthentication"
        ),
        reauth = new AdminActionReauthentication(state.fixture.db);
      const ceremony = async (
        purpose: "credentials.export" | "credentials.import",
        targetId: string,
        intentFingerprint?: string,
      ) => {
        const current = await auth.api.getSession({ headers: new Headers({ cookie }) });
        if (!current) throw Error("Synthetic administrator session unavailable");
        const proof = await reauth.start({
          actorId: "migration-admin",
          startingSessionId: current.session.id,
          purpose,
          targetId,
          ...(intentFingerprint ? { intentFingerprint } : {}),
        });
        await new Promise((resolve) => setTimeout(resolve, 2));
        const fresh = await login();
        await reauth.complete({
          challengeId: proof.challengeId,
          nonce: proof.nonce,
          session: {
            id: fresh.session.id,
            userId: fresh.user.id,
            method: "password",
            authenticatedAt: new Date(fresh.session.createdAt),
            mfaConfigured: false,
          },
        });
        cookie += `; ${ADMIN_REAUTH_COOKIE_NAME}=${proof.nonce.toString("base64url")}`;
        return proof.challengeId;
      };
      await state.fixture.db.insert(schema.integrationSecret).values({
        id: randomUUID(),
        integrationId: "alpha",
        key: "TOKEN",
        ...(await import("../secrets")).encrypt("synthetic-http-vault-value"),
      });
      const exportProof = await ceremony("credentials.export", "vault-transfer"),
        response = await exportAdminCredentialTransfer(
          {
            selection: [{ scope: "integration", id: "alpha", key: "TOKEN" }],
            passphrase: "synthetic transfer passphrase",
            confirmed: true,
          },
          {
            client,
            headers: { "x-admin-reauth-proof": exportProof },
            maxJsonBytes: 1048576,
            maxErrorBytes: 65536,
          },
        );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const envelope = unwrapAdminResponse(response),
        decoded = await (await import("./credential-transfer")).decryptCredentialTransfer(
          "destination",
          envelope,
          "synthetic transfer passphrase",
        );
      expect(decoded.entries).toEqual([
        { scope: "integration", id: "alpha", key: "TOKEN", value: "synthetic-http-vault-value" },
      ]);
      const previewProof = await ceremony(
          "credentials.import",
          "vault-transfer",
          (
            await import(
              "../../../../../packages/core/src/api/contracts/integration-admin/credential-transfer"
            )
          ).CREDENTIAL_TRANSFER_PREVIEW_INTENT,
        ),
        credentialPreview = unwrapAdminResponse(
          await previewAdminCredentialTransfer(
            {
              envelope,
              passphrase: "synthetic transfer passphrase",
              choices: {
                entries: [{ scope: "integration", id: "alpha", key: "TOKEN", action: "import" }],
              },
            },
            { "idempotency-key": randomUUID(), "x-admin-reauth-proof": previewProof },
            { client, maxJsonBytes: 1048576, maxErrorBytes: 65536 },
          ),
        );
      expect(JSON.stringify(credentialPreview)).not.toContain("synthetic-http-vault-value");
      expect(credentialPreview.applyable).toBe(true);
      const importProof = await ceremony(
          "credentials.import",
          credentialPreview.previewId,
          credentialPreview.intentFingerprint,
        ),
        imported = unwrapAdminResponse(
          await applyAdminCredentialTransfer(
            {
              previewId: credentialPreview.previewId,
              intentFingerprint: credentialPreview.intentFingerprint,
              expectedCurrentRevisionId: credentialPreview.expectedCurrentRevisionId,
              importProofToken: importProof,
            },
            { "idempotency-key": randomUUID() },
            { client, maxJsonBytes: 1048576, maxErrorBytes: 65536 },
          ),
        );
      expect(imported.outcome).toBe("applied");
      expect(
        (await state.fixture.db.select().from(schema.adminActionReauthentication))
          .filter((p) => [exportProof, previewProof, importProof].includes(p.id))
          .every((p) => p.state === "consumed"),
      ).toBe(true);
    }, 90000);
  },
);
