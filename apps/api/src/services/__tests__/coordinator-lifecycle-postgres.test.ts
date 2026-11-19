import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import filesystem, {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  acquireArtifactTargetLease,
  assertCoordinatorPullLeaseCompatibility,
  closeControlInstallation,
  leaseStoreDirectory,
  openControlInstallation,
  openLeaseStore,
  releaseArtifactTargetLease,
  restoreAdmittedControlExecution,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  rootLeaseId,
  settleArtifactTargetLeaseChild,
  verifyControlEffectSettlement,
} from "@openmapx/core/build-artifacts";
import {
  createControlRootOperationKey,
  executionFingerprint,
  inspectPreparedConfigurationRecord,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyRequest } from "fastify";
import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldTargets } from "../../../../../packages/core/src/build-artifacts/__fixtures__/held-targets";
import { ownedDataManager } from "../../../../ops-agent/src/__fixtures__/owned-data-manager";
import { ownedServiceHost } from "../../../../ops-agent/src/__fixtures__/owned-service-host";
import { runContainedProcess } from "../../../../ops-agent/src/docker-runtime";
import { openOpsJobJournal } from "../../../../ops-agent/src/journal";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import * as schema from "../../db/schema";
import { createConfigurationPostgresFixture } from "../../test/configuration-postgres-fixture";
import { dataManagerTokenFile } from "../../test/data-manager-token";

/** The operation key of the coordinator pull a job sent, if it sent one. */
function pullOperationKeyOf(job: { protocol: unknown }): string | undefined {
  const recorded = (
    job.protocol as {
      operations?: { operations?: Record<string, { kind?: string; operationKey?: string }> };
    }
  )?.operations?.operations;
  return Object.values(recorded ?? {}).find((operation) => operation.kind === "service.pull")
    ?.operationKey;
}
/** The maintenance a job prepared, as its recorded prepare operation names it. */
function maintenanceIdOf(job: { protocol: unknown }): string | undefined {
  const recorded = (
    job.protocol as {
      operations?: { operations?: Record<string, { kind?: string; operation?: unknown }> };
    }
  )?.operations?.operations;
  const prepare = Object.values(recorded ?? {}).find(
    (operation) => operation.kind === "configurationMaintenance.prepare",
  );
  return (prepare?.operation as { maintenanceId?: string } | undefined)?.maintenanceId;
}

