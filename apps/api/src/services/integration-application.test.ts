import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeControlInstallation, openControlInstallation } from "@openmapx/core/build-artifacts";
import { services } from "@openmapx/core/server";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ownedServiceHost } from "../../../ops-agent/src/__fixtures__/owned-service-host";
import { openOpsJobJournal } from "../../../ops-agent/src/journal";
import { buildOpsAgentServer } from "../../../ops-agent/src/server";
import { createConfigurationPostgresFixture } from "../test/configuration-postgres-fixture";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const state = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createConfigurationPostgresFixture>>,
  root: "",
}));
vi.mock("../db", () => ({
  get db() {
    return state.fixture.db;
  },
  get sql() {
    return state.fixture.sql;
  },
}));
vi.mock("@openmapx/core/server", async (original) => ({
  ...(await original<typeof import("@openmapx/core/server")>()),
  findRepoRoot: () => state.root,
}));
// Infrastructure-only ports; provider activation, API, SQL writer, candidate,
// production registry/agent, signed receipts and target runtime remain actual.
vi.mock("../redis", () => ({ redis: null }));
vi.mock("./attribution", () => ({
  AttributionIndex: {
    init: async () => ({ setIntegrationManifests() {}, reload: async () => {}, close() {} }),
  },
  defaultMotisLicenseFile: () => null,
  getAttributionIndex: () => null,
  setAttributionIndex() {},
}));
vi.mock("./provider-health/registry", () => ({
  getProviderHealth: () => null,
  ProviderHealth: { init: async () => ({ close() {} }) },
  setProviderHealth() {},
}));
vi.mock("./integration-health", () => ({
  executeAllIntegrationHealthChecks: async () => [],
  getCachedIntegrationHealthSnapshot: () => ({ updatedAt: null, results: [] }),
}));
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "actual binding candidate / API / agent / PostgreSQL / captured provider",
  () => {
    let raceAfterPreview = false;
    let driftAfterCommit = false;
    let migrated: Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
      host: Awaited<ReturnType<typeof ownedServiceHost>>,
      api: ReturnType<typeof Fastify>,
      agent: ReturnType<typeof buildOpsAgentServer>,
      installation: ReturnType<typeof openControlInstallation>;
    const headers = { "x-openmapx-local-admin": "binding-owned-admin" };
    beforeAll(async () => {
      migrated = await createMigratedPostgresFixture();
    }, 90000);
    afterAll(async () => {
      await migrated?.stop();
    });
    beforeEach(async (context) => {
      vi.stubEnv("BETTER_AUTH_SECRET", "binding-owned-synthetic-auth-secret-only");
      vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3001");
      vi.stubEnv("OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL", migrated.connectionUri);
      state.fixture = await createConfigurationPostgresFixture();
      raceAfterPreview = false;
      driftAfterCommit = false;
      host = await ownedServiceHost({
        extraServiceIds: [
          "engine-b",
          ...(context.task.name.includes("managed transit") ? ["data-manager"] : []),
        ],
        capabilities: { motis: ["routing-engine"], "engine-b": ["routing-engine"] },
        schemas: {
          motis: {
            type: "object",
            properties: {
              REGION: { type: "string", default: "default" },
              TOKEN: { type: "string", "x-openmapx-secret": true },
              OPENMAPX_MEMORY_MIB: { type: "integer", minimum: 128 },
            },
          },
        },
        resources: { motis: { memory: "${MOTIS_SLOT_MEMORY:-4g}" } },
      });
      for (const service of host.loaded) {
        const checked = services.validateServiceManifest(service.manifest, {
          firstParty: service.isBuiltIn,
        });
        expect(checked.valid, JSON.stringify(checked.errors)).toBe(true);
      }
      state.root = host.root;
      const root = join(host.root, "integrations"),
        directory = join(root, "binding-test");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "manifest.json"),
        JSON.stringify({
          id: "binding-test",
          version: "1.0.0",
          author: "Synthetic fixture",
          license: "MIT",
          domains: ["knowledge"],
          quality: "built-in",
          requires: [{ capability: "routing-engine" }],
          backend: { routes: true },
          configSchema: {
            properties: {
              TOKEN: { type: "string", "x-openmapx-secret": true, default: "old-synthetic-token" },
              ENDPOINT: { type: "string", default: "old-endpoint" },
            },
          },
        }),
      );
      writeFileSync(
        join(directory, "index.ts"),
        `export function setup(ctx){const captured=ctx.getRequiredService('routing-engine');ctx.registerRoute('GET','/bound',async(_req,reply)=>reply.send({serviceId:captured?.serviceId??null}));const token=ctx.config.TOKEN;ctx.registerRoute('GET','/credential',async(_req,reply)=>reply.send({rotated:token==='new-synthetic-token'}));}`,
      );
      installation = openControlInstallation({
        infraDir: host.infraDir,
        role: "ops-agent",
        serviceIds: host.loaded.map((s) => s.manifest.id),
      });
      agent = buildOpsAgentServer({
        tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
        runtime: host.runtime,
        resourceClaimer: host.claimer,
        journal: await openOpsJobJournal(join(host.infraDir, "state/ops-agent/jobs-v1.json")),
        controlInstallation: installation,
      });
      agent.addHook("onSend", async (request, _reply, payload) => {
        if (
          raceAfterPreview &&
          (request.body as { operation?: { kind?: string } })?.operation?.kind ===
            "configuration.hardlinks.preview"
        ) {
          raceAfterPreview = false;
          await state.fixture
            .sql`UPDATE capability_binding SET updated_at=now() WHERE integration_id='binding-test'`;
        }
        if (
          driftAfterCommit &&
          request.method === "GET" &&
          request.url.startsWith("/v1/operations/") &&
          typeof payload === "string"
        ) {
          const response = JSON.parse(payload);
          if (response.result?.result?.outcome === "committed") {
            driftAfterCommit = false;
            writeFileSync(
              join(directory, "config.json"),
              JSON.stringify({ TOKEN: "host-drift-token" }),
            );
          }
        }
        return payload;
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
        OPENMAPX_LOCAL_ADMIN_TOKEN: "binding-owned-admin",
        OPENMAPX_DISABLE_LOCALHOST_AUTH: "0",
        BETTER_AUTH_SECRET: "binding-owned-synthetic-auth-secret-only",
        BETTER_AUTH_URL: "http://localhost:3001",
        [services.APPLIED_SERVICES_ENV]: "motis,engine-b",
      }))
        vi.stubEnv(key, value);
      await state.fixture
        .sql`INSERT INTO capability_binding(integration_id,capability,service_id) VALUES ('binding-test','routing-engine','motis')`;
      await (await import("./service-registry")).initServiceRegistry();
      api = Fastify();
      await api.register((await import("../routes/integrations")).integrationsRoute, {
        prefix: "/api",
      });
      await (await import("../integration-host")).initIntegrations(api, [
        { directory: root, isBuiltIn: true },
      ]);
      await (await import("../routes/admin-capability-bindings")).registerCapabilityBindingRoutes(
        api,
      );
      api.addHook("preHandler", async (request: import("fastify").FastifyRequest) => {
        if (request.url.startsWith("/api/admin/"))
          request.adminSession = await (await import("../utils/require-admin")).requireAdmin(
            request,
          );
      });
      await api.register(
        (await import("../routes/admin-integration-credentials")).adminIntegrationCredentialsRoute,
        { prefix: "/api" },
      );
      await api.register((await import("../routes/admin-services")).adminServicesRoute, {
        prefix: "/api",
      });
      await api.ready();
    }, 30000);
    afterEach(async () => {
      vi.restoreAllMocks();
      await (await import("../integration-host")).shutdownIntegrations();
      await api?.close();
      await agent?.close();
      if (installation) closeControlInstallation(installation);
      await state.fixture?.stop();
      if (host) rmSync(host.root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });
    async function desired() {
      const response = await api.inject({
        url: "/api/admin/integrations/binding-test/bindings",
        headers,
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    }
    async function set(body: unknown, key = `binding-${randomUUID()}`) {
      (await import("../utils/rate-limit")).serviceActionLimit.reset();
      return api.inject({
        method: "POST",
        url: "/api/admin/integrations/binding-test/bindings/routing-engine",
        headers: { ...headers, "idempotency-key": key },
        payload: body,
      });
    }
    it("saves and activates B once, rejects stale CAS, replays the same result, then unbinds to automatic resolution", async () => {
      expect((await api.inject("/api/integrations/binding-test/bound")).json()).toEqual({
        serviceId: "motis",
      });
      const before = await desired(),
        key = `binding-${randomUUID()}`,
        body = {
          serviceId: "engine-b",
          expectedServiceId: "motis",
          expectedRevision: before.revision,
        };
      const result = await set(body, key);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({
        database: "retained",
        runtime: "applied",
        runtimeGenerationId: expect.any(String),
      });
      expect((await api.inject("/api/integrations/binding-test/bound")).json()).toEqual({
        serviceId: "engine-b",
      });
      expect((await set(body, key)).json()).toEqual(result.json());
      const staleKey = `binding-stale-${randomUUID()}`;
      expect((await set({ ...body, serviceId: "motis" }, staleKey)).statusCode).toBe(409);
      expect((await set({ ...body, serviceId: "motis" }, staleKey)).statusCode).toBe(409);
      const current = await desired();
      expect(current.runtime.bindings["routing-engine"]).toBe("engine-b");
      expect(current.revision).not.toBe(before.revision);
      (await import("../utils/rate-limit")).serviceActionLimit.reset();
      const removed = await api.inject({
        method: "DELETE",
        url: "/api/admin/integrations/binding-test/bindings/routing-engine",
        headers: { ...headers, "idempotency-key": `binding-${randomUUID()}` },
        payload: { expectedServiceId: "engine-b", expectedRevision: current.revision },
      });
      expect(removed.statusCode, removed.body).toBe(200);
      expect(removed.json().runtime).toBe("applied");
      expect((await desired()).bindings).toEqual([]);
    }, 90000);
    it("retains B and the old live A after a strict reload failure, allowing an explicit new apply", async () => {
      const before = await desired(),
        bindings = await import("./capability-bindings");
      vi.spyOn(bindings, "loadAllBindingsByIntegration").mockRejectedValueOnce(
        Error("Synthetic unavailable binding query"),
      );
      const failed = await set({
        serviceId: "engine-b",
        expectedServiceId: "motis",
        expectedRevision: before.revision,
      });
      expect(failed.statusCode, failed.body).toBe(200);
      expect(failed.json()).toMatchObject({
        database: "retained",
        runtime: "failed",
        reason: "reload_failed",
        runtimeGenerationId: before.runtime.generationId,
      });
      expect((await api.inject("/api/integrations/binding-test/bound")).json()).toEqual({
        serviceId: "motis",
      });
      const saved = await desired();
      expect(saved.bindings).toEqual([{ capability: "routing-engine", serviceId: "engine-b" }]);
      const retry = await set({
        serviceId: "engine-b",
        expectedServiceId: "engine-b",
        expectedRevision: saved.revision,
      });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json().runtime).toBe("applied");
    }, 90000);
    it("serializes two actual writer connections and rejects the stale loser without undoing the winner", async () => {
      const before = await desired(),
        { jobRunner } = await import("./job-runner"),
        { createDirectAdminOpsKey } = await import("./direct-ops-idempotency");
      const request = (serviceId: string) =>
        jobRunner.applyImmediateIntegrationBinding({
          actorId: "loopback",
          operationKey: createDirectAdminOpsKey("loopback", `binding-race-${randomUUID()}`),
          input: {
            integrationId: "binding-test",
            capability: "routing-engine",
            expectedServiceId: "motis",
            expectedRevision: before.revision,
            serviceId,
          },
        });
      const results = await Promise.allSettled([request("engine-b"), request("motis")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const winner = results.find((r) => r.status === "fulfilled");
      expect(winner?.status === "fulfilled" && winner.value.runtime).toBe("applied");
      const current = await desired();
      expect(current.revision).not.toBe(before.revision);
      expect(await state.fixture.sql`SELECT * FROM integration_application_receipt`).toHaveLength(
        1,
      );
    }, 90000);
    it("observes an already active generation after completion publication fails, without another setup", async () => {
      const before = await desired(),
        key = `binding-recovery-${randomUUID()}`,
        body = {
          serviceId: "engine-b",
          expectedServiceId: "motis",
          expectedRevision: before.revision,
        };
      const hostModule = await import("../integration-host"),
        reload = vi.spyOn(hostModule, "reloadIntegrations");
      await state.fixture.sql.unsafe(
        `CREATE FUNCTION reject_binding_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.result#>>'{integrationReload,state}'='complete' THEN RAISE EXCEPTION 'synthetic completion unavailable'; END IF; RETURN NEW; END $$`,
      );
      await state.fixture.sql.unsafe(
        `CREATE TRIGGER reject_binding_completion BEFORE UPDATE ON admin_job FOR EACH ROW EXECUTE FUNCTION reject_binding_completion()`,
      );
      const interrupted = await set(body, key);
      expect(interrupted.statusCode).toBe(503);
      expect((await api.inject("/api/integrations/binding-test/bound")).json()).toEqual({
        serviceId: "engine-b",
      });
      expect(reload).toHaveBeenCalledTimes(1);
      const original = await state.fixture
        .sql`SELECT id,result FROM admin_job WHERE type='integration.binding.apply'`;
      expect(original).toHaveLength(1);
      expect(original[0]!.result.integrationReload.state).toBe("attempted");
      await state.fixture.sql.unsafe(`DROP TRIGGER reject_binding_completion ON admin_job`);
      // The original call has returned. Expire only its fixture observation lease;
      // keep the exact nonce, candidate, source and all production claim checks.
      await state.fixture
        .sql`UPDATE admin_job SET result=jsonb_set(result,'{_observationLeaseUntil}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE type='integration.binding.apply'`;
      const resumed = await set(body, key);
      const diagnostic = await state.fixture
        .sql`SELECT status,result->'_configurationCandidate'->>'phase' AS phase,result->'_execution' AS execution,result->'observation' AS observation,result->'integrationReload' AS reload,error FROM admin_job WHERE type='integration.binding.apply'`;
      expect(resumed.statusCode, JSON.stringify(diagnostic)).toBe(200);
      expect(resumed.json().runtime).toBe("applied");
      expect(reload).toHaveBeenCalledTimes(1);
      const rows = await state.fixture
        .sql`SELECT id,status,result FROM admin_job WHERE type='integration.binding.apply'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(original[0]!.id);
      expect(rows[0]!.status).toBe("success");
      expect(rows[0]!.result._execution.version).toBe(2);
    }, 90000);
    it("keeps disabled integrations pending instead of claiming an active provider", async () => {
      await state.fixture
        .sql`INSERT INTO integration_config (id,integration_id,config,created_at,updated_at) VALUES (${randomUUID()},'binding-test','{"enabled":false}'::jsonb,now(),now())`;
      await (await import("../integration-host")).reloadIntegrations();
      const before = await desired();
      expect(before.runtime).toBeNull();
      const result = await set({
        serviceId: "engine-b",
        expectedServiceId: "motis",
        expectedRevision: before.revision,
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({
        database: "retained",
        runtime: "pending",
        reason: "integration_disabled",
        runtimeGenerationId: null,
      });
      expect((await desired()).bindings).toEqual([
        { capability: "routing-engine", serviceId: "engine-b" },
      ]);
    }, 90000);
    it("rejects a real out-of-protocol row race after preview without saving the proposed binding", async () => {
      const before = await desired();
      raceAfterPreview = true;
      const key = `binding-row-race-${randomUUID()}`,
        body = {
          serviceId: "engine-b",
          expectedServiceId: "motis",
          expectedRevision: before.revision,
        };
      const rejected = await set(body, key);
      expect(rejected.statusCode, rejected.body).toBe(409);
      expect(raceAfterPreview).toBe(false);
      expect((await desired()).bindings).toEqual([
        { capability: "routing-engine", serviceId: "motis" },
      ]);
      expect(await state.fixture.sql`SELECT * FROM integration_application_receipt`).toHaveLength(
        0,
      );
      expect((await set(body, key)).statusCode).toBe(409);
    }, 90000);
    it("returns an applied credential receipt for the actual provider without exposing the value", async () => {
      const revision = (
        await (
          await import("./configuration-ownership-view")
        ).inspectIntegrationConfiguration("binding-test")
      ).revision;
      (await import("../utils/rate-limit")).serviceActionLimit.reset();
      const result = await api.inject({
        method: "PUT",
        url: "/api/admin/credentials/binding-test/TOKEN",
        headers: { ...headers, "idempotency-key": `credential-${randomUUID()}` },
        payload: { value: "new-synthetic-token", expectedRevision: revision },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({
        database: "retained",
        runtime: "applied",
        runtimeGenerationId: expect.any(String),
      });
      expect(result.body).not.toContain("new-synthetic-token");
      expect((await api.inject("/api/integrations/binding-test/credential")).json()).toEqual({
        rotated: true,
      });
    }, 90000);
    it("recovers credential activation observation without replaying provider setup", async () => {
      const before = await (
          await api.inject({ url: "/api/admin/credentials/binding-test", headers })
        ).json(),
        key = randomUUID(),
        reload = vi.spyOn(await import("../integration-host"), "reloadIntegrations");
      await state.fixture.sql.unsafe(
        `CREATE FUNCTION reject_credential_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.result#>>'{integrationReload,state}'='complete' THEN RAISE EXCEPTION 'synthetic completion unavailable'; END IF; RETURN NEW; END $$`,
      );
      await state.fixture.sql.unsafe(
        `CREATE TRIGGER reject_credential_completion BEFORE UPDATE ON admin_job FOR EACH ROW EXECUTE FUNCTION reject_credential_completion()`,
      );
      const interrupted = await credential("PUT", before.configurationRevision, key);
      expect(interrupted.statusCode, interrupted.body).toBe(503);
      expect((await api.inject("/api/integrations/binding-test/credential")).json()).toEqual({
        rotated: true,
      });
      expect(reload).toHaveBeenCalledTimes(1);
      const original = await state.fixture
        .sql`SELECT id,result FROM admin_job WHERE type='configuration.apply'`;
      expect(original).toHaveLength(1);
      expect(original[0]!.result.integrationReload.state).toBe("attempted");
      await state.fixture.sql.unsafe(`DROP TRIGGER reject_credential_completion ON admin_job`);
      await state.fixture
        .sql`UPDATE admin_job SET result=jsonb_set(result,'{_observationLeaseUntil}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE type='configuration.apply'`;
      const recovered = await credential("PUT", before.configurationRevision, key);
      expect(recovered.statusCode, recovered.body).toBe(200);
      expect(recovered.json().runtime).toBe("applied");
      expect(reload).toHaveBeenCalledTimes(1);
      const current = await state.fixture
        .sql`SELECT id,status FROM admin_job WHERE type='configuration.apply'`;
      expect(current).toEqual([{ id: original[0]!.id, status: "success" }]);
    }, 90000);
    it("locks real service host fields and resource knobs, then permits explicit adoption after removal", async () => {
      vi.stubEnv("SERVICE_MOTIS_REGION", "host-region");
      vi.stubEnv("SERVICE_MOTIS_TOKEN", "host-private");
      writeFileSync(join(host.infraDir, ".env"), "MOTIS_SLOT_MEMORY=8g\n");
      const view = await api.inject({ url: "/api/admin/services/motis/config", headers });
      expect(view.statusCode, view.body).toBe(200);
      expect(view.json().ownership.REGION).toMatchObject({ source: "env", writable: false });
      expect(view.json().ownership.OPENMAPX_MEMORY_MIB).toMatchObject({
        source: "env",
        writable: false,
        envVar: "MOTIS_SLOT_MEMORY",
      });
      expect(view.body).not.toContain("host-private");
      for (const config of [{ REGION: "new" }, { OPENMAPX_MEMORY_MIB: 1024 }]) {
        (await import("../utils/rate-limit")).serviceActionLimit.reset();
        const refused = await api.inject({
          method: "POST",
          url: "/api/admin/services/motis/config",
          headers: { ...headers, "idempotency-key": `ownership-${randomUUID()}` },
          payload: { config },
        });
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json()).toMatchObject({
          code: "CONFIGURATION_SOURCE_OWNED",
          ownership: { writable: false },
        });
      }
      const key = `ownership-${randomUUID()}`;
      for (const method of ["PUT", "DELETE"] as const) {
        (await import("../utils/rate-limit")).serviceActionLimit.reset();
        const refused = await api.inject({
          method,
          url: "/api/admin/services/motis/credentials/TOKEN",
          headers: { ...headers, "idempotency-key": method + key },
          ...(method === "PUT" ? { payload: { value: "new-private" } } : {}),
        });
        expect(refused.statusCode, refused.body).toBe(409);
      }
      expect(await state.fixture.sql`SELECT * FROM service_config`).toHaveLength(0);
      expect(await state.fixture.sql`SELECT * FROM service_secret`).toHaveLength(0);
      vi.stubEnv("SERVICE_MOTIS_REGION", "");
      vi.stubEnv("SERVICE_MOTIS_TOKEN", "");
      rmSync(join(host.infraDir, ".env"));
      (await import("../utils/rate-limit")).serviceActionLimit.reset();
      const adopted = await api.inject({
        method: "POST",
        url: "/api/admin/services/motis/config",
        headers: { ...headers, "idempotency-key": `adopt-${randomUUID()}` },
        payload: { config: { REGION: "new" } },
      });
      expect(adopted.statusCode, adopted.body).toBe(200);
      expect(
        (await state.fixture.sql`SELECT config FROM service_config WHERE service_id='motis'`)[0]!
          .config,
      ).toEqual({ REGION: "new" });
    }, 90000);
    async function credentials() {
      const response = await api.inject({ url: "/api/admin/credentials/binding-test", headers });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    }
    async function credential(method: "PUT" | "DELETE", revision: string, key = randomUUID()) {
      (await import("../utils/rate-limit")).serviceActionLimit.reset();
      return api.inject({
        method,
        url: "/api/admin/credentials/binding-test/TOKEN",
        headers: { ...headers, "idempotency-key": key },
        payload: {
          expectedRevision: revision,
          ...(method === "PUT" ? { value: "new-synthetic-token" } : {}),
        },
      });
    }
    it.each(["env", "config.json"] as const)(
      "refuses %s-shadowed vault changes without writes, then explicitly rotates and deletes",
      async (source) => {
        const directory = join(host.root, "integrations/binding-test"),
          path = join(directory, "config.json");
        if (source === "env") vi.stubEnv("INTEGRATION_BINDING_TEST_TOKEN", "host-private-token");
        else writeFileSync(path, JSON.stringify({ TOKEN: "host-private-token" }));
        const before = await credentials(),
          reload = vi.spyOn(await import("../integration-host"), "reloadIntegrations");
        expect(
          before.credentials.find((field: { key: string }) => field.key === "TOKEN"),
        ).toMatchObject({
          source,
          ownership: { writable: false, adoption: "host_action_required" },
        });
        expect(JSON.stringify(before)).not.toContain("host-private-token");
        for (const method of ["PUT", "DELETE"] as const) {
          const key = randomUUID(),
            rejected = await credential(method, before.configurationRevision, key);
          expect(rejected.statusCode, rejected.body).toBe(409);
          expect(rejected.json()).toMatchObject({ code: "CONFIGURATION_SOURCE_OWNED" });
          expect((await credential(method, before.configurationRevision, key)).statusCode).toBe(
            409,
          );
        }
        expect(await state.fixture.sql`SELECT * FROM integration_secret`).toHaveLength(0);
        expect(await state.fixture.sql`SELECT * FROM integration_config`).toHaveLength(0);
        expect(reload).not.toHaveBeenCalled();
        if (source === "env") vi.stubEnv("INTEGRATION_BINDING_TEST_TOKEN", "");
        else rmSync(path);
        const refreshed = await credentials();
        const applied = await credential("PUT", refreshed.configurationRevision);
        expect(applied.statusCode, applied.body).toBe(200);
        expect(applied.json().runtime).toBe("applied");
        expect((await api.inject("/api/integrations/binding-test/credential")).json()).toEqual({
          rotated: true,
        });
        const current = await credentials();
        expect(current.credentials[0]).toMatchObject({
          source: "vault",
          ownership: { writable: true },
        });
        const removed = await credential("DELETE", current.configurationRevision);
        expect(removed.statusCode, removed.body).toBe(200);
        expect(removed.json().runtime).toBe("applied");
        expect((await api.inject("/api/integrations/binding-test/credential")).json()).toEqual({
          rotated: false,
        });
        expect(await state.fixture.sql`SELECT * FROM integration_secret`).toHaveLength(0);
      },
      90000,
    );
    it("does not report applied when a host file changes after committed generation", async () => {
      const before = await credentials();
      driftAfterCommit = true;
      const result = await credential("PUT", before.configurationRevision);
      expect(driftAfterCommit).toBe(false);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({
        database: "retained",
        runtime: "failed",
        reason: "reload_failed",
      });
      expect((await api.inject("/api/integrations/binding-test/credential")).json()).toEqual({
        rotated: false,
      });
      expect(await state.fixture.sql`SELECT * FROM integration_secret`).toHaveLength(1);
      expect(result.body).not.toContain("new-synthetic-token");
      expect(result.body).not.toContain("host-drift-token");
    }, 90000);
    it.each(["service-query", "vault", "file"] as const)(
      "refuses unavailable strict %s acquisition before admission",
      async (failure) => {
        const run = vi.spyOn(host.runtime, "stack.render"),
          path = join(host.root, "integrations/binding-test/config.json");
        if (failure === "service-query")
          await state.fixture.sql`ALTER TABLE service_config RENAME TO unavailable_service_config`;
        if (failure === "file") writeFileSync(path, "{malformed");
        if (failure === "vault") {
          const encrypted = (await import("./secrets")).encrypt("private-value");
          await state.fixture
            .sql`INSERT INTO integration_secret(id,integration_id,key,ciphertext,iv,tag) VALUES (${randomUUID()},'binding-test','TOKEN','invalid',${encrypted.iv},${encrypted.tag})`;
        }
        try {
          expect(await state.fixture.sql`SELECT * FROM capability_binding`).toHaveLength(1);
          const rejected = await credential("PUT", "a".repeat(64));
          expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
          expect(await state.fixture.sql`SELECT * FROM integration_config`).toHaveLength(0);
          expect(await state.fixture.sql`SELECT * FROM integration_secret`).toHaveLength(
            failure === "vault" ? 1 : 0,
          );
          expect(run).not.toHaveBeenCalled();
        } finally {
          if (failure === "service-query")
            await state.fixture
              .sql`ALTER TABLE unavailable_service_config RENAME TO service_config`;
        }
      },
      90000,
    );
    it("rejects managed transit writes before malformed body validation, including an undeclared key", async () => {
      for (const method of ["PUT", "DELETE"] as const) {
        (await import("../utils/rate-limit")).serviceActionLimit.reset();
        const result = await api.inject({
          method,
          url: "/api/admin/services/data-manager/credentials/TRANSITOUS_API_KEYS",
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { unexpected: true },
        });
        expect(result.statusCode, result.body).toBe(409);
        expect(result.json()).toMatchObject({ code: "transit_credentials_managed" });
      }
      expect(await state.fixture.sql`SELECT * FROM service_secret`).toHaveLength(0);
    });
    it("serializes binding and mixed import or refuses the busy writer without a partial candidate", async () => {
      const before = await desired(),
        { jobRunner } = await import("./job-runner"),
        { createDirectAdminOpsKey } = await import("./direct-ops-idempotency");
      const results = await Promise.allSettled([
        jobRunner.applyImmediateIntegrationBinding({
          actorId: "loopback",
          operationKey: createDirectAdminOpsKey("loopback", randomUUID()),
          input: {
            integrationId: "binding-test",
            capability: "routing-engine",
            expectedServiceId: "motis",
            expectedRevision: before.revision,
            serviceId: "engine-b",
          },
        }),
        jobRunner.importImmediateIntegrationConfiguration({
          actorId: "loopback",
          operationKey: createDirectAdminOpsKey("loopback", randomUUID()),
          body: {
            integrations: [{ integrationId: "binding-test", config: { ENDPOINT: "new-endpoint" } }],
          },
        }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled").length,
      ).toBeGreaterThanOrEqual(1);
      for (const [index, result] of results.entries())
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(
            (await import("./admin-job-failure")).JobObservationPending,
          );
          const type = index === 0 ? "integration.binding.apply" : "integration.config.import";
          const rows = await state.fixture.sql`SELECT result FROM admin_job WHERE type=${type}`;
          expect(rows.length).toBeLessThanOrEqual(1);
          for (const row of rows) expect(row.result._configurationCandidate).toBeUndefined();
        }
      if (results[0]!.status === "rejected") {
        expect((await desired()).bindings).toEqual([
          { capability: "routing-engine", serviceId: "motis" },
        ]);
        const current = await desired(),
          applied = await set({
            serviceId: "engine-b",
            expectedServiceId: "motis",
            expectedRevision: current.revision,
          });
        expect(applied.statusCode, applied.body).toBe(200);
        expect(applied.json().runtime).toBe("applied");
      }
      if (results[1]!.status === "rejected") {
        expect(await state.fixture.sql`SELECT * FROM integration_config`).toHaveLength(0);
        const imported = await jobRunner.importImmediateIntegrationConfiguration({
          actorId: "loopback",
          operationKey: createDirectAdminOpsKey("loopback", randomUUID()),
          body: {
            integrations: [{ integrationId: "binding-test", config: { ENDPOINT: "new-endpoint" } }],
          },
        });
        expect(imported.ok).toBe(true);
      }
      expect((await desired()).runtime.bindings["routing-engine"]).toBe("engine-b");
      expect(
        (
          await state.fixture
            .sql`SELECT config FROM integration_config WHERE integration_id='binding-test'`
        )[0]!.config,
      ).toMatchObject({ ENDPOINT: "new-endpoint" });
    }, 90000);
    it("rolls back binding, revision and application receipt together on an actual SQL constraint failure", async () => {
      const before = await desired();
      await state.fixture
        .sql`ALTER TABLE integration_application_receipt ADD CONSTRAINT fixture_reject_binding CHECK (capability <> 'routing-engine')`;
      const refused = await set({
        serviceId: "engine-b",
        expectedServiceId: "motis",
        expectedRevision: before.revision,
      });
      expect(refused.statusCode).not.toBe(200);
      expect((await desired()).revision).toBe(before.revision);
      expect(await state.fixture.sql`SELECT * FROM integration_application_receipt`).toHaveLength(
        0,
      );
      expect((await api.inject("/api/integrations/binding-test/bound")).json()).toEqual({
        serviceId: "motis",
      });
    }, 90000);
  },
);
