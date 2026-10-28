import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as nativeDelay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { closeControlInstallation, openControlInstallation } from "@openmapx/core/build-artifacts";
import { services } from "@openmapx/core/server";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownedServiceHost } from "../../../../ops-agent/src/__fixtures__/owned-service-host";
import { openOpsJobJournal } from "../../../../ops-agent/src/journal";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import * as schema from "../../db/schema";
import { createConfigurationPostgresFixture } from "../../test/configuration-postgres-fixture";
import { postgresCommitRelay } from "../__tests__/fixtures/postgres-commit-relay";

type Fixture = Awaited<ReturnType<typeof createConfigurationPostgresFixture>>;
const state = vi.hoisted(() => ({
  fixture: null as unknown as Fixture,
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

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "current ordinary import actual route / PostgreSQL / agent",
  () => {
    let fixture: Fixture, host: Awaited<ReturnType<typeof ownedServiceHost>>;
    let agent: ReturnType<typeof buildOpsAgentServer>, api: ReturnType<typeof Fastify>;
    let installation: ReturnType<typeof openControlInstallation>;
    let driftRegistryAfterApply = false;
    let renderPosts = 0;
    let driftRowAfterPreview = false;
    const configSchema = {
      properties: {
        VALUE: { type: "string", default: "default" },
        OMIT: { type: "integer" },
        TOKEN: { type: "string", "x-openmapx-secret": true },
        ...Object.fromEntries(
          Array.from({ length: 5 }, (_, n) => [`BLOCK${n}`, { type: "string" }]),
        ),
      },
    };
    beforeEach(async () => {
      fixture = await createConfigurationPostgresFixture();
      state.fixture = fixture;
      host = await ownedServiceHost();
      state.loaded = host.loaded;
      const integrationRoot = join(host.root, "integrations");
      mkdirSync(integrationRoot);
      for (const id of ["alpha", "beta", "unrelated"]) {
        const directory = join(integrationRoot, id);
        mkdirSync(directory);
        writeFileSync(
          join(directory, "manifest.json"),
          JSON.stringify({
            id,
            version: "1.0.0",
            author: "Task01.2 fixture",
            license: "MIT",
            domains: ["knowledge"],
            quality: "built-in",
            configSchema,
          }),
        );
      }
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
      driftRegistryAfterApply = false;
      renderPosts = 0;
      driftRowAfterPreview = false;
      agent.addHook("onSend", async (request, _reply, payload) => {
        if (
          request.method === "POST" &&
          (request.body as { operation?: { kind?: string } })?.operation?.kind === "stack.render"
        )
          renderPosts++;
        if (
          driftRowAfterPreview &&
          (request.body as { operation?: { kind?: string } })?.operation?.kind ===
            "configuration.hardlinks.preview"
        ) {
          driftRowAfterPreview = false;
          // A second real connection writes outside the advisory protocol. The
          // retained snapshot/version checks must refuse both import overlays.
          await fixture.sql`UPDATE integration_config SET config='{"VALUE":"external-race"}'::jsonb WHERE integration_id='beta'`;
        }
        if (
          driftRegistryAfterApply &&
          request.method === "GET" &&
          request.url.startsWith("/v1/operations/") &&
          typeof payload === "string"
        ) {
          const response = JSON.parse(payload);
          if (response.result?.result?.outcome === "committed") {
            driftRegistryAfterApply = false;
            const path = join(integrationRoot, "alpha/manifest.json");
            writeFileSync(
              path,
              JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), version: "1.0.1" }),
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
        OPENMAPX_LOCAL_ADMIN_TOKEN: "task012-owned-local-admin",
        OPENMAPX_DISABLE_LOCALHOST_AUTH: "0",
        BETTER_AUTH_SECRET: "task012-owned-synthetic-auth-secret-only",
        BETTER_AUTH_URL: "http://localhost:3001",
      }))
        vi.stubEnv(key, value);
      api = Fastify({ logger: false });
      const { initIntegrations } = await import("../../integration-host");
      await initIntegrations(api, [{ directory: integrationRoot, isBuiltIn: true }]);
      const { requireAdmin } = await import("../../utils/require-admin");
      api.addHook("preHandler", async (request: import("fastify").FastifyRequest) => {
        request.adminSession = await requireAdmin(request);
      });
      const { adminIntegrationsRoute } = await import("../../routes/admin-integrations");
      await api.register(adminIntegrationsRoute, { prefix: "/api" });
      await api.ready();
    });
    afterEach(async () => {
      const { shutdownIntegrations } = await import("../../integration-host");
      await shutdownIntegrations();
      await api?.close();
      await agent?.close();
      if (installation) closeControlInstallation(installation);
      await fixture?.stop();
      if (host) rmSync(host.root, { recursive: true, force: true });
      vi.unstubAllEnvs();
      state.loaded = [];
    });
    function submit(
      integrations: { integrationId: string; config: Record<string, unknown> }[],
      key = `ordinary-import-${randomUUID()}`,
    ) {
      return api.inject({
        method: "POST",
        url: "/api/admin/integrations/import",
        remoteAddress: "127.0.0.1",
        headers: { "x-openmapx-local-admin": "task012-owned-local-admin", "idempotency-key": key },
        payload: { integrations },
      });
    }
    it.each(["saved", "applied", "before-retirement", "after-retirement"])(
      "recovers the original ordinary import through native API death and actual HTTP (mode=%s)",
      async (mode) => {
        const retirement = mode.includes("retirement"),
          retired = mode === "after-retirement";
        const idempotencyKey = `ordinary-native-${randomUUID()}`,
          database = new URL(process.env.OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL!);
        database.searchParams.set("search_path", fixture.schema);
        const relay = await postgresCommitRelay(
          database,
          async () => {
            const rows =
              await fixture.sql`SELECT result FROM admin_job WHERE type='integration.config.import' LIMIT 2`;
            if (rows.length !== 1) return false;
            const c = rows[0]!.result?._configurationCandidate;
            if (mode === "before-retirement") return false;
            if (retirement)
              return (
                c?.phase === "settled" &&
                c.retirement?.version === 1 &&
                existsSync(join(host.queue, ".candidates", `${c.sealedOperationKey}.json`)) !==
                  retired
              );
            if (c?.phase !== "saved") return false;
            return (
              mode !== "applied" ||
              Object.values(rows[0]!.result?.opsProjection?.operations ?? {}).some((value) => {
                const operation = value as {
                  kind?: string;
                  terminal?: boolean;
                  receiptDelivery?: { state?: string };
                };
                return (
                  operation.kind === "stack.render" &&
                  operation.terminal === true &&
                  operation.receiptDelivery?.state === "pending"
                );
              })
            );
          },
          { holdCommand: retirement ? (retired ? "API_TERMINAL_UPDATE" : "UPDATE") : "COMMIT" },
        );
        const loader = createRequire(new URL("../../../package.json", import.meta.url)).resolve(
            "tsx/esm",
          ),
          script = fileURLToPath(
            new URL("../__tests__/fixtures/native-integration-import-api.ts", import.meta.url),
          ),
          children: ReturnType<typeof spawn>[] = [];
        const start = (replacement = false) => {
          const args = ["--import", loader, script],
            child = spawn(process.execPath, args, {
              cwd: host.root,
              stdio: ["pipe", "pipe", "pipe"],
              env: {
                ...process.env,
                DATABASE_URL: relay.databaseUrl,
                OPENMAPX_ROOT_DIR: host.root,
                NODE_ENV: "test",
                REDIS_URL: "",
                REDIS_PASSWORD_FILE: "",
                ...(replacement
                  ? { INTEGRATION_ALPHA_VALUE: "synthetic-later-process-environment" }
                  : {}),
              },
            });
          let output = "";
          children.push(child);
          child.stdout!.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr!.on("data", () => {});
          const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code, signal) => {
                console.info(
                  JSON.stringify({
                    proof: "native-import-api-exit",
                    argv: [process.execPath, ...args],
                    code,
                    signal,
                  }),
                );
                resolve({ code, signal });
              });
            },
          );
          child.stdin!.end(
            JSON.stringify({
              idempotencyKey,
              ...(mode === "before-retirement" && children.length === 1
                ? { filesystemFault: "pause-retirement-unlink" }
                : {}),
            }),
          );
          return {
            child,
            exited,
            result: () =>
              output
                .split("\n")
                .flatMap((line) => {
                  try {
                    const value = JSON.parse(line);
                    return value.event === "result" ? [value] : [];
                  } catch {
                    return [];
                  }
                })
                .at(-1) as
                | { capturedOrdinaryValueMatches?: boolean; betaDisabled?: boolean }
                | undefined,
          };
        };
        const first = start();
        try {
          const beforeUnlink = async () => {
            const until = Date.now() + 30000;
            while (!existsSync(join(host.root, "retirement-unlink-paused"))) {
              if (Date.now() > until) throw Error("Actual retirement unlink not reached");
              await nativeDelay(20);
            }
          };
          await Promise.race([
            mode === "before-retirement" ? beforeUnlink() : relay.reached,
            first.exited.then(() => {
              throw Error("Native import API exited before original saved checkpoint");
            }),
          ]);
          const [original] = await fixture.db.select().from(schema.adminJob),
            checkpoint = original!.result as Record<string, unknown>,
            candidate = checkpoint._configurationCandidate as Record<string, unknown>,
            path = join(host.queue, ".candidates", `${candidate.sealedOperationKey}.json`),
            bytes = retired ? undefined : readFileSync(path),
            versions =
              await fixture.sql`SELECT integration_id,xmin::text AS version FROM integration_config ORDER BY integration_id`;
          expect(versions).toHaveLength(2);
          expect(renderPosts).toBe(mode === "applied" || retirement ? 1 : 0);
          first.child.kill("SIGKILL");
          expect((await first.exited).signal).toBe("SIGKILL");
          relay.release();
          const [retained] = await fixture.db.select().from(schema.adminJob),
            lease = Date.parse(
              (retained!.result as Record<string, unknown>)._observationLeaseUntil as string,
            );
          expect(Number.isFinite(lease)).toBe(true);
          while (Date.now() <= lease + 100)
            await nativeDelay(Math.min(1000, lease + 101 - Date.now()));
          expect(retired ? !existsSync(path) : readFileSync(path).equals(bytes!)).toBe(true);
          const replacement = start(!retirement);
          expect((await replacement.exited).code).toBe(0);
          expect(replacement.result()).toMatchObject({
            capturedOrdinaryValueMatches: true,
            betaDisabled: true,
          });
          const [finished] = await fixture.db.select().from(schema.adminJob),
            result = finished!.result as Record<string, unknown>;
          expect(finished!.id).toBe(original!.id);
          expect(finished!.status).toBe("success");
          expect(result._execution).toMatchObject({ version: 2 });
          expect(result.integrationImport).toMatchObject({
            ok: true,
            imported: 2,
            skipped: [],
            reloaded: 3,
            enabled: 2,
          });
          expect(result.integrationReload).toMatchObject({
            state: "complete",
            candidateId: candidate.candidateId,
            revisionId: candidate.revisionId,
          });
          expect(
            await fixture.sql`SELECT integration_id,xmin::text AS version FROM integration_config ORDER BY integration_id`,
          ).toEqual(versions);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(candidate.revisionId);
          expect(renderPosts).toBe(1);
          expect(readdirSync(join(host.queue, ".candidates"))).toEqual([]);
          expect(JSON.stringify(result)).not.toMatch(/synthetic-strip-this|native-new/);
          expect(
            host.calls.some(
              (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
            ),
          ).toBe(false);
          expect((await start().exited).code).toBe(0);
          const [duplicate] = await fixture.db.select().from(schema.adminJob);
          expect(duplicate!.result).toEqual(result);
          expect(renderPosts).toBe(1);
          console.info(
            JSON.stringify({
              proof: "native-import-original-recovered",
              originalJobId: original!.id,
              candidateId: candidate.candidateId,
              renderPosts,
              rowVersionsUnchanged: true,
              retainedBytesConsumed: true,
              mode,
            }),
          );
        } finally {
          relay.release();
          for (const child of children)
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await relay.close();
        }
      },
      180000,
    );
    it("replaces two ordinary rows in one candidate, preserving enabled, legacy secrets, vault and unrelated state", async () => {
      const { encrypt } = await import("../secrets");
      await fixture.db.insert(schema.integrationConfig).values([
        {
          id: randomUUID(),
          integrationId: "alpha",
          config: { VALUE: "old", OMIT: 2, enabled: false, TOKEN: "legacy-secret" },
        },
        { id: randomUUID(), integrationId: "beta", config: { VALUE: "old-b", enabled: true } },
        { id: randomUUID(), integrationId: "unrelated", config: { VALUE: "retain" } },
      ]);
      await fixture.db.insert(schema.integrationSecret).values({
        id: randomUUID(),
        integrationId: "alpha",
        key: "TOKEN",
        ...encrypt("vault-secret"),
      });
      const key = `ordinary-import-${randomUUID()}`,
        body = [
          { integrationId: "alpha", config: { VALUE: "new", TOKEN: "supplied-must-be-stripped" } },
          { integrationId: "beta", config: { VALUE: "new-b", enabled: false } },
        ];
      const response = await submit(body, key);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, imported: 2 });
      const rows = await fixture.db.select().from(schema.integrationConfig);
      expect(rows.find((row) => row.integrationId === "alpha")?.config).toEqual({
        VALUE: "new",
        TOKEN: "legacy-secret",
        enabled: false,
      });
      expect(rows.find((row) => row.integrationId === "beta")?.config).toEqual({
        VALUE: "new-b",
        enabled: false,
      });
      expect(rows.find((row) => row.integrationId === "unrelated")?.config).toEqual({
        VALUE: "retain",
      });
      expect(await fixture.db.select().from(schema.integrationSecret)).toHaveLength(1);
      const { getIntegration } = await import("../../integration-host");
      expect(getIntegration("alpha")).toMatchObject({
        enabled: false,
        config: { VALUE: "new", TOKEN: "vault-secret" },
      });
      const jobs = await fixture.db.select().from(schema.adminJob);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ type: "integration.config.import", status: "success" });
      expect(JSON.stringify(jobs[0])).not.toMatch(
        /supplied-must-be-stripped|legacy-secret|vault-secret/,
      );
      expect((await submit(body, key)).json()).toEqual(response.json());
      expect(await fixture.db.select().from(schema.adminJob)).toHaveLength(1);
      expect(host.calls.some((args) => args.includes("up") || args.includes("pull"))).toBe(false);
      expect(readdirSync(join(host.queue, ".candidates"))).toEqual([]);
    });
    it("refuses whole-envelope oversize before ordinary rows, effects or consumable publication", async () => {
      const config = Object.fromEntries(
        Array.from({ length: 5 }, (_, n) => [`BLOCK${n}`, "ü".repeat(60000)]),
      );
      await fixture.db
        .insert(schema.integrationConfig)
        .values({ id: randomUUID(), integrationId: "unrelated", config });
      const response = await submit([
        { integrationId: "alpha", config: { VALUE: "changed" } },
        { integrationId: "beta", config: { VALUE: "changed-b" } },
      ]);
      expect(response.statusCode).toBe(409);
      const retained = await fixture.db.select().from(schema.integrationConfig);
      expect(retained.map((row) => row.integrationId)).toEqual(["unrelated"]);
      expect(retained[0]?.config === null ? 0 : JSON.stringify(retained[0]?.config).length).toBe(
        JSON.stringify(config).length,
      );
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      expect(readdirSync(host.queue).filter((name) => name.startsWith("cfg1_"))).toEqual([]);
      expect(host.calls.some((args) => args.includes("up") || args.includes("pull"))).toBe(false);
    });
    it("refuses both overlays after a real row race at the captured preview boundary", async () => {
      await fixture.db.insert(schema.integrationConfig).values([
        { id: randomUUID(), integrationId: "alpha", config: { VALUE: "old-a" } },
        { id: randomUUID(), integrationId: "beta", config: { VALUE: "old-b" } },
      ]);
      driftRowAfterPreview = true;
      const response = await submit([
        { integrationId: "beta", config: { VALUE: "new-b" } },
        { integrationId: "alpha", config: { VALUE: "new-a" } },
      ]);
      expect(response.statusCode).toBe(409);
      expect(driftRowAfterPreview).toBe(false);
      const rows = await fixture.db.select().from(schema.integrationConfig);
      expect(rows.find((row) => row.integrationId === "alpha")?.config).toEqual({ VALUE: "old-a" });
      expect(rows.find((row) => row.integrationId === "beta")?.config).toEqual({
        VALUE: "external-race",
      });
      expect(renderPosts).toBe(0);
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      expect(readdirSync(host.queue).filter((name) => name.startsWith("cfg1_"))).toEqual([]);
      expect(readdirSync(join(host.queue, ".candidates"))).toEqual([]);
    });
    it("refuses the whole import at actual shared queue capacity before any desired write", async () => {
      const { buildConfigurationInput } = await import("../trusted-config-operations"),
        { publishTrustedConfigurationSnapshot } = await import("../trusted-config-publisher"),
        { executeAndWait, createApiOpsClient, createDurableOpsKey } = await import("../ops-client"),
        source = await executeAndWait(
          createApiOpsClient(),
          { kind: "configuration.sources.inspect" },
          createDurableOpsKey("configuration.sources.inspect", randomUUID()),
        ),
        payload = await buildConfigurationInput();
      // Actual inert producer packets, never admitted as effects or signed grants.
      for (let n = 0; n < 128; n++)
        await publishTrustedConfigurationSnapshot({
          directory: host.queue,
          token: host.token,
          ownerUid: statSync(host.queue).uid,
          ownerGid: statSync(host.queue).gid,
          operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
          operationForRevision: (revisionId) => ({
            kind: "stack.render",
            revisionId,
            expectedCurrentRevisionId: source.revisionId,
            expectedSourceRevision: source.sourceRevision,
            coordinatorMode: "ensure-running",
          }),
          payload,
        });
      const before = readdirSync(host.queue)
        .filter((name) => name.startsWith("cfg1_"))
        .sort();
      expect(before).toHaveLength(128);
      const response = await submit([
        { integrationId: "alpha", config: { VALUE: "must-not-save" } },
        { integrationId: "beta", config: { VALUE: "must-not-save-b" } },
      ]);
      expect(response.statusCode).toBe(409);
      expect(await fixture.db.select().from(schema.integrationConfig)).toEqual([]);
      expect(
        readdirSync(host.queue)
          .filter((name) => name.startsWith("cfg1_"))
          .sort(),
      ).toEqual(before);
      expect(readdirSync(join(host.queue, ".candidates"))).toEqual([]);
      expect(renderPosts).toBe(0);
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      expect(
        host.calls.some(
          (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
        ),
      ).toBe(false);
    }, 60000);
    it.each(["host-source", "unknown-unchanged", "malformed-legacy-secret", "invalid-second-row"])(
      "refuses %s before changing either import target",
      async (reason) => {
        if (reason === "host-source") vi.stubEnv("INTEGRATION_ALPHA_VALUE", "host-owned");
        if (reason === "unknown-unchanged")
          await fixture.db.insert(schema.integrationConfig).values({
            id: randomUUID(),
            integrationId: "unrelated",
            config: { UNKNOWN: "must-not-drop" },
          });
        if (reason === "malformed-legacy-secret")
          await fixture.db
            .insert(schema.integrationConfig)
            .values({ id: randomUUID(), integrationId: "unrelated", config: { TOKEN: 17 } });
        const response = await submit([
          { integrationId: "alpha", config: { VALUE: "new" } },
          {
            integrationId: "beta",
            config: { VALUE: reason === "invalid-second-row" ? 17 : "new-b" },
          },
        ]);
        expect(response.statusCode).toBe(reason === "invalid-second-row" ? 400 : 409);
        const rows = await fixture.db.select().from(schema.integrationConfig);
        expect(
          rows.some((row) => row.integrationId === "alpha" || row.integrationId === "beta"),
        ).toBe(false);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        expect(readdirSync(host.queue).filter((name) => name.startsWith("cfg1_"))).toEqual([]);
      },
    );
    it("keeps the imported ordinary enabled flag through an actual integration host cold restart", async () => {
      expect(
        (await submit([{ integrationId: "alpha", config: { enabled: false } }])).statusCode,
      ).toBe(200);
      const { getIntegration, shutdownIntegrations, initIntegrations } = await import(
        "../../integration-host"
      );
      expect(getIntegration("alpha")?.enabled).toBe(false);
      await shutdownIntegrations();
      await api.close();
      api = Fastify({ logger: false });
      await initIntegrations(api, [
        { directory: join(host.root, "integrations"), isBuiltIn: true },
      ]);
      expect(getIntegration("alpha")?.enabled).toBe(false);
    });
    it("retains an unresolved candidate fence after actual reload source drift and refuses a later writer", async () => {
      driftRegistryAfterApply = true;
      const response = await submit([
        { integrationId: "alpha", config: { VALUE: "committed-before-drift" } },
      ]);
      expect(driftRegistryAfterApply).toBe(false);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ ok: false, phase: "reload", runtime: "unknown" });
      const [row] = await fixture.db.select().from(schema.integrationConfig);
      expect(row?.config).toEqual({ VALUE: "committed-before-drift" });
      const [job] = await fixture.db.select().from(schema.adminJob);
      expect((job?.result as Record<string, unknown>)._configurationCandidate).toMatchObject({
        phase: "unknown",
      });
      expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(1);
      const second = await submit([{ integrationId: "beta", config: { VALUE: "must-not-save" } }]);
      expect(second.statusCode).not.toBe(200);
      expect(
        (await fixture.db.select().from(schema.integrationConfig)).map((row) => row.integrationId),
      ).toEqual(["alpha"]);
    });
    it("rolls back the first ordinary row and saved checkpoint when PostgreSQL rejects the second row", async () => {
      await fixture.sql.unsafe(
        `ALTER TABLE "${fixture.schema}".integration_config ADD CHECK (integration_id <> 'beta' OR config->>'VALUE' <> 'deny-second-write')`,
      );
      const response = await submit([
        { integrationId: "alpha", config: { VALUE: "new" } },
        { integrationId: "beta", config: { VALUE: "deny-second-write" } },
      ]);
      expect(response.statusCode).toBe(409);
      expect(await fixture.db.select().from(schema.integrationConfig)).toEqual([]);
      const [job] = await fixture.db.select().from(schema.adminJob);
      expect((job?.result as Record<string, unknown>)?._configurationCandidate).toMatchObject({
        phase: "settled",
        saved: "conflict",
      });
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
    });
    it("reports an unchanged batch without a candidate, apply admission or generation change", async () => {
      await fixture.db.insert(schema.integrationConfig).values({
        id: randomUUID(),
        integrationId: "alpha",
        config: { VALUE: "same", enabled: false },
      });
      const response = await submit([
        { integrationId: "alpha", config: { VALUE: "same", TOKEN: "stripped" } },
      ]);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        imported: 0,
        skipped: ["alpha"],
        reloaded: 0,
      });
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      const [job] = await fixture.db.select().from(schema.adminJob);
      expect((job?.result as Record<string, unknown>)?._configurationCandidate).toBeUndefined();
    });
    it("returns only the declared import DTO through the generated SDK and actual loopback HTTP", async () => {
      const { createApiClient } = await import("@openmapx/core");
      const sdk = await import("@openmapx/core/api-admin-sdk");
      const baseUrl = await api.listen({ host: "127.0.0.1", port: 0 });
      const client = createApiClient({ baseUrl }),
        headers = { "idempotency-key": `ordinary-sdk-${randomUUID()}` };
      const body = {
        integrations: [
          {
            integrationId: "alpha",
            config: { VALUE: "sdk-value", TOKEN: "stripped-before-retention" },
          },
          { integrationId: "beta", config: { VALUE: "sdk-b", enabled: false } },
        ],
      };
      const options = {
        client,
        headers: { "x-openmapx-local-admin": "task012-owned-local-admin" },
      };
      const response = await sdk.importAdminIntegrationConfigs(body, headers, options);
      expect(response).toMatchObject({
        status: 200,
        data: { ok: true, imported: 2, reloaded: 3, enabled: 2 },
      });
      expect(Object.keys(response.data).sort()).toEqual([
        "enabled",
        "imported",
        "message",
        "ok",
        "reloaded",
        "skipped",
      ]);
      expect(await sdk.importAdminIntegrationConfigs(body, headers, options)).toEqual(response);
      const jobs = await fixture.db.select().from(schema.adminJob);
      expect(jobs).toHaveLength(1);
      expect(JSON.stringify(jobs)).not.toContain("stripped-before-retention");
    });
    it("issues only a writer-bound immutable legacy participant and validates its real candidate", async () => {
      const writer = await import("../administrative-configuration-writer");
      const subject = await import("./legacy-integration-import");
      const prospective = await import("../prospective-configuration");
      const { checkpointOwnedAdminJob } = await import("../admin-job-checkpoint");
      const { encrypt } = await import("../secrets");
      await fixture.db.insert(schema.integrationConfig).values([
        {
          id: randomUUID(),
          integrationId: "alpha",
          config: { VALUE: "old", OMIT: 2, enabled: false, TOKEN: "legacy-secret" },
        },
        { id: randomUUID(), integrationId: "beta", config: { VALUE: "old-b", enabled: true } },
      ]);
      await fixture.db.insert(schema.integrationSecret).values({
        id: randomUUID(),
        integrationId: "alpha",
        key: "TOKEN",
        ...encrypt("vault-secret"),
      });
      const jobId = randomUUID(),
        execution = { owner: randomUUID(), version: 1 };
      await fixture.db.insert(schema.adminJob).values({
        id: jobId,
        type: "integration.config.import",
        status: "running",
        result: { _execution: execution },
      });
      const ctx: import("../job-runner").JobContext = {
        jobId,
        jobType: "integration.config.import",
        execution,
        payload: {},
        signal: new AbortController().signal,
        checkpointResult: { _execution: execution },
        log: async () => {},
        setProgress: async () => {},
        checkpoint: async (result, progress, admissionKey, stepAddress) => {
          ctx.checkpointResult = await checkpointOwnedAdminJob(
            jobId,
            execution,
            result,
            progress,
            admissionKey,
            stepAddress,
            ctx.checkpointResult ?? {},
          );
        },
      };
      await writer.withAdministrativeConfigurationJob(ctx, () =>
        writer.withAdministrativeConfigurationWriter(
          {
            actorId: "loopback",
            operationKey: `opk1_${jobId.replaceAll("-", "")}`,
            integrationIds: ["beta", "alpha"],
          },
          async (owned) => {
            const intent = await subject.prepareLegacyIntegrationImport(
              {
                integrations: [
                  { integrationId: "alpha", config: { VALUE: "new" } },
                  { integrationId: "beta", config: { VALUE: "b", enabled: false } },
                ],
              },
              owned,
            );
            expect(Object.isFrozen(intent)).toBe(true);
            expect(() =>
              subject.withLegacyIntegrationImport({ ...intent }, owned, async () => {}),
            ).toThrow();
            await subject.withLegacyIntegrationImport(intent, owned, async (overlay) => {
              expect(overlay.purpose).toBe("migration");
              const originalRows = await fixture.db
                .select()
                .from(schema.integrationConfig)
                .orderBy(schema.integrationConfig.integrationId);
              await expect(
                prospective.prepareProspectiveConfiguration({
                  actorId: "loopback",
                  operationKey: owned.operationKey,
                  expectedCurrentRevisionId: host.initial.revisionId,
                  overlay: {
                    ...overlay,
                    changes: [
                      {
                        kind: "integration-config",
                        integrationId: "alpha",
                        set: { VALUE: "foreign-intent" },
                        unset: [],
                      },
                    ],
                  },
                }),
              ).rejects.toThrow("Ordinary integration import unavailable");
              expect(
                await fixture.db
                  .select()
                  .from(schema.integrationConfig)
                  .orderBy(schema.integrationConfig.integrationId),
              ).toEqual(originalRows);
              const candidate = await prospective.prepareProspectiveConfiguration({
                actorId: "loopback",
                operationKey: owned.operationKey,
                expectedCurrentRevisionId: host.initial.revisionId,
                overlay,
              });
              expect(candidate.sealedBytes).toBeLessThan(524288);
            });
          },
        ),
      );
    });
  },
);