const coordinatorReferenceCases = [
  {
    name: "qualified sibling coordinator image alias",
    target: { image: "example/data-manager", tag: "1" },
    sibling: { image: "docker.io/example/data-manager", tag: "1" },
  },
  {
    name: "legacy index sibling coordinator image alias",
    target: { image: "ubuntu", tag: "latest" },
    sibling: { image: "index.docker.io/library/ubuntu", tag: "latest" },
  },
  {
    name: "default library sibling coordinator image alias",
    target: { image: "docker.io/ubuntu", tag: "latest" },
    sibling: { image: "ubuntu", tag: "latest" },
  },
  {
    name: "distinct sibling coordinator tags",
    target: { image: "example/data-manager", tag: "1" },
    sibling: { image: "example/data-manager", tag: "other" },
  },
];
type Fixture = Awaited<ReturnType<typeof createConfigurationPostgresFixture>>;
const state = vi.hoisted(() => ({ fixture: null as unknown as Fixture }));
// Only the database connection boundary is replaced; every query/transaction
// executes on the verified owned PostgreSQL instance and current schema copies.
vi.mock("../../db", () => ({
  get db() {
    return state.fixture.db;
  },
  get sql() {
    return state.fixture.sql;
  },
}));

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "actual coordinator lifecycle API / production agent / PostgreSQL",
  () => {
    let fixture: Fixture, host: Awaited<ReturnType<typeof ownedServiceHost>>;
    let dm: Awaited<ReturnType<typeof ownedDataManager>>;
    let agent: ReturnType<typeof buildOpsAgentServer>, api: ReturnType<typeof Fastify>;
    let installation: ReturnType<typeof openControlInstallation>;
    let refusedDecisionWrites = 0,
      issuedKnownRollbacks = 0;
    let nativeTrace: string;
    let pulledImageId: string | null;
    let afterImageStaging: (() => void) | undefined;
    let afterPullTerminal: (() => void) | undefined;
    let beforeLifecycleProcess: ((args: readonly string[]) => Promise<void>) | undefined;
    let decisionReplyGate: { reached: () => void; release: Promise<void> } | undefined;
    let pullTerminalReplyGate: { reached: () => void; release: Promise<void> } | undefined;
    const posts = new Map<string, number>();
    const arrivals = new Map<string, number>();

    beforeEach(async (test) => {
      fixture = await createConfigurationPostgresFixture();
      state.fixture = fixture;
      refusedDecisionWrites = 0;
      issuedKnownRollbacks = 0;
      if (test.task.name.includes("unused OLD runtime"))
        state.fixture = {
          ...fixture,
          sql: new Proxy(fixture.sql, {
            get(target, name, receiver) {
              if (name !== "reserve") return Reflect.get(target, name, receiver);
              return async () => {
                const reserved = await target.reserve();
                return new Proxy(reserved, {
                  get(connection, member, owned) {
                    if (member !== "unsafe") return Reflect.get(connection, member, owned);
                    return (
                      query: string,
                      // postgres v4 adds an `unsafe(query, options)` overload, which
                      // `Parameters<>` would pick; name the values parameter directly.
                      parameters?: postgres.ParameterOrJSON<never>[],
                    ) => {
                      const continuation = parameters?.some((value) => {
                        if (typeof value !== "string" || !value.startsWith("{")) return false;
                        try {
                          const v = JSON.parse(value);
                          return v.phase === "rows_saved" && Array.isArray(v.rowVersions);
                        } catch {
                          return false;
                        }
                      });
                      if (
                        refusedDecisionWrites === 0 &&
                        /^update "admin_job"/.test(query) &&
                        continuation
                      ) {
                        refusedDecisionWrites++;
                        throw Error("Named SQL continuation write refused before delivery");
                      }
                      if (refusedDecisionWrites && query === "ROLLBACK") issuedKnownRollbacks++;
                      return connection.unsafe(query, parameters);
                    };
                  },
                });
              };
            },
          }),
        };
      pulledImageId = null;
      afterImageStaging = undefined;
      afterPullTerminal = undefined;
      beforeLifecycleProcess = undefined;
      decisionReplyGate = undefined;
      pullTerminalReplyGate = undefined;
      vi.stubEnv("BETTER_AUTH_SECRET", "task012-coordinator-synthetic-auth-fixture");
      vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3001");
      vi.stubEnv("OPENMAPX_RELEASE", "local");
      vi.stubEnv("OPENMAPX_ENABLED_SERVICES", "");
      const references = coordinatorReferenceCases.find((value) =>
        test.task.name.includes(value.name),
      );
      host = await ownedServiceHost({
        withCoordinator: true,
        ...(test.task.name.includes("three-target") ? { extraServiceIds: ["valhalla"] } : {}),
        ...(test.task.name.includes("ordinary unrelated configuration")
          ? {
              schemas: {
                motis: { type: "object", properties: { MODE: { type: "string", default: "old" } } },
              },
            }
          : {}),
        ...(test.task.name.includes("installed credential follow-up")
          ? {
              schemas: {
                "data-manager": {
                  type: "object",
                  properties: { TOKEN: { type: "string", "x-openmapx-secret": true } },
                },
              },
            }
          : {}),
        ...(references
          ? { imageReferences: { motis: references.sibling, "data-manager": references.target } }
          : {}),
        actualComposeConfig: true,
        defaultCliEntry: fileURLToPath(
          new URL("../../../../ops-agent/src/index.ts", import.meta.url),
        ),
      });
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((s) => s.manifest.id),
      });
      const old = {
        ...host.row,
        Id: "c".repeat(64),
        ConfigImage:
          services.readServiceReleaseImageSelection(host.infraDir, "data-manager").imageReference ??
          services.serviceContainerImageReference(
            host.loaded.find((s) => s.manifest.id === "data-manager")!.manifest.container,
          ),
        Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
      };
      if (test.task.name.includes("stopped coordinator before pull")) {
        old.State = "exited";
        await dm.pauseHttp();
      }
      host.setRows([host.row, old]);
      host.setImagePullProcess(async (reference) => {
        const candidates = readdirSync(host.candidates);
        expect(candidates).toHaveLength(1);
        const candidate = inspectPreparedConfigurationRecord(
            JSON.parse(readFileSync(join(host.candidates, candidates[0]!), "utf8")),
          ).record,
          fixed = candidate.privateCoordinatorLifecycle;
        if (fixed?.action !== "update") throw Error("Actual original sealed Update source missing");
        if (test.task.name.includes("stopped coordinator before pull")) {
          const helper = candidate.coordinatorPrerequisite!;
          const actual = JSON.parse(
            readFileSync(
              join(
                host.infraDir,
                "state/ops-agent/control/executions",
                `${helper.root.operationKey}.json`,
              ),
              "utf8",
            ),
          );
          console.info(
            "actual coordinator helper clamp",
            JSON.stringify({
              requestedMatchesOriginal:
                actual.requestedDeadlineAt === helper.root.requestedDeadlineAt,
              actualDeadlineBeforeRequested:
                actual.execution.deadlineAt < actual.requestedDeadlineAt,
              oldRevisionMatches:
                actual.operation.expectedConfigurationRevisionId === host.initial.revisionId,
            }),
          );
        }
        expect(reference).toBe(
          services.serviceContainerImageReference(
            host.loaded.find((s) => s.manifest.id === "data-manager")!.manifest.container,
          ),
        );
        pulledImageId = `sha256:${"e".repeat(64)}`;
        host.setImageIdentity(reference, pulledImageId);
        afterImageStaging?.();
      });
      let recreatedContainers = 0;
      host.setCreatingProcess(async (args) => {
        await beforeLifecycleProcess?.(args);
        if (!args.includes("--force-recreate")) {
          if (args.includes("--no-recreate") && args.at(-1) === "data-manager") {
            old.State = "running";
            await dm.resumeHttp();
          }
          return;
        }
        const revision = services.currentConfigurationGeneration(host.infraDir);
        if (!revision) throw Error("Actual committed coordinator generation unavailable");
        const prefix = services.stackComposeArgs(host.stack),
          io = { signal: new AbortController().signal, timeout: 15000, maxBuffer: 1024 * 1024 },
          config = JSON.parse(
            (await host.execFile("docker", [...prefix, "config", "--format", "json"], io)).stdout,
          ),
          hash = (
            await host.execFile("docker", [...prefix, "config", "--hash", "data-manager"], io)
          ).stdout
            .trim()
            .split(/\s+/)
            .at(-1)!,
          row = {
            ...old,
            Image: pulledImageId ?? old.Image,
            Id: (BigInt(`0x${"d".repeat(64)}`) + BigInt(recreatedContainers++))
              .toString(16)
              .padStart(64, "0"),
            Labels: {
              ...old.Labels,
              "com.docker.compose.project.working_dir": dirname(
                services.configurationGenerationComposeFile(host.infraDir, revision),
              ),
              "com.docker.compose.project.config_files":
                services.configurationGenerationComposeFile(host.infraDir, revision),
              "com.docker.compose.config-hash": hash,
            },
          },
          service = config.services["data-manager"];
        host.setRows([host.row, row]);
        host.setRuntimeInspections({
          [row.Id]: {
            Id: row.Id,
            Image: row.Image,
            State: { Status: "running", Running: true, Health: { Status: "healthy" } },
            Config: {
              Image: row.ConfigImage,
              Labels: row.Labels,
              Env: Object.entries(service.environment ?? {}).map(([k, v]) => `${k}=${v}`),
            },
            Mounts: [
              ...(service.volumes ?? []).map(
                (v: { type: string; source: string; target: string; read_only?: boolean }) => ({
                  Type: v.type,
                  Source: v.source,
                  Destination: v.target,
                  RW: !v.read_only,
                }),
              ),
              ...(service.secrets ?? []).map((v: { source: string; target: string }) => ({
                Type: "bind",
                Source: config.secrets[v.source].file,
                Destination: `/run/secrets/${v.target}`,
                RW: false,
              })),
            ],
          },
        });
      });
      installation = openControlInstallation({
        infraDir: host.infraDir,
        role: "ops-agent",
        serviceIds: host.loaded.map((s) => s.manifest.id),
      });
      agent = buildOpsAgentServer({
        operationTimeoutMs: 180000,
        tokens: {
          api: host.token,
          "data-manager": Buffer.alloc(32, 23).toString("base64url"),
        },
        runtime: host.runtime,
        resourceClaimer: host.claimer,
        journal: await openOpsJobJournal(join(host.infraDir, "state/ops-agent/jobs-v1.json")),
        controlInstallation: installation,
      });
      posts.clear();
      arrivals.clear();
      agent.addHook("preHandler", async (request) => {
        const kind = (request.body as { operation?: { kind?: string } } | undefined)?.operation
          ?.kind;
        if (request.method === "POST" && kind) arrivals.set(kind, (arrivals.get(kind) ?? 0) + 1);
      });
      agent.addHook("onSend", async (request, _reply, payload) => {
        const kind = (request.body as { operation?: { kind?: string } } | undefined)?.operation
          ?.kind;
        if (request.method === "POST" && request.url === "/v1/operations" && kind)
          posts.set(kind, (posts.get(kind) ?? 0) + 1);
        if (
          request.method === "GET" &&
          (pullTerminalReplyGate || afterPullTerminal) &&
          typeof payload === "string"
        ) {
          const observed = JSON.parse(payload) as { result?: { kind?: string; state?: string } };
          if (observed.result?.kind === "service.pull" && observed.result.state === "succeeded") {
            const observed = afterPullTerminal;
            afterPullTerminal = undefined;
            observed?.();
            const gate = pullTerminalReplyGate;
            if (gate) {
              gate.reached();
              await gate.release;
            }
          }
        }
        if (kind === "configurationMaintenance.apply" && decisionReplyGate) {
          const gate = decisionReplyGate;
          gate.reached();
          await gate.release;
        }
        return payload;
      });
      const tokenFile = join(host.root, "api-token");
      writeFileSync(tokenFile, host.token, { mode: 0o600 });
      const realDocker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim(),
        bin = join(host.root, "fixture-bin");
      nativeTrace = join(host.root, "native-docker-argv.jsonl");
      mkdirSync(bin);
      // Real default CLI/process/containment; only Docker's external effects
      // are synthetic. Native Compose config/hash still executes unchanged.
      writeFileSync(
        join(bin, "docker"),
        `#!${process.execPath}\nconst fs=require("node:fs"),cp=require("node:child_process"),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(nativeTrace)},JSON.stringify(a)+"\\n");if(a[0]==="compose"&&a.includes("config")){const r=cp.spawnSync(${JSON.stringify(realDocker)},a,{encoding:"utf8"});process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");process.exit(r.status??1);}\n`,
        { mode: 0o700 },
      );
      for (const [key, value] of Object.entries({
        OPS_AGENT_URL: await agent.listen({ host: "127.0.0.1", port: 0 }),
        OPS_AGENT_TOKEN_FILE: tokenFile,
        OPENMAPX_ROOT_DIR: host.root,
        OPENMAPX_SECRETS_KEY: "71".repeat(32),
        OPENMAPX_LOCAL_ADMIN_TOKEN: "task012-coordinator-local-admin",
        OPENMAPX_DISABLE_LOCALHOST_AUTH: "0",
        DATA_MANAGER_URL: dm.baseUrl,
        DATA_MANAGER_TOKEN_FILE: dataManagerTokenFile(dm.token),
        DOMAIN: "example.test",
        POSTGRES_PASSWORD: "p".repeat(24),
        PATH: `${bin}:${process.env.PATH}`,
      }))
        vi.stubEnv(key, value);
      const { initServiceRegistry } = await import("../service-registry");
      await initServiceRegistry({ strict: true });
      const { jobRunner } = await import("../job-runner"),
        { serviceApply } = await import("../admin-ops"),
        { handleServiceBulkJob } = await import("../admin-job-handlers");
      // Exact current server registration wrapper, with the actual production
      // serviceApply and JobRunner; no agent handler/authority is substituted.
      jobRunner.register("service.apply", async (ctx) => {
        const result = await serviceApply(ctx.payload.service as string, ctx);
        return { service: ctx.payload.service, action: "apply", ...result };
      });
      jobRunner.register("service.bulk", async (ctx) => {
        try {
          return await handleServiceBulkJob(ctx);
        } catch (error) {
          if (test.task.name.includes("actual bulk Update"))
            console.info(
              "actual bulk boundary error",
              JSON.stringify({
                name: error instanceof Error ? error.name : "unknown",
                message: error instanceof Error ? error.message : "unknown",
                stack: error instanceof Error ? error.stack?.split("\n").slice(1, 5) : [],
              }),
            );
          throw error;
        }
      });
      api = Fastify({ logger: false });
      api.setErrorHandler((await import("../../server-wiring")).uniformErrorHandler);
      const { initIntegrations } = await import("../../integration-host");
      await initIntegrations(api, []);
      const { requireAdmin } = await import("../../utils/require-admin");
      api.addHook("preHandler", async (request: FastifyRequest) => {
        request.adminSession = await requireAdmin(request);
      });
      const { adminServicesRoute } = await import("../../routes/admin-services");
      await api.register(adminServicesRoute, { prefix: "/api" });
      await api.ready();
    }, 60000);
    afterEach(async () => {
      // The process-wide host outlives Fastify; retire providers before
      // deleting this fixture's manifests and replacing its database.
      const { shutdownIntegrations } = await import("../../integration-host");
      await shutdownIntegrations();
      await api?.close();
      // Observe the actual runner's scheduled pump/active work before closing
      // its owned SQL transport. This changes no scheduler or handler result.
      const { jobRunner } = await import("../job-runner"),
        runner = jobRunner as unknown as { active: Map<string, unknown>; pumping: boolean };
      const until = Date.now() + 5000;
      let idleTurns = 0;
      while (idleTurns < 2) {
        await delay(0);
        idleTurns = runner.active.size === 0 && !runner.pumping ? idleTurns + 1 : 0;
        if (Date.now() > until) throw Error("Actual fixture runner did not quiesce");
      }
      await agent?.close();
      await dm?.close();
      if (installation) closeControlInstallation(installation);
      await fixture?.stop();
      if (host) rmSync(host.cleanupRoot, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });
    async function finished(id: string) {
      const until = performance.now() + 150000;
      let diagnostic = false;
      for (;;) {
        const [row] = await fixture.db
          .select()
          .from(schema.adminJob)
          .where(eq(schema.adminJob.id, id));
        if (row && ["success", "failed", "canceled"].includes(row.status)) return row;
        if (!diagnostic && performance.now() >= until - 105000) {
          diagnostic = true;
          console.info(
            "actual host-root later source",
            JSON.stringify({
              status: row?.status,
              error: row?.error,
              posts: [...posts],
              dm: await dm.diagnostics(),
              projection: Object.values(
                (
                  row?.protocol as {
                    operations?: {
                      operations?: Record<
                        string,
                        { kind?: string; phase?: string; errorClass?: string }
                      >;
                    };
                  }
                )?.operations?.operations ?? {},
              ).map((value) => ({
                kind: value.kind,
                phase: value.phase,
                errorClass: value.errorClass,
              })),
              candidate: (row?.protocol as { candidate?: { phase?: string } })?.candidate?.phase,
            }),
          );
        }
        if (performance.now() >= until) throw Error("Actual coordinator API job did not settle");
        await delay(25);
      }
    }
    async function canceledSuccessfulCoordinatorStage(serviceIds = ["data-manager"]) {
      let reachedTerminalReply = false;
      const release = Promise.withResolvers<void>();
      pullTerminalReplyGate = {
        reached: () => {
          reachedTerminalReply = true;
        },
        release: release.promise,
      };
      try {
        const first = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: {
              "idempotency-key": randomUUID(),
              "x-openmapx-local-admin": "task012-coordinator-local-admin",
            },
            payload: { action: "update", serviceIds },
          }),
          id = first.json().jobId;
        expect(first.statusCode, first.body).toBe(200);
        const terminalUntil = performance.now() + 45000;
        while (!reachedTerminalReply) {
          const [row] = await fixture.db
            .select()
            .from(schema.adminJob)
            .where(eq(schema.adminJob.id, id));
          if (
            (row && ["success", "failed", "canceled"].includes(row.status)) ||
            performance.now() >= terminalUntil
          )
            throw Error(
              `Actual pull terminal reply unavailable: ${row?.status}; ${row?.error}; ${JSON.stringify([...arrivals])}`,
            );
          await delay(25);
        }
        const { jobRunner } = await import("../job-runner"),
          cancellation = jobRunner.cancel(id);
        const until = performance.now() + 10000;
        for (;;) {
          const [row] = await fixture.db
            .select()
            .from(schema.adminJob)
            .where(eq(schema.adminJob.id, id));
          if (row?.status === "cancel_pending" || row?.status === "canceled") break;
          if (performance.now() > until) throw Error("Actual cancellation marker unavailable");
          await delay(10);
        }
        pullTerminalReplyGate = undefined;
        release.resolve();
        await cancellation;
        // The actual API server schedules reconcile; this route fixture owns
        // that schedule explicitly and waits for the original real claim lease.
        const cleanupUntil = performance.now() + 90000;
        for (;;) {
          await jobRunner.reconcile({ limit: 1 });
          const [row] = await fixture.db
            .select()
            .from(schema.adminJob)
            .where(eq(schema.adminJob.id, id));
          if (row?.status === "canceled") break;
          if (performance.now() > cleanupUntil)
            throw Error("Canceled staged candidate did not reconcile");
          await delay(500);
        }
        expect((await finished(id)).status).toBe("canceled");
        expect(readdirSync(host.candidates)).toHaveLength(0);
        expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
        const [retained] = await fixture.db
          .select()
          .from(schema.adminJob)
          .where(eq(schema.adminJob.id, id));
        const pull = Object.values(
          (
            retained!.protocol as {
              operations: { operations: Record<string, { kind: string; operationKey: string }> };
            }
          ).operations.operations,
        ).find((value) => value.kind === "service.pull")!;
        return {
          id,
          pullPath: join(
            host.infraDir,
            "state/ops-agent/control/executions",
            `${pull.operationKey}.json`,
          ),
        };
      } finally {
        pullTerminalReplyGate = undefined;
        release.resolve();
      }
    }
    async function restartNativeStagedAgent() {
      await agent.close();
      const bridge = Fastify({ logger: false, bodyLimit: 64 * 1024 });
      bridge.post("/docker", async (request, reply) => {
        const args = (request.body as { args: unknown }).args;
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
          throw Error("Invalid named Docker fixture arguments");
        try {
          return await host.execFile("docker", args, {
            signal: new AbortController().signal,
            timeout: 180000,
            maxBuffer: 4 * 1024 * 1024,
          });
        } catch {
          return reply.code(502).send({ error: "Named Docker IO failed" });
        }
      });
      const dockerBridge = await bridge.listen({ host: "127.0.0.1", port: 0 });
      const argv = [
        "--import",
        createRequire(import.meta.url).resolve("tsx/esm"),
        fileURLToPath(
          new URL(
            "../../../../ops-agent/src/test-fixtures/staged-coordinator-request-process.mjs",
            import.meta.url,
          ),
        ),
      ];
      console.info(
        "actual native fresh-request agent argv",
        JSON.stringify([process.execPath, ...argv]),
      );
      const child = spawn(process.execPath, argv, {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        }),
        ready = Promise.withResolvers<{ url: string; ownedDM: boolean }>();
      let closed = false;
      let output = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const lines = output.split("\n");
        output = lines.pop()!;
        for (const line of lines) {
          const event = JSON.parse(line);
          if (event.event === "ready") ready.resolve(event);
          if (event.event === "operation") {
            posts.set(event.kind, (posts.get(event.kind) ?? 0) + 1);
            if (event.status >= 400)
              console.info(
                "actual native operation rejection",
                JSON.stringify({
                  kind: event.kind,
                  status: event.status,
                  errorClass: event.errorClass,
                }),
              );
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 1024 * 1024) child.kill("SIGKILL");
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) =>
          child.once("exit", (code, signal) => {
            ready.reject(
              Error(`Native fresh-request agent exited ${code}: ${stderr.slice(-2500)}`),
            );
            resolve({ code, signal });
          }),
      );
      child.stdin.end(
        JSON.stringify({
          root: host.root,
          infraDir: host.infraDir,
          stack: host.stack,
          token: host.token,
          serviceIds: host.loaded.map((service) => service.manifest.id),
          dockerBridge: `${dockerBridge}/docker`,
        }),
      );
      try {
        const observed = await ready.promise;
        expect(observed.ownedDM).toBe(true);
        vi.stubEnv("OPS_AGENT_URL", observed.url);
      } catch (error) {
        child.kill("SIGKILL");
        await exited;
        await bridge.close();
        throw error;
      }
      return async () => {
        if (closed) return;
        child.kill("SIGTERM");
        const result = await exited;
        await bridge.close();
        closed = true;
        expect(result).toEqual({ code: 0, signal: null });
      };
    }
    it("reconstructs staged ownership in a NEW native production agent before a fresh user Update", async () => {
      const { pullPath } = await canceledSuccessfulCoordinatorStage(),
        original = readFileSync(pullPath),
        stop = await restartNativeStagedAgent();
      try {
        const next = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: {
              "idempotency-key": randomUUID(),
              "x-openmapx-local-admin": "task012-coordinator-local-admin",
            },
            payload: { action: "update", serviceIds: ["data-manager"] },
          }),
          row = await finished(next.json().jobId);
        expect(row.status, row.error ?? "No public error").toBe("success");
        expect(posts.get("service.pull")).toBe(2);
        expect(posts.get("configurationMaintenance.prepare")).toBe(1);
        expect(dm.settlementResponseStatuses).toEqual([200]);
        expect(readFileSync(pullPath).equals(original)).toBe(true);
      } finally {
        await stop();
      }
    }, 240000);
    it("uses fresh authority after repeated native expiry staging without recursive provenance", async () => {
      const originals: Array<{ path: string; bytes: Buffer }> = [];
      try {
        for (let n = 0; n < 2; n++) {
          afterPullTerminal = () => {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(Date.now() + 6 * 60000);
          };
          const reply = await api.inject({
              method: "POST",
              url: "/api/admin/services/bulk-action",
              headers: {
                "idempotency-key": randomUUID(),
                "x-openmapx-local-admin": "task012-coordinator-local-admin",
              },
              payload: { action: "update", serviceIds: ["data-manager"] },
            }),
            row = await finished(reply.json().jobId),
            projection = (
              row.protocol as {
                operations: {
                  operations: Record<
                    string,
                    {
                      kind: string;
                      operationKey: string;
                      receiptDelivery?: { terminalReceipt: { state: string } };
                    }
                  >;
                };
              }
            ).operations,
            pull = Object.values(projection.operations).find((op) => op.kind === "service.pull")!;
          expect(row.status, row.error ?? "No public error").toBe("failed");
          console.info(
            "actual repeated expiry original",
            JSON.stringify({
              ordinal: n,
              error: row.error,
              operations: Object.values(projection.operations).map((op) => ({
                kind: op.kind,
                receipt: !!op.receiptDelivery,
              })),
            }),
          );
          expect(pull.receiptDelivery?.terminalReceipt.state).toBe("succeeded");
          expect(readdirSync(host.candidates)).toHaveLength(0);
          expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
          const path = join(
            host.infraDir,
            "state/ops-agent/control/executions",
            `${pull.operationKey}.json`,
          );
          originals.push({ path, bytes: readFileSync(path) });
          // Each request keeps its original clocks and signed bytes. Let the
          // real wall/SQL clock catch up before the NEXT fresh request.
          await delay(6 * 60000 + 1000);
          vi.useRealTimers();
        }
        vi.useRealTimers();
        const stop = await restartNativeStagedAgent();
        try {
          const reply = await api.inject({
              method: "POST",
              url: "/api/admin/services/bulk-action",
              headers: {
                "idempotency-key": randomUUID(),
                "x-openmapx-local-admin": "task012-coordinator-local-admin",
              },
              payload: { action: "update", serviceIds: ["data-manager"] },
            }),
            row = await finished(reply.json().jobId);
          console.info(
            "actual repeated expiry native result",
            JSON.stringify({
              state: row.status,
              error: row.error,
              configuration: (row.result as Record<string, unknown>)?.configuration,
              coordinatorLifecycle: (row.result as Record<string, unknown>)?.coordinatorLifecycle,
              settlementStatuses: dm.settlementResponseStatuses,
              posts: [...posts],
            }),
          );
          expect(row.status, row.error ?? "No public error").toBe("success");
          expect(posts.get("service.pull")).toBe(3);
          expect(dm.settlementResponseStatuses).toEqual([200]);
          for (const original of originals)
            expect(readFileSync(original.path).equals(original.bytes)).toBe(true);
        } finally {
          await stop();
        }
      } finally {
        vi.useRealTimers();
      }
    }, 1200000);
    it("carries an authenticated staged source through a fresh Apply's OWN generation after canceled staging", async () => {
      await canceledSuccessfulCoordinatorStage();
      const next = await api.inject({
        method: "POST",
        url: "/api/admin/services/data-manager/action",
        headers: {
          "idempotency-key": randomUUID(),
          "x-openmapx-local-admin": "task012-coordinator-local-admin",
        },
        payload: { action: "apply" },
      });
      const row = await finished(next.json().jobId);
      expect(row.status, row.error ?? "No public error").toBe("success");
      expect(posts.get("service.pull")).toBe(1);
      expect(posts.get("configurationMaintenance.prepare")).toBe(1);
      expect(dm.settlementResponseStatuses).toEqual([200]);
    }, 300000);
    it("carries staged ownership and desired E through the installed credential follow-up's OWN generation", async () => {
      const { pullPath } = await canceledSuccessfulCoordinatorStage(),
        original = readFileSync(pullPath);
      const changed = await api.inject({
        method: "PUT",
        url: "/api/admin/services/data-manager/credentials/TOKEN",
        headers: {
          "x-openmapx-local-admin": "task012-coordinator-local-admin",
          "idempotency-key": "task012-staged-credential",
        },
        payload: { value: "synthetic-private-credential" },
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(posts.get("service.pull")).toBe(1);
      expect(posts.get("configurationMaintenance.prepare")).toBe(1);
      expect(dm.settlementResponseStatuses).toEqual([200]);
      expect(readFileSync(pullPath).equals(original)).toBe(true);
      const jobs = await fixture.db.select().from(schema.adminJob),
        ownerJob = jobs.find((job) => maintenanceIdOf(job)),
        owner = JSON.parse(
          readFileSync(
            join(
              host.infraDir,
              "state/ops-agent/control/maintenance",
              `${maintenanceIdOf(ownerJob!)}.json`,
            ),
            "utf8",
          ),
        );
      // The credential change recreates data-manager with the image its
      // reference names now, the one the canceled update pulled, and its
      // generation records it.
      expect(owner.plan.coordinatorImage).toMatchObject({
        action: "apply",
        imageId: pulledImageId,
      });
      expect(
        services.readGenerationImageIds(host.infraDir, owner.plan.operation.revisionId)[
          "data-manager"
        ],
      ).toBe(pulledImageId);
      expect(
        (await host.owned.inspectOwnedServices(new AbortController().signal)).find(
          (s) => s.serviceId === "data-manager",
        )?.provenance.imageId,
      ).toBe(pulledImageId);
      expect(await fixture.db.select().from(schema.serviceSecret)).toHaveLength(1);
    }, 180000);
    it("refuses candidate DM staging before Docker while an actual ordinary full-target root remains held", async () => {
      const reached = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      beforeLifecycleProcess = async (args) => {
        if (args.includes("up") && args.at(-1) === "motis" && !args.includes("--force-recreate")) {
          reached.resolve();
          await release.promise;
        }
      };
      const started = await api.inject({
          method: "POST",
          url: "/api/admin/services/bulk-action",
          headers: {
            "idempotency-key": randomUUID(),
            "x-openmapx-local-admin": "task012-coordinator-local-admin",
          },
          payload: { action: "start", serviceIds: ["motis"] },
        }),
        startId = started.json().jobId;
      try {
        await reached.promise;
        const [live] = await fixture.db
            .select()
            .from(schema.adminJob)
            .where(eq(schema.adminJob.id, startId)),
          root = Object.values(
            (
              live!.protocol as {
                operations: {
                  operations: Record<string, { kind: string; operationKey: string }>;
                };
              }
            ).operations.operations,
          ).find((operation) => operation.kind === "service.start")!,
          owner = openLeaseStore({
            directory: leaseStoreDirectory(host.infraDir),
            purpose: "test",
          }).get(rootLeaseId(root));
        expect(owner?.targets).toContain("data-manager");
        const request = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: {
              "idempotency-key": randomUUID(),
              "x-openmapx-local-admin": "task012-coordinator-local-admin",
            },
            payload: { action: "update", serviceIds: ["data-manager"] },
          }),
          stopped = await finished(request.json().jobId);
        expect(stopped.status).toBe("failed");
        expect(host.calls.filter((args) => args[0] === "image" && args[1] === "pull")).toHaveLength(
          0,
        );
        expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
        expect(readdirSync(host.candidates)).toHaveLength(0);
      } finally {
        beforeLifecycleProcess = undefined;
        release.resolve();
        expect((await finished(startId)).status).toBe("success");
      }
      const repaired = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: {
          "idempotency-key": randomUUID(),
          "x-openmapx-local-admin": "task012-coordinator-local-admin",
        },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      expect((await finished(repaired.json().jobId)).status).toBe("success");
    }, 240000);
    it("observes its genuine pull admission without target metadata writes", async () => {
      const { pullPath } = await canceledSuccessfulCoordinatorStage(),
        bytes = readFileSync(pullPath),
        actual = JSON.parse(bytes.toString("utf8")),
        authority = restoreAdmittedControlExecution(installation, actual.execution),
        snapshot = () =>
          Object.fromEntries(
            [
              [
                "leases",
                JSON.stringify(
                  openLeaseStore({
                    directory: leaseStoreDirectory(host.infraDir),
                    purpose: "test",
                  }).list(),
                ),
              ],
            ].concat(
              ["state/ops-agent/control/observations"].flatMap((base) => {
                const directory = join(host.infraDir, base);
                return readdirSync(directory, { recursive: true })
                  .map(String)
                  .sort()
                  .map((name) => {
                    const fd = filesystem.openSync(join(directory, name), "r");
                    try {
                      const stat = filesystem.fstatSync(fd);
                      return [
                        `${base}/${name}`,
                        `${stat.dev}:${stat.ino}:${stat.mode}:${stat.isFile() ? createHash("sha256").update(readFileSync(fd)).digest("hex") : "directory"}`,
                      ];
                    } finally {
                      filesystem.closeSync(fd);
                    }
                  });
              }),
            ),
          );
      const before = snapshot(),
        writes = vi.spyOn(filesystem, "mkdirSync");
      syncBuiltinESMExports();
      try {
        assertCoordinatorPullLeaseCompatibility(authority);
        expect(writes).not.toHaveBeenCalled();
      } finally {
        writes.mockRestore();
        syncBuiltinESMExports();
      }
      expect(snapshot()).toEqual(before);
    }, 180000);
    it("refuses actual candidate pull before Docker against a separately admitted physical host-command root", async () => {
      // Component competitor uses the real normal host issuer and physical
      // target producer. The candidate/pull side is the actual public API,
      // production registry/server/journal and owned PostgreSQL throughout.
      const hostInstallation = openControlInstallation({
          infraDir: host.infraDir,
          role: "host-cli",
          serviceIds: host.loaded.map((service) => service.manifest.id),
        }),
        admittedAt = Date.now(),
        deadlineAt = admittedAt + 15000,
        operation = {
          kind: "service.start" as const,
          serviceId: "motis",
          expectedConfigurationRevisionId: host.initial.revisionId,
        },
        hash = opsOperationFingerprint(operation),
        execution = {
          executor: "host-cli" as const,
          principal: "host-cli" as const,
          executionId: randomUUID(),
          operationKey: createControlRootOperationKey({
            notAfter: deadlineAt,
            nonce: randomBytes(16),
          }),
          operationFingerprint: hash,
          deadlineAt,
          fingerprint: executionFingerprint({
            kind: operation.kind,
            operationFingerprint: hash,
            deadlineAt,
          }),
        },
        authority = retainAdmittedControlExecution(hostInstallation, {
          execution,
          operation,
          kind: operation.kind,
          admittedAt,
          requestedDeadlineAt: deadlineAt,
          serviceIds: host.loaded.map((service) => service.manifest.id).sort(),
        }),
        lease = await acquireArtifactTargetLease({
          owner: authority,
          serviceIds: host.loaded.map((service) => service.manifest.id).sort(),
        });
      expect(lease.serviceIds).toContain("data-manager");
      let pullObserver: ReturnType<typeof restoreAdmittedControlExecution> | undefined;
      const leases = () =>
        JSON.stringify(
          openLeaseStore({ directory: leaseStoreDirectory(host.infraDir), purpose: "test" }).list(),
        );
      const snapshot = () =>
        Object.fromEntries(
          [["leases", leases()]].concat(
            ["state/ops-agent/control/observations"].flatMap((base) => {
              const directory = join(host.infraDir, base);
              return readdirSync(directory, { recursive: true })
                .map(String)
                .sort()
                .map((name) => {
                  const fd = filesystem.openSync(join(directory, name), "r");
                  try {
                    const stat = filesystem.fstatSync(fd);
                    return [
                      `${base}/${name}`,
                      `${stat.dev}:${stat.ino}:${stat.mode}:${stat.isFile() ? createHash("sha256").update(readFileSync(fd)).digest("hex") : "directory"}`,
                    ];
                  } finally {
                    filesystem.closeSync(fd);
                  }
                });
            }),
          ),
        );
      // Make a forbidden Docker dispatch conclusively observable without
      // progressing to the separately held maintenance target. This controls
      // only the external process edge; the actual admission remains intact.
      host.setImagePullProcess(async (_reference, signal) => {
        await runContainedProcess(process.execPath, ["-e", "process.exit(17)"], {
          signal,
          timeout: 15000,
          maxBuffer: 1024,
        });
      });
      try {
        const next = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: {
              "idempotency-key": randomUUID(),
              "x-openmapx-local-admin": "task012-coordinator-local-admin",
            },
            payload: { action: "update", serviceIds: ["data-manager"] },
          }),
          row = await finished(next.json().jobId);
        console.info(
          "actual held-host-root/pull",
          JSON.stringify({
            state: row.status,
            error: row.error,
            posts: [...posts],
            imagePulls: host.calls.filter((args) => args[0] === "image" && args[1] === "pull")
              .length,
          }),
        );
        expect(row.status).toBe("failed");
        expect(posts.get("service.pull")).toBe(1);
        expect(host.calls.filter((args) => args[0] === "image" && args[1] === "pull")).toHaveLength(
          0,
        );
        expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
        expect(readdirSync(host.candidates)).toHaveLength(0);
        const directory = join(host.infraDir, "state/ops-agent/control/executions"),
          actualPulls = readdirSync(directory)
            .filter((name) => name.endsWith(".json"))
            .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")))
            .filter((raw) => raw?.operation?.kind === "service.pull");
        expect(actualPulls).toHaveLength(1);
        const observer = restoreAdmittedControlExecution(installation, actualPulls[0].execution);
        pullObserver = observer;
        const before = snapshot(),
          started = performance.now();
        expect(() => assertCoordinatorPullLeaseCompatibility(observer)).toThrow();
        expect(performance.now() - started).toBeLessThan(5000);
        expect(snapshot()).toEqual(before);
        await delay(Math.max(0, deadlineAt - Date.now() + 25));
        expect(Date.now()).toBeGreaterThan(deadlineAt);
        const expired = snapshot();
        expect(() => assertCoordinatorPullLeaseCompatibility(observer)).toThrow();
        expect(snapshot()).toEqual(expired);
      } finally {
        retainControlEffectReceipt(authority, {
          outcome: "failed_without_effect",
          publication: "not_started",
          receipt: { kind: "not-started" },
        });
        await settleArtifactTargetLeaseChild(
          lease,
          verifyControlEffectSettlement(hostInstallation, execution),
        );
        await releaseArtifactTargetLease(lease);
        closeControlInstallation(hostInstallation);
      }
      if (!pullObserver) throw Error("Actual original normal pull source required");
      const releasedObserver = pullObserver;
      const released = snapshot();
      assertCoordinatorPullLeaseCompatibility(pullObserver);
      expect(snapshot()).toEqual(released);
      // A second independent component root holds only a certified unrelated
      // target. Its body/clock/certificate are issued by the real normal host
      // producer; this is kernel observation, not a native CLI-effect claim.
      const unrelatedInstallation = openControlInstallation({
          infraDir: host.infraDir,
          role: "host-cli",
          serviceIds: host.loaded.map((service) => service.manifest.id),
        }),
        unrelatedAt = Date.now(),
        unrelatedDeadline = unrelatedAt + 120000,
        unrelatedOperation = {
          kind: "service.start" as const,
          serviceId: "motis",
          expectedConfigurationRevisionId: host.initial.revisionId,
        },
        unrelatedHash = opsOperationFingerprint(unrelatedOperation),
        unrelatedExecution = {
          executor: "host-cli" as const,
          principal: "host-cli" as const,
          executionId: randomUUID(),
          operationKey: createControlRootOperationKey({
            notAfter: unrelatedDeadline,
            nonce: randomBytes(16),
          }),
          operationFingerprint: unrelatedHash,
          deadlineAt: unrelatedDeadline,
          fingerprint: executionFingerprint({
            kind: unrelatedOperation.kind,
            operationFingerprint: unrelatedHash,
            deadlineAt: unrelatedDeadline,
          }),
        },
        unrelatedAuthority = retainAdmittedControlExecution(unrelatedInstallation, {
          execution: unrelatedExecution,
          operation: unrelatedOperation,
          kind: unrelatedOperation.kind,
          admittedAt: unrelatedAt,
          requestedDeadlineAt: unrelatedDeadline,
          serviceIds: ["motis"],
        }),
        unrelatedLease = await acquireArtifactTargetLease({
          owner: unrelatedAuthority,
          serviceIds: ["motis"],
        });
      try {
        const before = snapshot();
        assertCoordinatorPullLeaseCompatibility(releasedObserver);
        expect(snapshot()).toEqual(before);
      } finally {
        retainControlEffectReceipt(unrelatedAuthority, {
          outcome: "failed_without_effect",
          publication: "not_started",
          receipt: { kind: "not-started" },
        });
        await settleArtifactTargetLeaseChild(
          unrelatedLease,
          verifyControlEffectSettlement(unrelatedInstallation, unrelatedExecution),
        );
        await releaseArtifactTargetLease(unrelatedLease);
        closeControlInstallation(unrelatedInstallation);
      }
      console.info(
        "actual target-index observation",
        JSON.stringify({
          genuineNormalBaseline: true,
          readonlyHeldBusy: true,
          actualExpiredStillBusy: true,
          actualReleasedAccepted: true,
          partialSlotRefused: true,
          unrelatedSignedTargetAccepted: true,
        }),
      );
      host.setImagePullProcess(async (reference) => {
        pulledImageId = `sha256:${"e".repeat(64)}`;
        host.setImageIdentity(reference, pulledImageId);
      });
      const next = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: {
          "idempotency-key": randomUUID(),
          "x-openmapx-local-admin": "task012-coordinator-local-admin",
        },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      expect((await finished(next.json().jobId)).status).toBe("success");
    }, 240000);
    it.each(["capability", "admission"])(
      "advertises staged coordinator pull while rejecting legacy direct pull (%s)",
      async (boundary) => {
        const { createApiOpsClient } = await import("../ops-client"),
          client = createApiOpsClient();
        if (boundary === "capability") {
          const status = await client.execute({ kind: "services.inspect" });
          if (status.execution !== "sync") throw Error("Actual service capabilities required");
          expect(
            status.value.services.find((service) => service.serviceId === "data-manager")?.actions
              .pull,
          ).toMatchObject({
            available: true,
            execution: "workflow",
            reason: null,
            workflow: "image-stage",
          });
          return;
        }
        host.setImagePullProcess(async (_reference, signal) => {
          await runContainedProcess(process.execPath, ["-e", "process.exit(17)"], {
            signal,
            timeout: 15000,
            maxBuffer: 1024,
          });
        });
        const deadlineAt = Date.now() + 180000,
          operationKey = createControlRootOperationKey({
            notAfter: deadlineAt,
            nonce: randomBytes(16),
          });
        let failure: unknown,
          admitted = false;
        try {
          const result = await client.execute(
            {
              kind: "service.pull",
              serviceId: "data-manager",
              expectedConfigurationRevisionId: host.initial.revisionId,
            },
            { operationKey, execution: { requestedDeadlineAt: deadlineAt } },
          );
          if (result.execution === "async") {
            admitted = true;
            const until = performance.now() + 30000;
            while (
              !["failed", "succeeded", "timed_out"].includes(
                (await client.status("service.pull", result.operationId)).state,
              )
            ) {
              if (performance.now() > until) throw Error("Actual bare pull did not settle");
              await delay(25);
            }
          }
        } catch (error) {
          failure = error;
        }
        console.info(
          "actual bare DM pull",
          JSON.stringify({
            admitted,
            imagePulls: host.calls.filter((args) => args[0] === "image" && args[1] === "pull")
              .length,
          }),
        );
        expect(failure).toMatchObject({ errorClass: "configuration_prerequisite" });
        expect(admitted).toBe(false);
        expect(host.calls.filter((args) => args[0] === "image" && args[1] === "pull")).toHaveLength(
          0,
        );
        expect(
          existsSync(
            join(host.infraDir, "state/ops-agent/control/executions", `${operationKey}.json`),
          ),
        ).toBe(false);
      },
      90000,
    );
    it("ends a coordinator update as a conflict without effect when an ordinary update commits during its image pull", async () => {
      const reached = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>(),
        terminalReached = Promise.withResolvers<void>(),
        terminalRelease = Promise.withResolvers<void>();
      pullTerminalReplyGate = {
        reached: () => terminalReached.resolve(),
        release: terminalRelease.promise,
      };
      host.setImagePullProcess(async (reference) => {
        pulledImageId = `sha256:${"e".repeat(64)}`;
        host.setImageIdentity(reference, pulledImageId);
        reached.resolve();
        await release.promise;
      });
      const { createApiOpsClient } = await import("../ops-client"),
        client = createApiOpsClient();
      let id: string | undefined,
        completed = false;
      try {
        const response = await api.inject({
          method: "POST",
          url: "/api/admin/services/bulk-action",
          headers: {
            "idempotency-key": randomUUID(),
            "x-openmapx-local-admin": "task012-coordinator-local-admin",
          },
          payload: { action: "update", serviceIds: ["data-manager"] },
        });
        const jobId: unknown = response.json().jobId;
        if (typeof jobId !== "string") throw Error("Actual coordinator job required");
        id = jobId;
        await reached.promise;
        const deadlineAt = Date.now() + 120000,
          operationKey = createControlRootOperationKey({
            notAfter: deadlineAt,
            nonce: randomBytes(16),
          }),
          admitted = await client.execute(
            {
              kind: "service.update",
              serviceId: "motis",
              expectedConfigurationRevisionId: host.initial.revisionId,
            },
            { operationKey, execution: { requestedDeadlineAt: deadlineAt } },
          );
        if (admitted.execution !== "async")
          throw Error("Actual normal managed CLI admission required");
        // The pull holds no lease, so the ordinary update takes every target.
        expect(heldTargets(host.infraDir)).toEqual(
          expect.arrayContaining(["data-manager", "motis"]),
        );
        release.resolve();
        await terminalReached.promise;
        let state = await client.status("service.update", admitted.operationId);
        const until = performance.now() + 45000;
        while (!["failed", "succeeded", "timed_out"].includes(state.state)) {
          if (performance.now() > until) throw Error("Actual racing CLI did not settle");
          await delay(25);
          state = await client.status("service.update", admitted.operationId);
        }
        expect(state.state).toBe("succeeded");
        const racingRevision = (state.result as { revisionId: string }).revisionId;
        expect(racingRevision).not.toBe(host.initial.revisionId);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(racingRevision);
        // The coordinator update now prepares against a configuration that
        // changed under it: the agent refuses the preparation as a conflict
        // before any lease or fence, and the job ends without effect.
        terminalRelease.resolve();
        const row = await finished(jobId);
        completed = true;
        expect(row.status, row.error ?? "No public error").toBe("failed");
        const prepare = Object.values(
          (
            row.protocol as {
              operations: {
                operations: Record<string, { kind: string; phase: string; errorClass?: string }>;
              };
            }
          ).operations.operations,
        ).find((op) => op.kind === "configurationMaintenance.prepare");
        expect(prepare).toMatchObject({ phase: "terminal", errorClass: "conflict" });
        expect(posts.get("service.pull")).toBe(1);
        expect(posts.get("configurationMaintenance.prepare")).toBe(1);
        expect(posts.get("configurationMaintenance.apply")).toBeUndefined();
        expect(dm.settlementResponseStatuses).toEqual([]);
        expect((await dm.diagnostics()).maintenanceReplies).toEqual([]);
        expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(0);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(racingRevision);
        expect(heldTargets(host.infraDir)).toEqual([]);
      } finally {
        release.resolve();
        terminalRelease.resolve();
        pullTerminalReplyGate = undefined;
        if (id && !completed) await finished(id);
      }
    }, 240000);
    it.each([false, true])(
      "runs a bulk update in its requested order after a canceled pulled update with coordinatorFirst=%s",
      async (coordinatorFirst) => {
        await canceledSuccessfulCoordinatorStage();
        const serviceIds = coordinatorFirst ? ["data-manager", "motis"] : ["motis", "data-manager"],
          response = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: {
              "idempotency-key": randomUUID(),
              "x-openmapx-local-admin": "task012-coordinator-local-admin",
            },
            payload: { action: "update", serviceIds },
          }),
          originalId = response.json().jobId,
          row = await finished(originalId);
        console.info(
          "actual pending staged order",
          JSON.stringify({
            serviceIds,
            state: row.status,
            error: row.error,
            posts: [...posts],
            completed: (row.result as { completedServiceIds?: string[] })?.completedServiceIds,
          }),
        );
        // The earlier pull blocks neither order: motis updates while the old
        // coordinator still runs its recorded image, and the coordinator
        // update pulls and commits its own.
        expect(row.status, row.error ?? "No public error").toBe("success");
        expect((row.result as { completedServiceIds: string[] }).completedServiceIds).toEqual(
          serviceIds,
        );
        expect(posts.get("service.pull")).toBe(2);
        expect(posts.get("service.update")).toBe(1);
        expect(services.readAppliedServiceIds(host.infraDir, host.loaded)).toEqual(
          new Set(["data-manager", "motis"]),
        );
      },
      420000,
    );
    it("applies an ordinary unrelated configuration change after an update was canceled once its pull finished", async () => {
      await fixture.db
        .insert(schema.serviceConfig)
        .values({ id: crypto.randomUUID(), serviceId: "motis", config: { MODE: "old" } });
      await canceledSuccessfulCoordinatorStage();
      const before = services.currentConfigurationGeneration(host.infraDir);
      // The pulled image moved the tag; the running coordinator still runs the
      // image its generation recorded, so it stays the agent's own.
      expect(
        (await host.owned.inspectOwnedServices(new AbortController().signal)).find(
          (s) => s.serviceId === "data-manager",
        )?.provenance.imageId,
      ).toBe(`sha256:${"b".repeat(64)}`);
      const saved = await api.inject({
        method: "POST",
        url: "/api/admin/services/motis/config",
        headers: {
          "x-openmapx-local-admin": "task012-coordinator-local-admin",
          "idempotency-key": "task012-unrelated-config-after-pull",
        },
        payload: { config: { MODE: "new" } },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect((await fixture.db.select().from(schema.serviceConfig))[0]?.config).toEqual({
        MODE: "new",
      });
      expect(services.currentConfigurationGeneration(host.infraDir)).not.toBe(before);
      // The new generation records the image its coordinator reference names now.
      expect(
        services.readGenerationImageIds(
          host.infraDir,
          services.currentConfigurationGeneration(host.infraDir)!,
        )["data-manager"],
      ).toBe(pulledImageId);
      // A later update recreates the coordinator with the image it pulls.
      const next = await api.inject({
          method: "POST",
          url: "/api/admin/services/bulk-action",
          headers: {
            "idempotency-key": randomUUID(),
            "x-openmapx-local-admin": "task012-coordinator-local-admin",
          },
          payload: { action: "update", serviceIds: ["data-manager"] },
        }),
        row = await finished(next.json().jobId);
      expect(row.status, row.error ?? "No public error").toBe("success");
      expect(posts.get("service.pull")).toBe(2);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
    }, 180000);
    it.each(["image-id", "reference"] as const)(
      "does not count a coordinator as its own after its %s drifted from what its generation names",
      async (kind) => {
        await canceledSuccessfulCoordinatorStage();
        const rows = (
          await host.execFile("docker", ["container", "inspect", "--format", "owned-snapshot"], {
            signal: new AbortController().signal,
            timeout: 15000,
            maxBuffer: 1024 * 1024,
          })
        ).stdout
          .trim()
          .split("\n")
          .map((row) => JSON.parse(row));
        const dm = rows.find((row) => row.Labels["com.docker.compose.service"] === "data-manager");
        // Neither the recorded image nor the pulled one the reference names now.
        if (kind === "image-id") dm.Image = `sha256:${"f".repeat(64)}`;
        if (kind === "reference") dm.ConfigImage = "example/unrelated:1";
        host.setRows(rows);
        let observed: { serviceId: string }[] | undefined;
        try {
          observed = await host.owned.inspectOwnedServices(new AbortController().signal);
        } catch (error) {
          expect((error as Error).message).toBe("Owned service inventory unavailable");
        }
        expect(observed?.some((service) => service.serviceId === "data-manager") ?? false).toBe(
          false,
        );
      },
      120000,
    );
    it("uses staged OLD stopped provenance for one NEW non-recreate helper BEFORE its own pull", async () => {
      await canceledSuccessfulCoordinatorStage();
      host.setServiceState("data-manager", "exited");
      await dm.pauseHttp();
      expect(
        (await host.owned.inspectOwnedServices(new AbortController().signal)).find(
          (service) => service.serviceId === "data-manager",
        )?.state,
      ).toBe("stopped");
      let beforePull: { starts: number; helperUps: number } | undefined;
      afterImageStaging = () => {
        beforePull = {
          starts: posts.get("service.start") ?? 0,
          helperUps: host.calls.filter(
            (args) => args.includes("--no-recreate") && args.at(-1) === "data-manager",
          ).length,
        };
      };
      const next = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: {
          "idempotency-key": randomUUID(),
          "x-openmapx-local-admin": "task012-coordinator-local-admin",
        },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      expect((await finished(next.json().jobId)).status).toBe("success");
      expect(beforePull).toEqual({ starts: 1, helperUps: 1 });
      expect(posts.get("service.start")).toBe(1);
      expect(posts.get("service.pull")).toBe(2);
      expect(dm.settlementResponseStatuses).toEqual([200]);
    }, 180000);
    it("guards the actual existing coordinator Apply entry even with empty links", async () => {
      const response = await api.inject({
        method: "POST",
        url: "/api/admin/services/data-manager/action",
        headers: {
          "idempotency-key": randomUUID(),
          "x-openmapx-local-admin": "task012-coordinator-local-admin",
        },
        payload: { action: "apply" },
      });
      expect(response.statusCode).toBe(200);
      const row = await finished(response.json().jobId);
      expect(
        row.status,
        `${row.error ?? "no job error"}; posted kinds ${JSON.stringify([...posts])}`,
      ).toBe("success");
      expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(1);
      expect(dm.preparePosts).toBe(1);
      expect(posts.get("configurationMaintenance.apply")).toBe(1);
      expect(posts.get("configurationMaintenance.settle")).toBe(1);
      expect(host.calls.filter((a) => a.includes("--force-recreate"))).toHaveLength(1);
      expect(await fixture.db.select().from(schema.serviceConfig)).toEqual([]);
      expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
      expect(posts.get("service.start") ?? 0).toBe(0);
    }, 180000);
    it("guards current local-admin coordinator Update without an ordinary seed or fixed CLI", async () => {
      const response = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: {
          "idempotency-key": randomUUID(),
          "x-openmapx-local-admin": "task012-coordinator-local-admin",
        },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      expect(response.statusCode).toBe(200);
      const row = await finished(response.json().jobId);
      expect(
        row.status,
        `${row.error ?? "no job error"}; posted kinds ${JSON.stringify([...posts])}`,
      ).toBe("success");
      expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(1);
      expect(dm.preparePosts).toBe(1);
      expect(posts.get("service.update") ?? 0).toBe(0);
      expect(posts.get("service.pull")).toBe(1);
      // The generation is a step of the maintenance's apply, run inside the agent.
      expect(posts.get("stack.render") ?? 0).toBe(0);
      expect(posts.get("configurationMaintenance.apply")).toBe(1);
      expect(posts.get("service.start") ?? 0).toBe(0);
      const owner = JSON.parse(
        readFileSync(
          join(
            host.infraDir,
            "state/ops-agent/control",
            "maintenance",
            `${maintenanceIdOf(row)}.json`,
          ),
          "utf8",
        ),
      );
      expect(owner.record.state).toBe("settled");
      expect(owner.record.fenceOutcome).toBe("applied");
      expect(dm.settlePosts).toBe(1);
      expect(await dm.fenceStates()).toEqual(["settled"]);
      expect(host.calls.filter((a) => a.includes("--force-recreate"))).toHaveLength(1);
      const actual = (await host.owned.inspectOwnedServices(new AbortController().signal)).find(
        (s) => s.serviceId === "data-manager",
      );
      expect(actual?.provenance.imageId).toBe(pulledImageId);
      // The maintenance found the old coordinator, committed the pulled image
      // in the new generation, and recreated it with that image.
      expect(
        owner.originalContainers.find((s: { serviceId: string }) => s.serviceId === "data-manager")
          .provenance.imageId,
      ).toBe(`sha256:${"b".repeat(64)}`);
      expect(owner.plan.coordinatorImage.imageId).toBe(pulledImageId);
      expect(
        services.readGenerationImageIds(host.infraDir, owner.plan.operation.revisionId)[
          "data-manager"
        ],
      ).toBe(pulledImageId);
      const native = readFileSync(nativeTrace, "utf8")
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s) as string[]);
      expect(native.filter((a) => a.includes("--force-recreate"))).toHaveLength(0);
    }, 180000);
    it.each([
      { action: "apply", point: "decision" },
      { action: "update", point: "decision" },
      { action: "update", point: "pull" },
      { action: "apply", point: "candidate unlink" },
      { action: "update", point: "candidate unlink" },
      { action: "update", point: "mixed pull" },
      { action: "update", point: "canceled pull" },
    ] as const)(
      "preserves native coordinator $action after original $point without another admission or save",
      async ({ action, point }) => {
        const pullBoundary =
          point === "pull" || point === "mixed pull" || point === "canceled pull";
        let reached!: () => void, release!: () => void;
        const atDecision = new Promise<void>((r) => {
            reached = r;
          }),
          reply = new Promise<void>((r) => {
            release = r;
          });
        if (!pullBoundary && point !== "candidate unlink")
          decisionReplyGate = { reached, release: reply };
        else if (pullBoundary) pullTerminalReplyGate = { reached, release: reply };
        const database = new URL(process.env.OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL!);
        database.searchParams.set("search_path", fixture.schema);
        const loader = createRequire(new URL("../../../package.json", import.meta.url)).resolve(
            "tsx/esm",
          ),
          script = fileURLToPath(new URL("./fixtures/native-coordinator-api.ts", import.meta.url)),
          children: ReturnType<typeof spawn>[] = [];
        const start = (input: Record<string, unknown>) => {
          const args = ["--import", loader, script],
            child = spawn(process.execPath, args, {
              cwd: host.root,
              env: { ...process.env, DATABASE_URL: database.toString(), NODE_ENV: "test" },
              stdio: ["pipe", "pipe", "pipe"],
            });
          children.push(child);
          let queued!: (id: string) => void,
            output = "";
          const jobId = new Promise<string>((r) => {
            queued = r;
          });
          child.stdout!.on("data", (chunk) => {
            output += chunk.toString();
            const lines = output.split("\n");
            output = lines.pop()!;
            for (const line of lines) {
              const event = JSON.parse(line);
              if (event.event === "queued") queued(event.jobId);
            }
          });
          child.stderr!.on("data", () => {});
          const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code, signal) => {
                console.info(
                  JSON.stringify({
                    proof: "native-coordinator-api-exit",
                    argv: [process.execPath, ...args],
                    code,
                    signal,
                  }),
                );
                resolve({ code, signal });
              });
            },
          );
          child.stdin!.end(JSON.stringify(input));
          return { child, jobId, exited };
        };
        const first = start({
          action,
          ...(point === "mixed pull" ? { serviceIds: ["motis", "data-manager"] } : {}),
          ...(point === "candidate unlink" ? { filesystemFault: "after-retirement-unlink" } : {}),
        });
        try {
          const id = await first.jobId;
          const unlinkBoundary = async () => {
            const marker = join(host.root, "coordinator-retirement-unlinked"),
              until = Date.now() + 150000;
            while (!existsSync(marker)) {
              if (Date.now() > until) throw Error("Actual retirement unlink boundary missing");
              await delay(10);
            }
          };
          await Promise.race([
            point === "candidate unlink" ? unlinkBoundary() : atDecision,
            first.exited.then(() => {
              throw Error("Native API exited before original source boundary");
            }),
          ]);
          const [before] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, id)),
            candidate = (before!.protocol as { candidate: Record<string, unknown> }).candidate,
            path = join(host.candidates, `${candidate.sealedOperationKey}.json`),
            // The native unlink hook publishes these exact bytes only after unlink succeeds.
            bytes =
              point === "candidate unlink"
                ? readFileSync(join(host.root, "coordinator-retirement-unlinked"))
                : readFileSync(path),
            decision = JSON.stringify(candidate.rowVersions),
            inspected = inspectPreparedConfigurationRecord(
              JSON.parse(bytes.toString("utf8")),
            ).record,
            pullKey = pullOperationKeyOf(before!),
            originalNormal =
              inspected.privateCoordinatorLifecycle?.action === "update" && pullKey
                ? readFileSync(
                    join(host.infraDir, "state/ops-agent/control/executions", `${pullKey}.json`),
                  )
                : undefined;
          expect(candidate.phase).toBe(
            point === "candidate unlink"
              ? "generation_applied"
              : !pullBoundary
                ? "rows_saved"
                : "candidate_prepared",
          );
          if (point === "candidate unlink") {
            expect(inspected.operationKey).toBe(candidate.sealedOperationKey);
            expect(existsSync(path)).toBe(false);
            expect(posts.get("configurationMaintenance.settle")).toBe(1);
          }
          expect(await fixture.db.select().from(schema.serviceConfig)).toHaveLength(0);
          expect(posts.get("configurationMaintenance.apply") ?? 0).toBe(!pullBoundary ? 1 : 0);
          if (pullBoundary) expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
          first.child.kill("SIGKILL");
          expect((await first.exited).signal).toBe("SIGKILL");
          decisionReplyGate = undefined;
          pullTerminalReplyGate = undefined;
          release();
          if (point === "canceled pull") {
            const { jobRunner } = await import("../job-runner");
            await jobRunner.cancel(id);
          }
          const [retained] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, id)),
            lease = Date.parse(
              (retained!.protocol as Record<string, unknown>).observationLeaseUntil as string,
            );
          expect(Number.isFinite(lease)).toBe(true);
          while (Date.now() <= lease + 100) await delay(Math.min(1000, lease + 101 - Date.now()));
          if (point !== "candidate unlink") expect(readFileSync(path).equals(bytes)).toBe(true);
          else expect(existsSync(path)).toBe(false);
          const replacement = start({ action: "reconcile", jobId: id });
          const exit = await replacement.exited;
          if (point === "canceled pull") {
            const [row] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, id));
            expect(row!.status).toBe("canceled");
            expect(existsSync(path)).toBe(false);
            expect(posts.get("service.pull")).toBe(1);
            expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
            expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(0);
            expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
              host.initial.revisionId,
            );
            return;
          }
          const [observed] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, id)),
            observation = observed?.result as Record<string, unknown>;
          expect(
            exit.code,
            JSON.stringify({
              status: observed?.status,
              error: observed?.error,
              candidatePhase: (observed?.protocol as { candidate?: { phase?: string } } | undefined)
                ?.candidate?.phase,
              configuration: observation?.configuration,
              operations: Object.values(
                (
                  (observed?.protocol as Record<string, unknown> | undefined)?.operations as
                    | {
                        operations?: Record<
                          string,
                          { kind?: string; phase?: string; receiptDelivery?: object }
                        >;
                      }
                    | undefined
                )?.operations ?? {},
              ).map(({ kind, phase, receiptDelivery }) => ({
                kind,
                phase,
                delivered: receiptDelivery !== undefined,
              })),
            }),
          ).toBe(0);
          const row = await finished(id);
          expect(row.status).toBe("success");
          expect((row.protocol as { execution: { version: number } }).execution.version).toBe(2);
          if (point === "decision")
            expect(
              JSON.stringify(
                (row.protocol as { candidate?: { rowVersions?: unknown } }).candidate?.rowVersions,
              ),
            ).toBe(decision);
          if (originalNormal) {
            expect(
              readFileSync(
                join(host.infraDir, "state/ops-agent/control/executions", `${pullKey}.json`),
              ).equals(originalNormal),
            ).toBe(true);
            expect(posts.get("service.pull")).toBe(1);
          }
          expect(posts.get("configurationMaintenance.prepare")).toBe(1);
          expect(posts.get("configurationMaintenance.apply")).toBe(1);
          expect(posts.get("configurationMaintenance.settle")).toBe(1);
          expect(host.calls.filter((a) => a.includes("--force-recreate"))).toHaveLength(1);
          expect(await fixture.db.select().from(schema.serviceConfig)).toHaveLength(0);
        } finally {
          release();
          decisionReplyGate = undefined;
          pullTerminalReplyGate = undefined;
          for (const child of children)
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
      },
      240000,
    );
    it.each(coordinatorReferenceCases.map((value) => value.name))(
      "updates the coordinator while another service's reference names its image (%s)",
      async () => {
        const reply = await api.inject({
          method: "POST",
          url: "/api/admin/services/bulk-action",
          headers: {
            "idempotency-key": randomUUID(),
            "x-openmapx-local-admin": "task012-coordinator-local-admin",
          },
          payload: { action: "update", serviceIds: ["data-manager"] },
        });
        const row = await finished(reply.json().jobId);
        expect(row.status, row.error ?? "No public error").toBe("success");
        expect(posts.get("service.pull")).toBe(1);
        expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
        // The other service keeps the image its generation recorded until it is recreated.
        const snapshots = await host.owned.inspectOwnedServices(new AbortController().signal);
        expect(snapshots.find((s) => s.serviceId === "motis")?.provenance.imageId).toBe(
          `sha256:${"b".repeat(64)}`,
        );
        expect(snapshots.find((s) => s.serviceId === "data-manager")?.provenance.imageId).toBe(
          pulledImageId,
        );
        expect(await dm.fenceStates()).toEqual(["settled"]);
      },
      180000,
    );
    it("starts an initially stopped coordinator before pull using only its clamped original old-revision helper", async () => {
      expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
      await expect(fetch(dm.baseUrl + "/health")).rejects.toThrow();
      const reply = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: {
          "idempotency-key": randomUUID(),
          "x-openmapx-local-admin": "task012-coordinator-local-admin",
        },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      const row = await finished(reply.json().jobId);
      expect(row.status).toBe("success");
      expect(posts.get("service.start")).toBe(1);
      expect(posts.get("service.pull")).toBe(1);
      expect(posts.get("configurationMaintenance.prepare")).toBe(1);
      const start = host.calls.findIndex(
          (args) => args.includes("--no-recreate") && args.at(-1) === "data-manager",
        ),
        pull = host.calls.findIndex((args) => args[0] === "image" && args[1] === "pull"),
        recreate = host.calls.findIndex((args) => args.includes("--force-recreate"));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(pull).toBeGreaterThan(start);
      expect(recreate).toBeGreaterThan(pull);
      expect(host.calls.filter((args) => args.includes("--no-recreate"))).toHaveLength(1);
      expect(await dm.fenceStates()).toEqual(["settled"]);
    }, 180000);
    it("sends no pull when the whole candidate is refused before the update starts", async () => {
      services.writeServiceSelectionFile(host.infraDir, ["motis"]);
      const reply = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: {
          "idempotency-key": randomUUID(),
          "x-openmapx-local-admin": "task012-coordinator-local-admin",
        },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      const id = reply.json().jobId,
        until = Date.now() + 45000;
      let row: typeof schema.adminJob.$inferSelect | undefined;
      for (;;) {
        [row] = await fixture.db.select().from(schema.adminJob).where(eq(schema.adminJob.id, id));
        const result = row?.result as { observation?: { state?: string } } | undefined;
        if (
          row &&
          (["failed", "success", "canceled"].includes(row.status) ||
            result?.observation?.state === "unknown")
        )
          break;
        if (Date.now() > until) throw Error("Actual refused candidate did not become observable");
        await delay(10);
      }
      expect(row!.status).toBe("failed");
      expect(pullOperationKeyOf(row!)).toBeUndefined();
      expect(posts.get("service.pull") ?? 0).toBe(0);
      expect(posts.get("service.start") ?? 0).toBe(0);
      expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
      expect(readdirSync(host.candidates)).toHaveLength(0);
      expect(await fixture.db.select().from(schema.serviceConfig)).toHaveLength(0);
      const original = JSON.stringify(row!.result);
      services.writeServiceSelectionFile(host.infraDir, ["data-manager", "motis"]);
      const next = await api.inject({
        method: "POST",
        url: "/api/admin/services/data-manager/action",
        headers: {
          "idempotency-key": randomUUID(),
          "x-openmapx-local-admin": "task012-coordinator-local-admin",
        },
        payload: { action: "apply" },
      });
      expect(next.statusCode).toBe(200);
      expect((await finished(next.json().jobId)).status).toBe("success");
      const [unchanged] = await fixture.db
        .select()
        .from(schema.adminJob)
        .where(eq(schema.adminJob.id, id));
      expect(JSON.stringify(unchanged!.result)).toBe(original);
      expect(posts.get("service.pull") ?? 0).toBe(0);
    }, 180000);
    it("settles the authenticated unused OLD runtime after a real acknowledged API SQL rollback following image staging", async () => {
      const reply = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: {
          "idempotency-key": randomUUID(),
          "x-openmapx-local-admin": "task012-coordinator-local-admin",
        },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      const row = await finished(reply.json().jobId);
      expect(refusedDecisionWrites).toBe(1);
      expect(issuedKnownRollbacks).toBeGreaterThan(0);
      expect(row.status).toBe("failed");
      // Nothing was saved: the job carries no candidate any more.
      expect((row.protocol as { candidate?: unknown }).candidate).toBeUndefined();
      const owner = JSON.parse(
        readFileSync(
          join(
            host.infraDir,
            "state/ops-agent/control/maintenance",
            `${maintenanceIdOf(row)}.json`,
          ),
          "utf8",
        ),
      );
      expect(owner.record.state).toBe("settled");
      expect(owner.record.fenceOutcome).toBe("unused");
      expect(owner.record.generation).toBe("not_started");
      expect(posts.get("service.pull")).toBe(1);
      expect(posts.get("stack.render") ?? 0).toBe(0);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(0);
      expect(posts.get("configurationMaintenance.prepare")).toBe(1);
      expect(posts.get("configurationMaintenance.settle")).toBe(1);
      expect(await dm.fenceStates()).toEqual(["settled"]);
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      // The pulled image is unused; the old coordinator runs the image its
      // generation recorded, so it stays the agent's own.
      expect(
        owner.originalContainers.find((s: { serviceId: string }) => s.serviceId === "data-manager")
          ?.provenance.imageId,
      ).toBe(`sha256:${"b".repeat(64)}`);
      expect(
        services.readGenerationImageIds(host.infraDir, host.initial.revisionId)["data-manager"],
      ).toBe(`sha256:${"b".repeat(64)}`);
      expect(
        (await host.owned.inspectOwnedServices(new AbortController().signal)).find(
          (s) => s.serviceId === "data-manager",
        )?.provenance.imageId,
      ).toBe(`sha256:${"b".repeat(64)}`);
      expect(await fixture.db.select().from(schema.serviceConfig)).toHaveLength(0);
      expect(row.error ?? "").not.toContain('update "admin_job"');
      expect(row.error ?? "").not.toContain(host.root);
    }, 180000);
    it.each([
      { name: "original cleanup", retry: false },
      { name: "fresh explicit retry", retry: true },
    ])(
      "expires the original candidate TTL after actual image staging without acquiring maintenance or leaving a writer fence: $name",
      async ({ retry }) => {
        afterPullTerminal = () => {
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(Date.now() + 6 * 60000);
        };
        try {
          const reply = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: {
              "idempotency-key": randomUUID(),
              "x-openmapx-local-admin": "task012-coordinator-local-admin",
            },
            payload: { action: "update", serviceIds: ["data-manager"] },
          });
          const id = reply.json().jobId,
            until = performance.now() + 45000;
          let row: typeof schema.adminJob.$inferSelect | undefined;
          for (;;) {
            [row] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, id));
            const observed = row?.result as { observation?: { state?: string } } | undefined;
            if (
              row &&
              (["success", "failed", "canceled"].includes(row.status) ||
                observed?.observation?.state === "unknown")
            )
              break;
            if (performance.now() > until) throw Error("Expired candidate did not settle");
            await delay(10);
          }
          const operations = Object.values(
            (
              row!.protocol as {
                operations: {
                  operations: Record<
                    string,
                    {
                      kind: string;
                      phase: string;
                      terminal: boolean;
                      errorClass?: string;
                      receiptDelivery?: { terminalReceipt: { state: string } };
                    }
                  >;
                };
              }
            ).operations.operations,
          );
          console.info(
            "actual TTL boundary",
            JSON.stringify({
              state: row!.status,
              operations: operations.map((op) => ({
                kind: op.kind,
                phase: op.phase,
                terminal: op.terminal,
                errorClass: op.errorClass,
                canonical: op.receiptDelivery?.terminalReceipt.state,
              })),
            }),
          );
          expect(posts.get("service.pull")).toBe(1);
          expect(
            operations.find((op) => op.kind === "service.pull")?.receiptDelivery?.terminalReceipt
              .state,
          ).toBe("succeeded");
          expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
          expect(posts.get("service.start") ?? 0).toBe(0);
          expect(row!.status).toBe("failed");
          expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(0);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.initial.revisionId,
          );
          expect(readdirSync(host.candidates)).toHaveLength(0);
          if (retry) {
            // Preserve monotonic process/retention time AND actual PG clock evidence.
            // No SQL clock or signed settlement preimage is substituted.
            await delay(6 * 60000 + 1000);
            vi.useRealTimers();
            const stopNative = await restartNativeStagedAgent();
            try {
              const next = await api.inject({
                  method: "POST",
                  url: "/api/admin/services/bulk-action",
                  headers: {
                    "idempotency-key": randomUUID(),
                    "x-openmapx-local-admin": "task012-coordinator-local-admin",
                  },
                  payload: { action: "update", serviceIds: ["data-manager"] },
                }),
                nextRow = await finished(next.json().jobId);
              console.info(
                "actual fresh staged retry",
                JSON.stringify({
                  state: nextRow.status,
                  error: nextRow.error,
                  configuration: (nextRow.result as Record<string, unknown>)?.configuration,
                  pullPosts: posts.get("service.pull") ?? 0,
                  preparePosts: posts.get("configurationMaintenance.prepare") ?? 0,
                  ordinaryOwnedDM: (
                    await host.owned.inspectOwnedServices(new AbortController().signal)
                  ).some((s) => s.serviceId === "data-manager"),
                }),
              );
              expect(nextRow.status).toBe("success");
              expect(posts.get("service.pull")).toBe(2);
            } finally {
              await stopNative();
            }
          }
        } finally {
          vi.useRealTimers();
        }
      },
      600000,
    );
    it.each([false, true])(
      "preserves the three-target requested revision chain and full selection with noDeps=%s",
      async (noDeps) => {
        const serviceIds = ["motis", "data-manager", "valhalla"],
          reply = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: {
              "idempotency-key": randomUUID(),
              "x-openmapx-local-admin": "task012-coordinator-local-admin",
            },
            payload: { action: "update", serviceIds, noDeps },
          }),
          row = await finished(reply.json().jobId);
        expect(row.status, row.error ?? "No public error").toBe("success");
        expect((row.result as { completedServiceIds: string[] }).completedServiceIds).toEqual(
          serviceIds,
        );
        expect(posts.get("service.update")).toBe(2);
        expect(posts.get("service.pull")).toBe(1);
        expect(posts.get("configurationMaintenance.prepare")).toBe(1);
        expect(dm.settlementResponseStatuses).toEqual([200]);
        const native = readFileSync(nativeTrace, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[]),
          recreates = native.filter((args) => args.includes("--force-recreate"));
        expect(recreates.map((args) => args.at(-1))).toEqual(["motis", "valhalla"]);
        expect(recreates.every((args) => args.includes("--no-deps") === noDeps)).toBe(true);
        expect(services.readAppliedServiceIds(host.infraDir, host.loaded)).toEqual(
          new Set(["data-manager", "motis", "valhalla"]),
        );
      },
      300000,
    );
    it("closes a contained three-target pull failure after the acknowledged ordinary prefix without losing that prefix", async () => {
      host.setImagePullProcess(async (_reference, signal) => {
        await runContainedProcess(process.execPath, ["-e", "process.exit(17)"], {
          signal,
          timeout: 15000,
          maxBuffer: 1024,
        });
      });
      const reply = await api.inject({
          method: "POST",
          url: "/api/admin/services/bulk-action",
          headers: {
            "idempotency-key": randomUUID(),
            "x-openmapx-local-admin": "task012-coordinator-local-admin",
          },
          payload: { action: "update", serviceIds: ["motis", "data-manager", "valhalla"] },
        }),
        id = reply.json().jobId,
        until = performance.now() + 180000;
      let row: typeof schema.adminJob.$inferSelect | undefined;
      for (;;) {
        [row] = await fixture.db.select().from(schema.adminJob).where(eq(schema.adminJob.id, id));
        if (
          row &&
          (["success", "failed", "canceled"].includes(row.status) ||
            (row.result as { observation?: { state: string } })?.observation?.state === "unknown")
        )
          break;
        if (performance.now() > until)
          throw Error("Actual mixed failure did not become observable");
        await delay(25);
      }
      console.info(
        "actual three-target contained prefix",
        JSON.stringify({
          state: row!.status,
          error: row!.error,
          completed: (row!.result as Record<string, unknown>)?.completedServiceIds,
          observation: (row!.result as Record<string, unknown>)?.observation,
          posts: [...posts],
        }),
      );
      expect(row!.status).toBe("failed");
      expect((row!.result as { completedServiceIds: string[] }).completedServiceIds).toEqual([
        "motis",
      ]);
      expect(readdirSync(host.candidates)).toHaveLength(0);
      expect(posts.get("service.update")).toBe(1);
      expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
    }, 240000);
    it("closes three-target cancellation after an acknowledged ordinary prefix and successful coordinator staging", async () => {
      const { id } = await canceledSuccessfulCoordinatorStage([
          "motis",
          "data-manager",
          "valhalla",
        ]),
        row = await finished(id);
      expect((row.result as { completedServiceIds: string[] }).completedServiceIds).toEqual([
        "motis",
      ]);
      expect(posts.get("service.update")).toBe(1);
    }, 240000);
    it.each([
      ["data-manager", "motis"],
      ["motis", "data-manager"],
    ])(
      "carries each actual bulk Update's own revision in requested order %j",
      async (first, second) => {
        const serviceIds = [first, second];
        const reply = await api.inject({
          method: "POST",
          url: "/api/admin/services/bulk-action",
          headers: {
            "idempotency-key": randomUUID(),
            "x-openmapx-local-admin": "task012-coordinator-local-admin",
          },
          payload: { action: "update", serviceIds },
        });
        expect(reply.statusCode).toBe(200);
        const id = reply.json().jobId,
          until = Date.now() + 180000;
        let diagnostic = false;
        let row: typeof schema.adminJob.$inferSelect | undefined;
        for (;;) {
          [row] = await fixture.db.select().from(schema.adminJob).where(eq(schema.adminJob.id, id));
          const value = { ...(row?.result as object), ...(row?.protocol as object) } as
            | {
                observation?: { state?: string; reason?: string };
                operations?: {
                  operations?: Record<
                    string,
                    {
                      kind: string;
                      phase: string;
                      terminal: boolean;
                      errorClass?: string;
                      failureResult?: {
                        serviceLifecycle?: { phase?: string; failure?: { reason?: string } };
                      };
                    }
                  >;
                };
                candidate?: { phase?: string };
              }
            | undefined;
          if (
            !diagnostic &&
            (Date.now() >= until - 160000 || value?.observation?.state === "unknown")
          ) {
            diagnostic = true;
            const { readProjection } = await import("../admin-job-projection");
            try {
              readProjection(row?.protocol, row?.result);
              console.info("actual bulk projection valid");
            } catch (e) {
              console.info(
                "actual bulk projection rejected",
                e instanceof Error ? e.name : "unknown",
              );
            }
            console.info(
              "actual mixed Update diagnostic",
              JSON.stringify({
                order: serviceIds,
                jobState: row?.status,
                observation: value?.observation,
                candidatePhase: value?.candidate?.phase,
                arrivals: [...arrivals],
                posts: [...posts],
                operations: Object.values(value?.operations?.operations ?? {}).map((op) => ({
                  kind: op.kind,
                  phase: op.phase,
                  terminal: op.terminal,
                  errorClass: op.errorClass,
                  lifecyclePhase: op.failureResult?.serviceLifecycle?.phase,
                  lifecycleFailure: op.failureResult?.serviceLifecycle?.failure?.reason,
                })),
              }),
            );
          }
          if (
            row &&
            (["failed", "success", "canceled"].includes(row.status) ||
              value?.observation?.state === "unknown")
          )
            break;
          if (Date.now() > until) throw Error("Actual mixed Update did not settle");
          await delay(20);
        }
        expect(row!.status).toBe("success");
        const result = row!.result as { completedServiceIds: string[] };
        expect(result.completedServiceIds).toEqual(serviceIds);
        expect(posts.get("configurationMaintenance.prepare")).toBe(1);
        expect(posts.get("configurationMaintenance.apply")).toBe(1);
        expect(posts.get("configurationMaintenance.settle")).toBe(1);
        expect(posts.get("service.update")).toBe(1);
        expect(posts.get("service.pull")).toBe(1);
        const native = readFileSync(nativeTrace, "utf8")
          .trim()
          .split("\n")
          .map((value) => JSON.parse(value) as string[]);
        expect(
          native.filter((args) => args.includes("pull") && args.at(-1) === "motis"),
        ).toHaveLength(1);
        expect(
          native.filter((args) => args.includes("--force-recreate") && args.at(-1) === "motis"),
        ).toHaveLength(1);
        expect(
          native.some(
            (args) => args.includes("--force-recreate") && args.at(-1) === "data-manager",
          ),
        ).toBe(false);
      },
      240000,
    );
  },
);
