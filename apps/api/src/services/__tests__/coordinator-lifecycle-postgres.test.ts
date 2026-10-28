import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import filesystem, {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  acquireArtifactTargetLease,
  assertControlExecutionForward,
  assertCoordinatorPullLeaseCompatibility,
  closeControlInstallation,
  controlDigest,
  controlRetentionPreparationState,
  lookupControlChildPhase,
  openControlInstallation,
  ownedCoordinatorPullBaseline,
  reconcileControlRetention,
  recordStagedCoordinatorRetentionCheck,
  releaseArtifactTargetLease,
  restoreAdmittedControlExecution,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  settleArtifactTargetLeaseChild,
  verifyControl,
  verifyControlEffectSettlement,
  verifyRetainedArtifactTargetRootRelease,
} from "@openmapx/core/build-artifacts";
import {
  type CoordinatorPullSubmission,
  createControlRootOperationKey,
  executionFingerprint,
  inspectPreparedConfigurationRecord,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  stagedCoordinatorRetirementDomain,
  stagedCoordinatorRetirementPayloadSchema,
} from "../../../../../packages/core/src/build-artifacts/coordinator-pull-records";
import { ownedDataManager } from "../../../../ops-agent/src/__fixtures__/owned-data-manager";
import { ownedServiceHost } from "../../../../ops-agent/src/__fixtures__/owned-service-host";
import { configurationPolicyRevision } from "../../../../ops-agent/src/configured-resource-authority";
import { runContainedProcess } from "../../../../ops-agent/src/docker-runtime";
import { openOpsJobJournal } from "../../../../ops-agent/src/journal";
import {
  consumeCoordinatorPullOwnershipCapture,
  inspectOriginalCoordinatorServices,
} from "../../../../ops-agent/src/owned-services";
import {
  createPolicyResourceClaimer,
  createProductionRegistryResourceClaimer,
  denyAllTrustedOpsData,
} from "../../../../ops-agent/src/policy";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import * as schema from "../../db/schema";
import { createConfigurationPostgresFixture } from "../../test/configuration-postgres-fixture";

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
    let originalPull: CoordinatorPullSubmission | undefined;
    let afterImageStaging: (() => void) | undefined;
    let afterPullTerminal: (() => void) | undefined;
    let beforeLifecycleProcess: ((args: readonly string[]) => Promise<void>) | undefined;
    let decisionReplyGate: { reached: () => void; release: Promise<void> } | undefined;
    let pullAdmissionReplyGate: { reached: () => void; release: Promise<void> } | undefined;
    let pullTerminalReplyGate: { reached: () => void; release: Promise<void> } | undefined;
    let claimCase:
      | "genuine"
      | "generic resolver"
      | "policy-only"
      | "missing raw revision"
      | "raw suffix drift"
      | "consumed capture" = "genuine";
    let copyPullClaim = false,
      observePullReply: ((status: number) => void) | undefined;
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
                      parameters?: Parameters<typeof connection.unsafe>[1],
                    ) => {
                      const continuation = parameters?.some((value) => {
                        if (typeof value !== "string" || !value.startsWith("{")) return false;
                        try {
                          const v = JSON.parse(value);
                          return (
                            v._configurationCandidate?.phase === "saved" &&
                            v._configurationMaintenanceDecision?.operation?.decision === "continue"
                          );
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
      originalPull = undefined;
      afterImageStaging = undefined;
      afterPullTerminal = undefined;
      beforeLifecycleProcess = undefined;
      decisionReplyGate = undefined;
      pullTerminalReplyGate = undefined;
      pullAdmissionReplyGate = undefined;
      copyPullClaim = false;
      claimCase = "genuine";
      observePullReply = undefined;
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
        ...(test.task.name.includes("all current configuration producers")
          ? {
              schemas: {
                motis: {
                  type: "object",
                  properties: {
                    MODE: { type: "string", default: "old" },
                    TOKEN: { type: "string", "x-openmapx-secret": true },
                  },
                },
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
        ...(test.task.name.includes("full future owner budget")
          ? { oversizedMaintenancePlan: true }
          : {}),
        ...(test.task.name.includes("3072-byte baseline") ? { nestedRootSegments: 9 } : {}),
        ...(references
          ? { imageReferences: { motis: references.sibling, "data-manager": references.target } }
          : {}),
        actualComposeConfig: true,
        defaultCliEntry: fileURLToPath(
          new URL("../../../../ops-agent/src/index.ts", import.meta.url),
        ),
      });
      if (test.task.name.includes("all current configuration producers")) {
        for (const id of ["alpha", "beta"]) {
          const directory = join(host.root, "integrations", id);
          mkdirSync(directory, { recursive: true });
          writeFileSync(
            join(directory, "manifest.json"),
            JSON.stringify({
              id,
              version: "1.0.0",
              author: "Task01.2 fixture",
              license: "MIT",
              domains: ["knowledge"],
              quality: "built-in",
              configSchema: {
                properties: {
                  VALUE: { type: "string", default: "old" },
                  TOKEN: { type: "string", "x-openmapx-secret": true },
                },
              },
            }),
          );
        }
      }
      dm = await ownedDataManager({
        observeSettlementSql: true,
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((s) => s.manifest.id),
      });
      if (test.task.name.includes("3072-byte baseline")) {
        const images = Object.fromEntries(
          services.RELEASE_IMAGE_NAMES.map((name) => [
            name,
            `example/${name}@sha256:${"b".repeat(64)}`,
          ]),
        );
        writeFileSync(
          host.stack.composeReleasePath,
          JSON.stringify({
            "x-openmapx-release": { release: "task012-baseline-budget", images },
            services: {
              "app-api": {
                image: images.api,
                environment: {
                  [services.PRIVACY_BACKUP_COLLECTOR_IMAGE_ENV]: images["privacy-backup"],
                },
              },
              "app-web": { image: images.web },
              "ops-agent": {
                image: images["ops-agent"],
                environment: {
                  [services.PRIVACY_BACKUP_COLLECTOR_IMAGE_ENV]: images["privacy-backup"],
                },
              },
              "data-manager": {
                image: images["data-manager"],
                environment: { [services.TRANSITOUS_TOOLS_IMAGE_ENV]: images["transitous-tools"] },
              },
              "transitous-runner": { image: images["transitous-runner"] },
            },
          }),
          { mode: 0o600 },
        );
        host.row.Labels["com.docker.compose.project.config_files"] = [
          host.firstCompose,
          host.stack.composeReleasePath,
        ].join(",");
      }
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
        const candidates = readdirSync(join(host.queue, ".candidates"));
        expect(candidates).toHaveLength(1);
        const candidate = inspectPreparedConfigurationRecord(
            readFileSync(join(host.queue, ".candidates", candidates[0]!)),
            host.token,
          ).record,
          fixed = candidate.privateCoordinatorLifecycle;
        if (fixed?.action !== "update") throw Error("Actual original sealed Update source missing");
        originalPull = fixed.pull;
        if (test.task.name.includes("stopped coordinator before pull")) {
          const helper = candidate.coordinatorPrerequisite!;
          const actual = JSON.parse(
            readFileSync(
              join(
                host.infraDir,
                "control-private/ops-agent/executions",
                `${helper.root.operationKey}.json`,
              ),
              "utf8",
            ),
          ).payload;
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
        tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
        runtime: host.runtime,
        resourceClaimer: {
          claim: async (...args) => {
            if (
              args[0].kind === "service.pull" &&
              claimCase !== "genuine" &&
              claimCase !== "consumed capture"
            ) {
              if (claimCase === "policy-only")
                return createPolicyResourceClaimer({ allowService: () => true }).claim(...args);
              const source = await host.loadAuthority(),
                applied = await host.actionAuthority();
              const registered = source.services.map((s) => ({
                serviceId: s.manifest.id,
                enabled: s.enabled,
                isBuiltIn: s.isBuiltIn,
              }));
              return createProductionRegistryResourceClaimer({
                services: registered,
                integrationIds: [],
                trustedData: denyAllTrustedOpsData,
                ownedServices:
                  claimCase === "generic resolver"
                    ? { inspectOwnedServices: (signal) => host.owned.inspectOwnedServices(signal) }
                    : host.owned,
                enabledServiceIds: () => applied.enabledServiceIds,
                serviceMetadata: (ss) => ss.map((value) => ({ ...value, buildable: false })),
                loadAuthority: async () => ({
                  revisionId: configurationPolicyRevision(source.revisionId),
                  services: registered,
                  integrationIds: [],
                  ...(claimCase === "missing raw revision"
                    ? {}
                    : {
                        configurationAuthorityRevision:
                          claimCase === "raw suffix drift"
                            ? `${source.revisionId.slice(0, -1)}${source.revisionId.endsWith("A") ? "B" : "A"}`
                            : source.revisionId,
                      }),
                }),
              }).claim(...args);
            }
            const raw = await host.claimer.claim(...args);
            if (
              raw &&
              args[0].kind === "service.pull" &&
              args[0].candidateId &&
              claimCase === "consumed capture"
            )
              consumeCoordinatorPullOwnershipCapture(raw, {
                operationFingerprint: args[1],
                candidateId: args[0].candidateId,
                policyRevision: raw.capability.revisionId,
              });
            return raw && copyPullClaim && args[0].kind === "service.pull"
              ? {
                  ...raw,
                  operation: structuredClone(raw.operation),
                  capability: structuredClone(raw.capability),
                }
              : raw;
          },
        },
        journal: await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json")),
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
        if (kind === "service.pull") {
          observePullReply?.(_reply.statusCode);
          if (pullAdmissionReplyGate) {
            pullAdmissionReplyGate.reached();
            await pullAdmissionReplyGate.release;
          }
        }
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
        if (kind === "configurationMaintenance.decide" && decisionReplyGate) {
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
        OPS_TRUSTED_CONFIG_DIR: host.queue,
        OPS_TRUSTED_CONFIG_UID: String(statSync(host.queue).uid),
        OPS_TRUSTED_CONFIG_GID: String(statSync(host.queue).gid),
        OPENMAPX_ROOT_DIR: host.root,
        OPENMAPX_SECRETS_KEY: "71".repeat(32),
        OPENMAPX_LOCAL_ADMIN_TOKEN: "task012-coordinator-local-admin",
        OPENMAPX_DISABLE_LOCALHOST_AUTH: "0",
        DATA_MANAGER_URL: dm.baseUrl,
        DATA_MANAGER_AUTH_TOKEN: dm.token,
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
      await initIntegrations(
        api,
        test.task.name.includes("all current configuration producers")
          ? [{ directory: join(host.root, "integrations"), isBuiltIn: true }]
          : [],
      );
      const { requireAdmin } = await import("../../utils/require-admin");
      api.addHook("preHandler", async (request: FastifyRequest) => {
        request.adminSession = await requireAdmin(request);
      });
      const { adminServicesRoute } = await import("../../routes/admin-services");
      await api.register(adminServicesRoute, { prefix: "/api" });
      if (test.task.name.includes("all current configuration producers")) {
        const { adminIntegrationsRoute } = await import("../../routes/admin-integrations"),
          { registerAdminComposeRoutes } = await import("../../routes/admin-compose");
        await api.register(adminIntegrationsRoute, { prefix: "/api" });
        const { adminIntegrationCredentialsRoute } = await import(
          "../../routes/admin-integration-credentials"
        );
        await api.register(adminIntegrationCredentialsRoute, { prefix: "/api" });
        await api.register(registerAdminComposeRoutes, { prefix: "/api" });
      }
      await api.ready();
    }, 60000);
    afterEach(async () => {
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
                  row?.result as {
                    opsProjection?: {
                      operations?: Record<
                        string,
                        { kind?: string; phase?: string; errorClass?: string }
                      >;
                    };
                  }
                )?.opsProjection?.operations ?? {},
              ).map((value) => ({
                kind: value.kind,
                phase: value.phase,
                errorClass: value.errorClass,
              })),
              candidate: (row?.result as { _configurationCandidate?: { phase?: string } })
                ?._configurationCandidate?.phase,
              maintenance: (row?.result as { _configurationMaintenance?: { phase?: string } })
                ?._configurationMaintenance?.phase,
            }),
          );
        }
        if (performance.now() >= until) throw Error("Actual coordinator API job did not settle");
        await delay(25);
      }
    }
    async function canceledSuccessfulCoordinatorStage(
      beforeAcknowledgement?: () => Promise<void>,
      serviceIds = ["data-manager"],
    ) {
      const reached = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      pullTerminalReplyGate = { reached: () => reached.resolve(), release: release.promise };
      try {
        const first = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
            payload: { action: "update", serviceIds },
          }),
          id = first.json().jobId;
        await reached.promise;
        await beforeAcknowledgement?.();
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
        expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(0);
        expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
        const [retained] = await fixture.db
          .select()
          .from(schema.adminJob)
          .where(eq(schema.adminJob.id, id));
        const pull = Object.values(
          (
            retained!.result as {
              opsProjection: { operations: Record<string, { kind: string; operationKey: string }> };
            }
          ).opsProjection.operations,
        ).find((value) => value.kind === "service.pull")!;
        return {
          id,
          pullPath: join(
            host.infraDir,
            "control-private/ops-agent/executions",
            `${pull.operationKey}.json`,
          ),
        };
      } finally {
        pullTerminalReplyGate = undefined;
        release.resolve();
      }
    }
    async function restartNativeStagedAgent(
      options: { stopAfterFirstTargetRelease?: "held" | "unwound" } = {},
    ) {
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
        ready = Promise.withResolvers<{ url: string; ownedDM: boolean }>(),
        fault = Promise.withResolvers<void>();
      let observedFault = false,
        killedForFault = false,
        closed = false;
      let output = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const lines = output.split("\n");
        output = lines.pop()!;
        for (const line of lines) {
          const event = JSON.parse(line);
          if (event.event === "ready") ready.resolve(event);
          if (event.event === "source-writer-busy")
            console.info(
              "actual native source writer busy",
              JSON.stringify({ sameProcess: event.sameProcess, frames: event.frames }),
            );
          if (event.event === "pre-effect-release-unlinked") {
            observedFault = true;
            fault.resolve();
          }
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
          queue: host.queue,
          token: host.token,
          serviceIds: host.loaded.map((service) => service.manifest.id),
          dockerBridge: `${dockerBridge}/docker`,
          ...(options.stopAfterFirstTargetRelease
            ? { stopAfterFirstTargetRelease: options.stopAfterFirstTargetRelease }
            : {}),
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
      const killAfterFault = async () => {
        await fault.promise;
        expect(observedFault).toBe(true);
        expect(child.kill("SIGKILL")).toBe(true);
        killedForFault = true;
        const result = await exited;
        expect(result).toEqual({ code: null, signal: "SIGKILL" });
      };
      const stop = async () => {
        if (closed) return;
        if (observedFault && !killedForFault) await killAfterFault();
        if (!killedForFault) child.kill("SIGTERM");
        const result = await exited;
        await bridge.close();
        closed = true;
        expect(result).toEqual(
          killedForFault ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null },
        );
      };
      return Object.assign(stop, { fault: fault.promise, killAfterFault });
    }
    it("requires the actual API ACK before a successful staged pull becomes ownership evidence", async () => {
      await canceledSuccessfulCoordinatorStage(async () => {
        expect(
          (await host.owned.inspectOwnedServices(new AbortController().signal)).some(
            (s) => s.serviceId === "data-manager",
          ),
        ).toBe(false);
      });
      expect(
        (await host.owned.inspectOwnedServices(new AbortController().signal)).some(
          (s) => s.serviceId === "data-manager",
        ),
      ).toBe(true);
    }, 180000);
    it("reconstructs staged ownership in a NEW native production agent before a fresh user Update", async () => {
      const { pullPath } = await canceledSuccessfulCoordinatorStage(),
        original = readFileSync(pullPath),
        stop = await restartNativeStagedAgent();
      try {
        const next = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
              headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
              payload: { action: "update", serviceIds: ["data-manager"] },
            }),
            row = await finished(reply.json().jobId),
            projection = (
              row.result as {
                opsProjection: {
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
            ).opsProjection,
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
          expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(0);
          expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
          const path = join(
            host.infraDir,
            "control-private/ops-agent/executions",
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
              headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        payload: { action: "apply" },
      });
      const row = await finished(next.json().jobId);
      expect(row.status, row.error ?? "No public error").toBe("success");
      expect(posts.get("service.pull")).toBe(1);
      expect(posts.get("configurationMaintenance.prepare")).toBe(1);
      expect(dm.settlementResponseStatuses).toEqual([200]);
    }, 300000);
    it("guards all current configuration producers before any desired write while staged DM is required", async () => {
      await fixture.db
        .insert(schema.serviceConfig)
        .values({ id: randomUUID(), serviceId: "motis", config: { MODE: "old" } });
      await fixture.db.insert(schema.integrationConfig).values([
        { id: randomUUID(), integrationId: "alpha", config: { VALUE: "old", enabled: true } },
        { id: randomUUID(), integrationId: "beta", config: { VALUE: "old", enabled: true } },
      ]);
      const { pullPath } = await canceledSuccessfulCoordinatorStage(),
        original = readFileSync(pullPath),
        before = services.currentConfigurationGeneration(host.infraDir),
        rows = async () =>
          Promise.all([
            fixture.sql`SELECT id,xmin::text AS version FROM service_config ORDER BY id`,
            fixture.sql`SELECT id,xmin::text AS version FROM integration_config ORDER BY id`,
            fixture.sql`SELECT id,xmin::text AS version FROM service_secret ORDER BY id`,
            fixture.sql`SELECT id,xmin::text AS version FROM integration_secret ORDER BY id`,
          ]),
        unchanged = await rows(),
        selection = services.readDesiredSelection(host.infraDir),
        sdk = await import("@openmapx/core/api-admin-sdk"),
        { createApiClient } = await import("@openmapx/core"),
        baseUrl = await api.listen({ host: "127.0.0.1", port: 0 }),
        options = {
          client: createApiClient({ baseUrl }),
          headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        },
        mutations: readonly [
          string,
          (headers: { "idempotency-key": string }) => Promise<{ status: number; data: unknown }>,
        ][] = [
          [
            "service config",
            (headers) =>
              sdk.updateAdminServiceConfig("motis", { config: { MODE: "new" } }, headers, options),
          ],
          [
            "service credential set",
            (headers) =>
              sdk.setAdminServiceCredential(
                "motis",
                "TOKEN",
                { value: "synthetic-new-secret" },
                headers,
                options,
              ),
          ],
          [
            "service credential delete",
            (headers) =>
              sdk.deleteAdminServiceCredential("motis", "TOKEN", headers, undefined, options),
          ],
          [
            "selection",
            (headers) =>
              sdk.setAdminServiceSelection(
                { selectedRoots: ["data-manager", "motis"] },
                headers,
                options,
              ),
          ],
          [
            "integration config",
            (headers) =>
              sdk.patchAdminIntegrationConfig("alpha", { VALUE: "new" }, headers, options),
          ],
          [
            "integration credential set",
            (headers) =>
              sdk.setAdminIntegrationCredential(
                "alpha",
                "TOKEN",
                { value: "synthetic-new-secret" },
                headers,
                options,
              ),
          ],
          [
            "integration credential delete",
            (headers) =>
              sdk.deleteAdminIntegrationCredential("alpha", "TOKEN", headers, undefined, options),
          ],
          [
            "integration enable",
            (headers) => sdk.enableAdminIntegration("alpha", headers, undefined, options),
          ],
          [
            "integration disable",
            (headers) => sdk.disableAdminIntegration("alpha", headers, undefined, options),
          ],
          [
            "ordinary batch import",
            (headers) =>
              sdk.importAdminIntegrationConfigs(
                {
                  integrations: [
                    { integrationId: "alpha", config: { VALUE: "batch-a" } },
                    { integrationId: "beta", config: { VALUE: "batch-b", enabled: false } },
                  ],
                },
                headers,
                options,
              ),
          ],
          [
            "unchanged ordinary import",
            (headers) =>
              sdk.importAdminIntegrationConfigs(
                {
                  integrations: [
                    { integrationId: "alpha", config: { VALUE: "old", enabled: true } },
                  ],
                },
                headers,
                options,
              ),
          ],
          ["Compose Up", (headers) => sdk.startAdminCompose(headers, undefined, options)],
        ];
      let index = 0;
      for (const [name, run] of mutations) {
        const response = await run({ "idempotency-key": `task012-staged-current-${index++}` });
        expect(response.status, `${name}: ${JSON.stringify(response.data)}`).toBe(409);
        expect(JSON.stringify(response.data)).toContain(
          "Apply or update Data Manager before changing instance configuration.",
        );
        expect(await rows()).toEqual(unchanged);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(before);
        expect(services.readDesiredSelection(host.infraDir)).toEqual(selection);
        expect(readFileSync(pullPath)).toEqual(original);
        expect(readdirSync(join(host.queue, ".candidates"))).toEqual([]);
      }
      expect(posts.get("service.pull")).toBe(1);
      expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
      for (const kind of [
        "stack.render",
        "serviceSelection.apply",
        "serviceConfig.apply",
        "integrationConfig.apply",
        "vault.apply",
        "stack.start",
      ])
        expect(posts.get(kind) ?? 0).toBe(0);
      const preview = await api.inject({
        method: "GET",
        url: "/api/admin/compose/preview",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const repair = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      expect((await finished(repair.json().jobId)).status).toBe("success");
      // Original failed requests remain failed after repair; only a NEW key
      // can evaluate new source state. No old import proof/intent is replayed.
      for (const index of [9, 10]) {
        const [name, run] = mutations[index]!;
        const replay = await run({ "idempotency-key": `task012-staged-current-${index}` });
        expect(replay.status, name).toBe(409);
        expect(JSON.stringify(replay.data)).toContain(
          "Apply or update Data Manager before changing instance configuration.",
        );
      }
      const resumed = await sdk.importAdminIntegrationConfigs(
        { integrations: [{ integrationId: "alpha", config: { VALUE: "old", enabled: true } }] },
        { "idempotency-key": "task012-staged-current-new-unchanged" },
        options,
      );
      expect(resumed.status, JSON.stringify(resumed.data)).toBe(200);
      expect(resumed.data).toMatchObject({ ok: true, imported: 0 });
    }, 300000);
    it("checks the literal staged prerequisite before current release-source writes", async () => {
      const { pullPath } = await canceledSuccessfulCoordinatorStage(),
        originalPull = readFileSync(pullPath);
      const { productionReleaseEffects } = await import(
          "../../../../ops-agent/src/production-runtime"
        ),
        directory = join(host.infraDir, ".ops-agent-releases"),
        manifest = services.parseReleaseManifest(
          JSON.stringify({
            schemaVersion: 1,
            release: "interlock-release",
            images: Object.fromEntries(
              services.RELEASE_IMAGE_NAMES.map((name) => [
                name,
                `ghcr.io/openmapx/${name}@sha256:${"f".repeat(64)}`,
              ]),
            ),
            privacyReleaseValidation: {
              version: 1,
              sourceBuildFingerprint: "f".repeat(64),
              validatedAt: "2026-09-12T12:00:00.000Z",
              checks: {
                translationsConsistent: true,
                openApiConsistent: true,
                policyConsistent: true,
              },
            },
          }),
        );
      writeFileSync(
        join(directory, "interlock-release.json"),
        services.canonicalReleaseManifest(manifest),
        { mode: 0o600 },
      );
      const effects = productionReleaseEffects(host.runtime),
        context = { signal: new AbortController().signal, emitLog() {} },
        before = services.currentConfigurationGeneration(host.infraDir),
        originalFiles = readdirSync(directory).sort(),
        outcome = await effects.apply("interlock-release", ["app-api"], context).then(
          () => null,
          (error) => error,
        );
      expect(existsSync(host.stack.composeReleasePath)).toBe(false);
      expect(existsSync(join(directory, "transaction.json"))).toBe(false);
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(before);
      expect(readdirSync(directory).sort()).toEqual(originalFiles);
      expect(readFileSync(pullPath)).toEqual(originalPull);
      expect(outcome).toMatchObject({ errorClass: "configuration_prerequisite" });
      await expect(effects.resolve(context)).rejects.toMatchObject({
        errorClass: "configuration_prerequisite",
      });
      const repair = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      expect((await finished(repair.json().jobId)).status).toBe("success");
      const { OpsNotWiredError } = await import("../../../../ops-agent/src/runtime");
      await expect(effects.apply("interlock-release", ["app-api"], context)).rejects.toBeInstanceOf(
        OpsNotWiredError,
      );
      expect(existsSync(host.stack.composeReleasePath)).toBe(false);
      expect(existsSync(join(directory, "transaction.json"))).toBe(false);
      // Local release selection keeps its existing refusal after the real DM
      // prerequisite is resolved; no release/app update permission is added.
      await expect(effects.resolve(context)).rejects.toBeInstanceOf(
        services.ReleaseChannelDisabledError,
      );
    }, 240000);
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
        ownerJob = jobs.find(
          (job) => (job.result as Record<string, unknown>)?._configurationMaintenance,
        ),
        checkpoint = ownerJob!.result as {
          _configurationMaintenance: { receipt: { binding: { maintenanceId: string } } };
        },
        owner = JSON.parse(
          readFileSync(
            join(
              host.infraDir,
              "control-private/ops-agent/configuration-maintenance",
              `${checkpoint._configurationMaintenance.receipt.binding.maintenanceId}.json`,
            ),
            "utf8",
          ),
        ).payload;
      expect(owner.stagedCoordinatorProvenance.payload.ownerPrepare).toEqual(owner.plan.prepare);
      expect(owner.coordinatorPull ?? null).toBeNull();
      expect(owner.plan.coordinatorImage).toMatchObject({
        action: "apply",
        imageId: pulledImageId,
      });
      expect(
        Buffer.byteLength(JSON.stringify(owner.stagedCoordinatorProvenance)),
      ).toBeLessThanOrEqual(8192);
      expect(
        (await host.owned.inspectOwnedServices(new AbortController().signal)).find(
          (s) => s.serviceId === "data-manager",
        )?.provenance.imageId,
      ).toBe(pulledImageId);
      expect(await fixture.db.select().from(schema.serviceSecret)).toHaveLength(1);
    }, 180000);
    it("pins the LAST authenticated staged normal family beyond 72h while OLD B still needs it", async () => {
      const { pullPath } = await canceledSuccessfulCoordinatorStage();
      expect(existsSync(pullPath)).toBe(true);
      expect(
        (await host.owned.inspectOwnedServices(new AbortController().signal)).some(
          (s) => s.serviceId === "data-manager",
        ),
      ).toBe(true);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 96 * 3600000);
      try {
        for (let step = 0; step < 12; step++)
          await reconcileControlRetention(installation, { maxFamilies: 64 });
        expect(existsSync(pullPath)).toBe(true);
        expect(
          (await host.owned.inspectOwnedServices(new AbortController().signal)).some(
            (s) => s.serviceId === "data-manager",
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    }, 180000);
    it("retires the authenticated staged family after actual guarded E replacement restores ordinary ownership", async () => {
      const { pullPath } = await canceledSuccessfulCoordinatorStage();
      const next = await api.inject({
        method: "POST",
        url: "/api/admin/services/data-manager/action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        payload: { action: "apply" },
      });
      expect((await finished(next.json().jobId)).status).toBe("success");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 96 * 3600000);
      try {
        let retired = 0;
        for (let step = 0; step < 12; step++)
          retired += (await reconcileControlRetention(installation, { maxFamilies: 64 })).retired;
        expect(existsSync(pullPath)).toBe(false);
        expect(retired).toBeGreaterThan(0);
        const jobs = JSON.parse(
          readFileSync(join(host.infraDir, "data/ops-agent/jobs-v1.json"), "utf8"),
        ).jobs as { operationKey: string }[];
        expect(jobs.some((job) => pullPath.endsWith(`/${job.operationKey}.json`))).toBe(false);
        expect(
          (await host.owned.inspectOwnedServices(new AbortController().signal)).some(
            (s) => s.serviceId === "data-manager",
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
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
          headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
              live!.result as {
                opsProjection: {
                  operations: Record<string, { kind: string; operationKey: string }>;
                };
              }
            ).opsProjection.operations,
          ).find((operation) => operation.kind === "service.start")!,
          lease = JSON.parse(
            readFileSync(
              join(
                host.infraDir,
                "control-private/ops-agent/execution-leases",
                `${root.operationKey}.json`,
              ),
              "utf8",
            ),
          ),
          owner = JSON.parse(
            readFileSync(
              join(host.infraDir, "data/.admin-target-control/leases", lease.leaseId, "owner.json"),
              "utf8",
            ),
          );
        expect(owner.payload.certificate.payload.serviceIds).toContain("data-manager");
        const request = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
            payload: { action: "update", serviceIds: ["data-manager"] },
          }),
          stopped = await finished(request.json().jobId);
        expect(stopped.status).toBe("failed");
        expect(host.calls.filter((args) => args[0] === "image" && args[1] === "pull")).toHaveLength(
          0,
        );
        expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
        expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(0);
      } finally {
        beforeLifecycleProcess = undefined;
        release.resolve();
        expect((await finished(startId)).status).toBe("success");
      }
      const repaired = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      expect((await finished(repaired.json().jobId)).status).toBe("success");
    }, 240000);
    it("observes its genuine pull admission without target metadata writes and rejects replacement of its indexed inode", async () => {
      const { pullPath } = await canceledSuccessfulCoordinatorStage(),
        bytes = readFileSync(pullPath),
        actual = JSON.parse(bytes.toString("utf8")).payload,
        authority = restoreAdmittedControlExecution(installation, actual.execution),
        snapshot = () =>
          Object.fromEntries(
            ["data/.admin-target-control", "control-private/ops-agent/observations"].flatMap(
              (base) => {
                const directory = join(host.infraDir, base);
                return readdirSync(directory, { recursive: true })
                  .map(String)
                  .sort()
                  .map((name) => {
                    const path = join(directory, name),
                      stat = statSync(path);
                    return [
                      `${base}/${name}`,
                      `${stat.dev}:${stat.ino}:${stat.mode}:${stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "directory"}`,
                    ];
                  });
              },
            ),
          );
      expect(existsSync(join(host.infraDir, "data/.admin-target-control/admission-index-v1"))).toBe(
        false,
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
      renameSync(pullPath, `${pullPath}.original-indexed-inode`);
      writeFileSync(pullPath, bytes, { mode: 0o600 });
      expect(() => assertCoordinatorPullLeaseCompatibility(authority)).toThrow();
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
          dataRoot: join(host.infraDir, "data"),
          owner: authority,
          serviceIds: host.loaded.map((service) => service.manifest.id).sort(),
        });
      expect(lease.serviceIds).toContain("data-manager");
      let pullObserver: ReturnType<typeof restoreAdmittedControlExecution> | undefined;
      const snapshot = () =>
        Object.fromEntries(
          [
            "data/.admin-target-control/locks",
            "data/.admin-target-control/leases",
            "data/.admin-target-control/admission-index-v1",
            "control-private/ops-agent/observations",
          ].flatMap((base) => {
            const directory = join(host.infraDir, base);
            return readdirSync(directory, { recursive: true })
              .map(String)
              .sort()
              .map((name) => {
                const path = join(directory, name),
                  stat = statSync(path);
                return [
                  `${base}/${name}`,
                  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "directory"}`,
                ];
              });
          }),
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
            headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
        expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(0);
        const directory = join(host.infraDir, "control-private/ops-agent/executions"),
          actualPulls = readdirSync(directory)
            .filter((name) => name.endsWith(".json"))
            .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")))
            .filter((raw) => raw.payload?.operation?.kind === "service.pull");
        expect(actualPulls).toHaveLength(1);
        const observer = restoreAdmittedControlExecution(
          installation,
          actualPulls[0].payload.execution,
        );
        pullObserver = observer;
        const journal = join(
          host.infraDir,
          "data/.admin-target-control/leases",
          lease.leaseId,
          ".journal-writer",
        );
        mkdirSync(journal, { mode: 0o700 });
        try {
          const before = snapshot(),
            started = performance.now();
          expect(() => assertCoordinatorPullLeaseCompatibility(observer)).toThrow();
          expect(performance.now() - started).toBeLessThan(5000);
          expect(snapshot()).toEqual(before);
        } finally {
          rmdirSync(journal);
        }
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
      const slot = join(
        host.infraDir,
        "data/.admin-target-control/admission-index-v1/active/slot-255",
      );
      mkdirSync(slot, { mode: 0o700 });
      writeFileSync(join(slot, "generation.json"), JSON.stringify({ generation: randomUUID() }), {
        mode: 0o600,
      });
      try {
        const partial = snapshot();
        expect(() => assertCoordinatorPullLeaseCompatibility(releasedObserver)).toThrow();
        expect(snapshot()).toEqual(partial);
      } finally {
        rmSync(slot, { recursive: true });
      }
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
          dataRoot: join(host.infraDir, "data"),
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
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      expect((await finished(next.json().jobId)).status).toBe("success");
    }, 240000);
    it.each(["capability", "admission"])(
      "keeps bare coordinator pull unavailable at its actual %s boundary",
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
            available: false,
            execution: "direct",
            reason: "unavailable",
            workflow: null,
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
            join(host.infraDir, "control-private/ops-agent/executions", `${operationKey}.json`),
          ),
        ).toBe(false);
      },
      90000,
    );
    it("settles only the original unstarted normal CLI Update root when staged configuration is required", async () => {
      await canceledSuccessfulCoordinatorStage();
      const { createApiOpsClient } = await import("../ops-client"),
        client = createApiOpsClient(),
        before = services.currentConfigurationGeneration(host.infraDir),
        deadlineAt = Date.now() + 180000,
        operationKey = createControlRootOperationKey({
          notAfter: deadlineAt,
          nonce: randomBytes(16),
        }),
        submitted = await client.execute(
          { kind: "service.update", serviceId: "motis", expectedConfigurationRevisionId: before! },
          { operationKey, execution: { requestedDeadlineAt: deadlineAt } },
        );
      if (submitted.execution !== "async") throw Error("Actual normal CLI admission required");
      const until = performance.now() + 90000;
      let terminal = await client.status("service.update", submitted.operationId);
      while (!["succeeded", "failed", "timed_out"].includes(terminal.state)) {
        if (performance.now() > until) throw Error("Actual managed CLI did not settle");
        await delay(25);
        terminal = await client.status("service.update", submitted.operationId);
      }
      console.info(
        "actual staged CLI pre-effect",
        JSON.stringify({
          state: terminal.state,
          errorClass: terminal.errorClass,
          nativeCalls: existsSync(nativeTrace)
            ? readFileSync(nativeTrace, "utf8").trim().split("\n").filter(Boolean).length
            : 0,
          currentUnchanged: services.currentConfigurationGeneration(host.infraDir) === before,
        }),
      );
      expect(terminal.state).toBe("failed");
      expect(terminal.errorClass).toBe("configuration_prerequisite");
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(before);
      const native = existsSync(nativeTrace)
        ? readFileSync(nativeTrace, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
        : [];
      expect(
        native.filter((args) => args.includes("up") || (args[0] === "image" && args[1] === "pull")),
      ).toHaveLength(0);
      const privateRoot = join(host.infraDir, "control-private/ops-agent"),
        admitted = JSON.parse(
          readFileSync(join(privateRoot, "executions", `${operationKey}.json`), "utf8"),
        ).payload,
        effect = JSON.parse(
          readFileSync(join(privateRoot, "effects", `${operationKey}.json`), "utf8"),
        ).payload;
      expect(
        JSON.parse(
          readFileSync(join(privateRoot, "effect-started", `${operationKey}.json`), "utf8"),
        ),
      ).toBeNull();
      expect(effect.receipt.kind).toBe("not-started");
      expect(effect.outcome).toBe("failed_without_effect");
      const originalRoot = restoreAdmittedControlExecution(installation, admitted.execution);
      expect(lookupControlChildPhase(originalRoot, { phase: "lifecycle", ordinal: 0 })).toBeNull();
      verifyRetainedArtifactTargetRootRelease(originalRoot);
      const repaired = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      expect((await finished(repaired.json().jobId)).status).toBe("success");
    }, 240000);
    it("refuses a normal ordinary root admitted DURING actual image pull before publication or CLI dispatch", async () => {
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
          headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
        const source = JSON.parse(
          readFileSync(
            join(host.infraDir, "control-private/ops-agent/executions", `${operationKey}.json`),
            "utf8",
          ),
        ).payload;
        expect(
          JSON.parse(
            readFileSync(
              join(
                host.infraDir,
                "control-private/ops-agent/effect-started",
                `${operationKey}.json`,
              ),
              "utf8",
            ),
          ),
        ).toBeNull();
        expect(
          existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
        ).toBe(true);
        release.resolve();
        await terminalReached.promise;
        let state = await client.status("service.update", admitted.operationId);
        const until = performance.now() + 45000;
        while (!["failed", "succeeded", "timed_out"].includes(state.state)) {
          if (performance.now() > until) throw Error("Actual racing CLI did not settle");
          await delay(25);
          state = await client.status("service.update", admitted.operationId);
        }
        expect(state).toMatchObject({ state: "failed", errorClass: "configuration_prerequisite" });
        const authority = restoreAdmittedControlExecution(installation, source.execution);
        expect(lookupControlChildPhase(authority, { phase: "lifecycle", ordinal: 0 })).toBeNull();
        verifyRetainedArtifactTargetRootRelease(authority);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        terminalRelease.resolve();
        expect((await finished(jobId)).status).toBe("success");
        completed = true;
        expect(posts.get("service.pull")).toBe(1);
        expect(posts.get("configurationMaintenance.prepare")).toBe(1);
        expect(dm.settlementResponseStatuses).toEqual([200]);
      } finally {
        release.resolve();
        terminalRelease.resolve();
        pullTerminalReplyGate = undefined;
        if (id && !completed) await finished(id);
      }
    }, 240000);
    it.each([false, true])(
      "preserves pending staged bulk request order with coordinatorFirst=%s",
      async (coordinatorFirst) => {
        const { pullPath } = await canceledSuccessfulCoordinatorStage(),
          original = readFileSync(pullPath),
          before = services.currentConfigurationGeneration(host.infraDir),
          serviceIds = coordinatorFirst ? ["data-manager", "motis"] : ["motis", "data-manager"],
          response = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
        if (coordinatorFirst) {
          expect(row.status, row.error ?? "No public error").toBe("success");
          expect((row.result as { completedServiceIds: string[] }).completedServiceIds).toEqual(
            serviceIds,
          );
          expect(posts.get("service.pull")).toBe(2);
          expect(posts.get("service.update")).toBe(1);
        } else {
          expect(row.status).toBe("failed");
          expect(row.error).toBe(
            "Apply or update Data Manager before changing instance configuration.",
          );
          expect(posts.get("service.pull")).toBe(1);
          expect(posts.get("service.update") ?? 0).toBe(0);
          expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(before);
          expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(0);
          expect(readFileSync(pullPath)).toEqual(original);
          const repair = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
            payload: { action: "update", serviceIds: ["data-manager"] },
          });
          expect((await finished(repair.json().jobId)).status).toBe("success");
          const retry = await api.inject({
              method: "POST",
              url: "/api/admin/services/bulk-action",
              headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
              payload: { action: "update", serviceIds },
            }),
            retried = await finished(retry.json().jobId);
          expect(retried.status, retried.error ?? "No public error").toBe("success");
          expect((retried.result as { completedServiceIds: string[] }).completedServiceIds).toEqual(
            serviceIds,
          );
          expect((await finished(originalId)).status).toBe("failed");
          expect((await finished(originalId)).error).toBe(row.error);
        }
        expect(services.readAppliedServiceIds(host.infraDir, host.loaded)).toEqual(
          new Set(["data-manager", "motis"]),
        );
      },
      420000,
    );
    it.each(["held", "unwound"] as const)(
      "observes native pre-effect first-unlink SIGKILL with journal guard %s",
      async (guard) => {
        await canceledSuccessfulCoordinatorStage();
        const first = await restartNativeStagedAgent({ stopAfterFirstTargetRelease: guard }),
          { createApiOpsClient } = await import("../ops-client"),
          client = createApiOpsClient(),
          deadlineAt = Date.now() + 120000,
          operation = {
            kind: "service.update" as const,
            serviceId: "motis",
            expectedConfigurationRevisionId: host.initial.revisionId,
          },
          operationKey = createControlRootOperationKey({
            notAfter: deadlineAt,
            nonce: randomBytes(16),
          }),
          request = client
            .execute(operation, { operationKey, execution: { requestedDeadlineAt: deadlineAt } })
            .catch(() => undefined);
        try {
          await Promise.race([
            first.fault,
            delay(45000).then(() => {
              throw Error("Actual native release fault not reached");
            }),
          ]);
          const privateRoot = join(host.infraDir, "control-private/ops-agent"),
            admissionPath = join(privateRoot, "executions", `${operationKey}.json`),
            admissionBytes = readFileSync(admissionPath),
            source = JSON.parse(admissionBytes.toString("utf8")).payload,
            effect = JSON.parse(
              readFileSync(join(privateRoot, "effects", `${operationKey}.json`), "utf8"),
            ).payload,
            terminal = JSON.parse(
              readFileSync(
                join(privateRoot, "observations", `terminal-${operationKey}.json`),
                "utf8",
              ),
            ).payload;
          expect(effect).toMatchObject({
            identity: source.execution,
            outcome: "failed_without_effect",
            publication: "not_started",
            receipt: { kind: "not-started" },
          });
          expect(existsSync(join(host.infraDir, "data/.admin-target-control/locks/app-api"))).toBe(
            false,
          );
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(true);
          const leaseRef = JSON.parse(
              readFileSync(join(privateRoot, "execution-leases", `${operationKey}.json`), "utf8"),
            ),
            journalGuard = join(
              host.infraDir,
              "data/.admin-target-control/leases",
              leaseRef.leaseId,
              ".journal-writer",
            );
          expect(existsSync(journalGuard)).toBe(guard === "held");
          console.info(
            "actual native pre-effect kill",
            JSON.stringify({
              terminalPhase: terminal.phase,
              originalDeadline: source.execution.deadlineAt,
              firstTargetAbsent: true,
              dmStillHeld: true,
            }),
          );
          await first.killAfterFault();
          await request;
          await first();
          const next = await restartNativeStagedAgent();
          try {
            const observed = await createApiOpsClient()
              .lookup(operation, operationKey, {
                execution: { requestedDeadlineAt: deadlineAt },
                fingerprint: source.execution.fingerprint,
              })
              .catch((error: unknown) => {
                if (
                  guard === "held" &&
                  error instanceof Error &&
                  "errorClass" in error &&
                  error.errorClass === "recovery_required"
                )
                  return undefined;
                throw error;
              });
            if (guard === "held") {
              if (observed) expect(observed.errorClass).toBe("recovery_required");
              expect(existsSync(journalGuard)).toBe(true);
              expect(
                existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
              ).toBe(true);
              expect(readFileSync(admissionPath)).toEqual(admissionBytes);
              return;
            }
            expect(observed).toBeDefined();
            if (!observed) throw Error("Missing original pre-effect failure");
            console.info(
              "actual native pre-effect restored",
              JSON.stringify({
                state: observed.state,
                errorClass: observed.errorClass,
                originalDeadlinePreserved: observed.deadlineAt === source.execution.deadlineAt,
              }),
            );
            expect(observed).toMatchObject({
              state: "failed",
              errorClass: "configuration_prerequisite",
              operationId: source.execution.executionId,
              deadlineAt: source.execution.deadlineAt,
              fingerprint: source.execution.fingerprint,
            });
            expect(observed.updatedAt).toBe(new Date(terminal.terminalAt).toISOString());
            expect(readFileSync(admissionPath)).toEqual(admissionBytes);
            verifyRetainedArtifactTargetRootRelease(
              restoreAdmittedControlExecution(installation, source.execution),
            );
            const repaired = await api.inject({
              method: "POST",
              url: "/api/admin/services/bulk-action",
              headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
              payload: { action: "update", serviceIds: ["data-manager"] },
            });
            expect((await finished(repaired.json().jobId)).status).toBe("success");
          } finally {
            await next();
          }
        } finally {
          await first();
          await request;
        }
      },
      240000,
    );
    it("refuses an ordinary unrelated configuration write until explicit guarded DM repair and a NEW request", async () => {
      await fixture.db
        .insert(schema.serviceConfig)
        .values({ id: crypto.randomUUID(), serviceId: "motis", config: { MODE: "old" } });
      const { pullPath } = await canceledSuccessfulCoordinatorStage(),
        original = readFileSync(pullPath),
        before = services.currentConfigurationGeneration(host.infraDir),
        rows = await fixture.sql`SELECT id,config,xmin::text AS version FROM service_config`,
        request = {
          method: "POST",
          url: "/api/admin/services/motis/config" as const,
          headers: {
            "x-openmapx-local-admin": "task012-coordinator-local-admin",
            "idempotency-key": "task012-unrelated-config-after-staging",
          },
          payload: { config: { MODE: "new" } },
        } as const;
      const saved = await api.inject(request);
      expect(saved.statusCode, saved.body).toBe(409);
      expect(saved.json()).toEqual({
        error: "Apply or update Data Manager before changing instance configuration.",
      });
      expect(await fixture.sql`SELECT id,config,xmin::text AS version FROM service_config`).toEqual(
        rows,
      );
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(before);
      expect(readFileSync(pullPath).equals(original)).toBe(true);
      expect(readdirSync(join(host.queue, ".candidates"))).toEqual([]);
      expect(posts.get("serviceConfig.apply") ?? 0).toBe(0);
      expect(posts.get("stack.render") ?? 0).toBe(0);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(0);
      const next = await api.inject({
          method: "POST",
          url: "/api/admin/services/bulk-action",
          headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
          payload: { action: "update", serviceIds: ["data-manager"] },
        }),
        row = await finished(next.json().jobId);
      expect(row.status, row.error ?? "No public error").toBe("success");
      expect(posts.get("service.pull")).toBe(2);
      expect((await api.inject(request)).statusCode).toBe(409);
      const retried = await api.inject({
        ...request,
        headers: { ...request.headers, "idempotency-key": "task012-unrelated-config-after-repair" },
      });
      expect(retried.statusCode, retried.body).toBe(200);
      expect((await fixture.db.select().from(schema.serviceConfig))[0]?.config).toEqual({
        MODE: "new",
      });
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
    }, 180000);
    it.each([
      "container-id",
      "image-id",
      "reference",
      "old-compose-inode",
      "current-generation",
      "ambiguous-duplicate",
    ] as const)(
      "refuses staged provenance after actual %s drift",
      async (kind) => {
        await canceledSuccessfulCoordinatorStage();
        if (kind === "old-compose-inode") {
          const file = services.configurationGenerationComposeFile(
              host.infraDir,
              host.initial.revisionId,
            ),
            bytes = readFileSync(file);
          renameSync(file, `${file}.fixture-original`);
          writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
        } else if (kind === "current-generation") {
          const owned = await host.owned.inspectOwnedServices(new AbortController().signal);
          await services.commitConfigurationGeneration({
            infraDir: host.infraDir,
            services: host.loaded,
            input: {
              domain: "competing.example.test",
              selectedRoots: ["data-manager", "motis"],
              serviceConfigs: [],
              integrationConfigs: [],
              serviceSecrets: [],
            },
            ownedServiceGenerations: owned.map((service) => ({
              containerId: service.containerId,
              revisionIds: service.provenance.composeConfigFiles
                .map((file) => dirname(file).split("/").at(-1)!)
                .filter((id) => /^cfg1_[A-Za-z0-9_-]{43}$/.test(id)),
            })),
          });
        } else {
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
          const dm = rows.find(
            (row) => row.Labels["com.docker.compose.service"] === "data-manager",
          );
          if (kind === "container-id") dm.Id = "f".repeat(64);
          if (kind === "image-id") dm.Image = `sha256:${"f".repeat(64)}`;
          if (kind === "reference") dm.ConfigImage = "example/unrelated:1";
          if (kind === "ambiguous-duplicate") {
            const extra = structuredClone(dm);
            extra.Id = "f".repeat(64);
            extra.Image = pulledImageId;
            dm.Labels["com.docker.compose.project.config_files"] =
              "/tmp/untrusted-staged-compose.yml";
            rows.push(extra);
          }
          host.setRows(rows);
        }
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
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      expect((await finished(next.json().jobId)).status).toBe("success");
      expect(beforePull).toEqual({ starts: 1, helperUps: 1 });
      expect(posts.get("service.start")).toBe(1);
      expect(posts.get("service.pull")).toBe(2);
      expect(dm.settlementResponseStatuses).toEqual([200]);
    }, 180000);
    it("retains the LAST source for a currently stopped OLD container without reporting historical running state", async () => {
      const { pullPath } = await canceledSuccessfulCoordinatorStage();
      host.setServiceState("data-manager", "exited");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 96 * 3600000);
      try {
        for (let pass = 0; pass < 4; pass++)
          await reconcileControlRetention(installation, { maxFamilies: 64 });
        expect(existsSync(pullPath)).toBe(true);
        expect(
          (await host.owned.inspectOwnedServices(new AbortController().signal)).find(
            (service) => service.serviceId === "data-manager",
          )?.state,
        ).toBe("stopped");
      } finally {
        vi.useRealTimers();
      }
    }, 120000);
    it("vetoes lower-ranked source GC while actual Docker observation is unavailable, then rechecks its real successor", async () => {
      const first = await canceledSuccessfulCoordinatorStage(),
        second = await canceledSuccessfulCoordinatorStage();
      let failures = 0;
      const unavailable = async () => {
        failures++;
        host.setInventoryProcess(unavailable);
        throw Error("Named Docker inventory unavailable");
      };
      host.setInventoryProcess(unavailable);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 96 * 3600000);
      try {
        for (let pass = 0; pass < 4; pass++)
          await reconcileControlRetention(installation, { maxFamilies: 64 });
        expect(failures).toBeGreaterThan(0);
        expect(existsSync(first.pullPath)).toBe(true);
        expect(existsSync(second.pullPath)).toBe(true);
        host.setInventoryProcess(undefined);
        for (let pass = 0; pass < 8; pass++)
          await reconcileControlRetention(installation, { maxFamilies: 64 });
        expect(existsSync(first.pullPath)).toBe(false);
        expect(existsSync(second.pullPath)).toBe(true);
      } finally {
        host.setInventoryProcess(undefined);
        vi.useRealTimers();
      }
    }, 180000);
    it.each(["admission", "canonical", "effect"] as const)(
      "refuses a byte-identical %s source copied onto a different private indexed inode",
      async (kind) => {
        const { pullPath } = await canceledSuccessfulCoordinatorStage(),
          key = pullPath.split("/").at(-1)!,
          path =
            kind === "admission"
              ? pullPath
              : join(
                  host.infraDir,
                  "control-private/ops-agent",
                  kind === "canonical" ? "observations" : "effects",
                  kind === "canonical" ? `terminal-${key}` : key,
                ),
          original = readFileSync(path),
          backup = `${path}.fixture-original`;
        renameSync(path, backup);
        writeFileSync(path, original, { mode: 0o600, flag: "wx" });
        expect(
          (await host.owned.inspectOwnedServices(new AbortController().signal)).some(
            (s) => s.serviceId === "data-manager",
          ),
        ).toBe(false);
      },
      120000,
    );
    it("retires ONLY the lower-ranked authenticated F family while the actual G source remains pinned", async () => {
      const first = await canceledSuccessfulCoordinatorStage(),
        second = await canceledSuccessfulCoordinatorStage();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 96 * 3600000);
      try {
        for (let step = 0; step < 12; step++)
          await reconcileControlRetention(installation, { maxFamilies: 64 });
        expect(existsSync(first.pullPath)).toBe(false);
        expect(existsSync(second.pullPath)).toBe(true);
        expect(
          (await host.owned.inspectOwnedServices(new AbortController().signal)).some(
            (s) => s.serviceId === "data-manager",
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    }, 180000);
    it("authenticates signed F-to-G retirement and NATIVE restart after first actual private unlink", async () => {
      const first = await canceledSuccessfulCoordinatorStage(),
        second = await canceledSuccessfulCoordinatorStage();
      const raw = JSON.parse(readFileSync(first.pullPath, "utf8")),
        originHash = controlDigest(raw.payload.origin),
        privateRoot = join(host.infraDir, "control-private/ops-agent"),
        location = JSON.parse(
          readFileSync(join(privateRoot, "retention-locations", `${originHash}.json`), "utf8"),
        ),
        slot = join(privateRoot, "retention-families", location.name),
        io = { signal: new AbortController().signal, timeout: 15000, maxBuffer: 1024 * 1024 };
      const rows = (
        await host.execFile("docker", ["container", "inspect", "--format", "owned-snapshot"], io)
      ).stdout
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row));
      const images: Record<string, string> = {};
      for (const row of rows)
        images[row.ConfigImage] = (
          await host.execFile(
            "docker",
            ["image", "inspect", "--format", "{{.Id}}", row.ConfigImage],
            io,
          )
        ).stdout.trim();
      const directory = process.env.OPENMAPX_TEST_EVIDENCE_DIR ?? host.cleanupRoot;
      const packetsDirectory = join(directory, "staged-retirement-signed-packets");
      mkdirSync(packetsDirectory, { recursive: true });
      const evidenceFile = join(packetsDirectory, `${raw.payload.execution.operationKey}.json`);
      await agent.close();
      const base = {
        root: host.root,
        infraDir: host.infraDir,
        stack: host.stack,
        queue: host.queue,
        token: host.token,
        serviceIds: host.loaded.map((service) => service.manifest.id),
        now: Date.now() + 96 * 3600000,
        rows,
        images,
        firstPullPath: first.pullPath,
        secondPullPath: second.pullPath,
        firstSlot: slot,
        evidenceFile,
      };
      const start = (mode: "fault" | "resume") => {
        const argv = [
          "--import",
          createRequire(import.meta.url).resolve("tsx/esm"),
          fileURLToPath(
            new URL(
              "../../../../ops-agent/src/test-fixtures/staged-coordinator-retention-process.mjs",
              import.meta.url,
            ),
          ),
        ];
        console.info("actual native staged GC argv", JSON.stringify([process.execPath, ...argv]));
        const child = spawn(process.execPath, argv, {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "",
          stderr = "";
        const boundary = Promise.withResolvers<Record<string, unknown>>();
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          for (const line of output.split("\n")) {
            try {
              const value = JSON.parse(line);
              if (value.boundary) boundary.resolve(value);
            } catch {}
          }
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
          if (stderr.length > 1024 * 1024) child.kill("SIGKILL");
        });
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) =>
            child.once("exit", (code, signal) => {
              if (!output.includes('"boundary"'))
                boundary.reject(Error(`Native staged GC exited ${code}: ${stderr.slice(-2500)}`));
              resolve({ code, signal });
            }),
        );
        child.stdin.end(JSON.stringify({ ...base, mode }));
        return { child, boundary: boundary.promise, exited };
      };
      // An active source with a valid successor still cannot retire from
      // missing/corrupt original signed bytes. Restore only the exact fixture
      // bytes after proving refusal; production supplies no corruption bypass.
      const originalAdmission = readFileSync(first.pullPath),
        brokenAdmission = JSON.parse(originalAdmission.toString());
      brokenAdmission.signature =
        (brokenAdmission.signature[0] === "A" ? "B" : "A") + brokenAdmission.signature.slice(1);
      writeFileSync(first.pullPath, JSON.stringify(brokenAdmission));
      try {
        const blocked = start("resume"),
          observed = await blocked.boundary;
        expect(await blocked.exited).toEqual({ code: 0, signal: null });
        expect(observed).toMatchObject({
          Fpresent: true,
          Gpresent: true,
          FslotPresent: true,
          ordinaryOwnedDM: true,
        });
        expect(observed.journalKeys as string[]).toContain(raw.payload.execution.operationKey);
      } finally {
        writeFileSync(first.pullPath, originalAdmission);
      }
      const crashed = start("fault");
      try {
        const actual = await crashed.boundary;
        expect(actual).toMatchObject({
          boundary: "actual-first-F-private-unlink",
          faulted: true,
          Fpresent: false,
          Gpresent: true,
          FslotPresent: true,
        });
        expect(actual.journalKeys as string[]).toContain(raw.payload.execution.operationKey);
        crashed.child.kill("SIGKILL");
        expect((await crashed.exited).signal).toBe("SIGKILL");
        const packets = JSON.parse(readFileSync(evidenceFile, "utf8")),
          before = packets.candidate.payload.stagedCoordinatorDependency,
          after = packets.progress.stagedCoordinatorRevalidation;
        expect(packets.publicKey).toBe(installation.publicKey);
        verifyControl(
          packets.publicKey,
          stagedCoordinatorRetirementDomain,
          before,
          stagedCoordinatorRetirementPayloadSchema,
        );
        verifyControl(
          packets.publicKey,
          stagedCoordinatorRetirementDomain,
          after,
          stagedCoordinatorRetirementPayloadSchema,
        );
        expect(before.payload.condition).toBe("higher-ranked-successor");
        expect(after.payload.condition).toBe("higher-ranked-successor");
        expect(Buffer.byteLength(JSON.stringify(before))).toBeLessThanOrEqual(4096);
        expect(Buffer.byteLength(JSON.stringify(after))).toBeLessThanOrEqual(4096);
        expect(packets.manifest.payload.stagedCoordinatorDependencyDigest).toBe(
          controlDigest(before),
        );
        expect(packets.decision.payload.stagedCoordinatorRevalidationDigest).toBe(
          controlDigest(after),
        );
        expect(after.payload.manifestDigest).toBe(controlDigest(packets.manifest.payload));
        expect(after.payload.checkNonce).not.toBe(before.payload.checkNonce);
        expect(() =>
          controlRetentionPreparationState({
            ...after.payload,
            mode: "committed-cleanup",
          } as never),
        ).toThrow();
        expect(() =>
          recordStagedCoordinatorRetentionCheck({ ...after.payload } as never, after),
        ).toThrow();
        const proofPath = join(slot, "proof.json"),
          originalProof = readFileSync(proofPath),
          brokenProof = JSON.parse(originalProof.toString());
        brokenProof.signature =
          (brokenProof.signature[0] === "A" ? "B" : "A") + brokenProof.signature.slice(1);
        writeFileSync(proofPath, JSON.stringify(brokenProof));
        try {
          const blocked = start("resume"),
            observed = await blocked.boundary;
          expect(await blocked.exited).toEqual({ code: 0, signal: null });
          expect(observed).toMatchObject({
            Fpresent: false,
            Gpresent: true,
            FslotPresent: true,
            ordinaryOwnedDM: true,
          });
          expect(observed.journalKeys as string[]).toContain(raw.payload.execution.operationKey);
        } finally {
          writeFileSync(proofPath, originalProof);
        }
        const replacement = start("resume"),
          observed = await replacement.boundary;
        expect(await replacement.exited).toEqual({ code: 0, signal: null });
        expect(observed).toMatchObject({
          Fpresent: false,
          Gpresent: true,
          FslotPresent: false,
          ordinaryOwnedDM: true,
        });
        expect(observed.journalKeys as string[]).not.toContain(raw.payload.execution.operationKey);
      } finally {
        crashed.child.kill("SIGKILL");
        await crashed.exited;
      }
    }, 180000);
    it("guards the actual existing coordinator Apply entry even with empty links", async () => {
      const response = await api.inject({
        method: "POST",
        url: "/api/admin/services/data-manager/action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
      expect(posts.get("configurationMaintenance.decide")).toBe(1);
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
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
      expect(posts.get("stack.render")).toBe(1);
      expect(posts.get("service.start") ?? 0).toBe(0);
      const checkpoint = row.result as {
          _configurationMaintenance: { receipt: { binding: { maintenanceId: string } } };
        },
        owner = JSON.parse(
          readFileSync(
            join(
              host.infraDir,
              "control-private",
              "ops-agent",
              "configuration-maintenance",
              `${checkpoint._configurationMaintenance.receipt.binding.maintenanceId}.json`,
            ),
            "utf8",
          ),
        ).payload;
      expect(owner.coordinatorPull.payload.imageId).toBe(pulledImageId);
      expect(owner.coordinatorPull.payload.version).toBe(2);
      expect(owner.receipt.state).toBe("settled");
      expect(owner.final.ownerFinal.payload.outcome).toBe("applied");
      expect(owner.apiControls.settle.result.state).toBe("settled");
      expect(owner.apiControls.settle.receiptDelivery).not.toBeNull();
      expect(dm.settlePosts).toBe(1);
      expect(dm.settlementSqlIo).toEqual({ commits: 1, updates: 1 });
      expect(host.calls.filter((a) => a.includes("--force-recreate"))).toHaveLength(1);
      const actual = (await host.owned.inspectOwnedServices(new AbortController().signal)).find(
        (s) => s.serviceId === "data-manager",
      );
      expect(actual?.provenance.imageId).toBe(pulledImageId);
      const baseline = owner.coordinatorPull.payload.baseline;
      expect(baseline.policyRevision).not.toBe(baseline.configurationAuthorityRevision);
      expect(baseline.container).toEqual(
        owner.originalContainers.find((s: { serviceId: string }) => s.serviceId === "data-manager"),
      );
      expect(Buffer.byteLength(JSON.stringify(baseline))).toBeLessThanOrEqual(3072);
      expect(Buffer.byteLength(JSON.stringify(owner.coordinatorPull))).toBeLessThanOrEqual(8192);
      expect(
        owner.originalContainers.find((s: { serviceId: string }) => s.serviceId === "data-manager")
          .provenance.imageId,
      ).not.toBe(pulledImageId);
      expect(owner.plan.coordinatorImage.imageId).toBe(pulledImageId);
      expect(originalPull).toBeDefined();
      expect(owner.coordinatorPull.payload.pull.operationKey).toBe(originalPull!.operationKey);
      expect(owner.coordinatorPull.payload.pull.deadlineAt).toBeLessThan(
        originalPull!.requestedDeadlineAt,
      );
      expect(Object.hasOwn(originalPull!, "executionId")).toBe(false);
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
      { action: "update", point: "family retirement" },
      { action: "apply", point: "candidate unlink" },
      { action: "update", point: "candidate unlink" },
      { action: "update", point: "mixed pull" },
      { action: "update", point: "canceled pull" },
      { action: "update", point: "candidate write" },
      { action: "update", point: "orphan candidate" },
    ] as const)(
      "reclaims native coordinator $action after original $point without another admission or save",
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
        if (
          !pullBoundary &&
          point !== "candidate unlink" &&
          point !== "candidate write" &&
          point !== "orphan candidate"
        )
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
          ...(point === "candidate unlink"
            ? { filesystemFault: "after-retirement-unlink" }
            : point === "candidate write"
              ? { filesystemFault: "before-candidate-write" }
              : point === "orphan candidate"
                ? { filesystemFault: "after-candidate-sync" }
                : {}),
        });
        try {
          const id = await first.jobId;
          if (point === "candidate write" || point === "orphan candidate") {
            const marker = join(
                host.root,
                point === "candidate write"
                  ? "coordinator-candidate-write-paused"
                  : "coordinator-candidate-sync-paused",
              ),
              until = Date.now() + 45000;
            while (!existsSync(marker)) {
              if (Date.now() > until) throw Error("Actual candidate write boundary missing");
              await delay(10);
            }
            const [original] = await fixture.db
                .select()
                .from(schema.adminJob)
                .where(eq(schema.adminJob.id, id)),
              before = original!.result as Record<string, unknown>;
            expect(before._configurationCandidate).toBeUndefined();
            expect(
              Object.values(
                (before.opsProjection as { operations: Record<string, { phase: string }> })
                  .operations,
              ).map((value) => value.phase),
            ).toEqual(["prepared"]);
            expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(
              point === "orphan candidate" ? 1 : 0,
            );
            first.child.kill("SIGKILL");
            expect((await first.exited).signal).toBe("SIGKILL");
            const lease = Date.parse(before._observationLeaseUntil as string);
            while (Date.now() <= lease + 100) await delay(Math.min(1000, lease + 101 - Date.now()));
            const replacement = start({ action: "reconcile", jobId: id });
            await replacement.exited;
            const [row] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, id));
            expect(row!.status).toBe("failed");
            expect(
              Object.values(
                (
                  row!.result as {
                    opsProjection: { operations: Record<string, { phase: string }> };
                  }
                ).opsProjection.operations,
              ).map((value) => value.phase),
            ).toEqual(["unissued"]);
            expect(posts.get("service.pull") ?? 0).toBe(0);
            expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
            expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(0);
            const failed = JSON.stringify(row!.result);
            const next = await api.inject({
              method: "POST",
              url: "/api/admin/services/data-manager/action",
              headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
              payload: { action: "apply" },
            });
            expect((await finished(next.json().jobId)).status).toBe("success");
            const [unchanged] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, id));
            expect(JSON.stringify(unchanged!.result)).toBe(failed);
            return;
          }
          let retainedBytes: Buffer | undefined;
          const unlinkBoundary = async () => {
            const marker = join(host.root, "coordinator-retirement-unlinked"),
              until = Date.now() + 150000;
            while (!existsSync(marker)) {
              const [observed] = await fixture.db
                  .select()
                  .from(schema.adminJob)
                  .where(eq(schema.adminJob.id, id)),
                candidate = (
                  observed?.result as
                    | { _configurationCandidate?: { sealedOperationKey?: string } }
                    | undefined
                )?._configurationCandidate;
              if (candidate?.sealedOperationKey) {
                const path = join(
                  host.queue,
                  ".candidates",
                  `${candidate.sealedOperationKey}.json`,
                );
                if (existsSync(path)) retainedBytes = readFileSync(path);
              }
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
            prior = before!.result as Record<string, unknown>,
            candidate = prior._configurationCandidate as Record<string, unknown>,
            path = join(host.queue, ".candidates", `${candidate.sealedOperationKey}.json`),
            bytes = point === "candidate unlink" ? retainedBytes! : readFileSync(path),
            decision = JSON.stringify(prior._configurationMaintenanceDecision),
            inspected = inspectPreparedConfigurationRecord(bytes, host.token).record,
            originalNormal =
              inspected.privateCoordinatorLifecycle?.action === "update"
                ? readFileSync(
                    join(
                      host.infraDir,
                      "control-private/ops-agent/executions",
                      `${inspected.privateCoordinatorLifecycle.pull.operationKey}.json`,
                    ),
                  )
                : undefined;
          expect(candidate.phase).toBe(
            point === "candidate unlink" ? "settled" : !pullBoundary ? "saved" : "prepared",
          );
          if (point === "candidate unlink") {
            expect(bytes).toBeDefined();
            expect(existsSync(path)).toBe(false);
            expect(candidate.retirement).toMatchObject({ version: 1, integrationIds: [] });
            expect(posts.get("configurationMaintenance.settle")).toBe(1);
          }
          expect(await fixture.db.select().from(schema.serviceConfig)).toHaveLength(0);
          expect(posts.get("configurationMaintenance.decide") ?? 0).toBe(!pullBoundary ? 1 : 0);
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
          if (point === "family retirement") {
            if (!originalNormal || inspected.privateCoordinatorLifecycle?.action !== "update")
              throw Error("Actual original pull source required");
            const normalPath = join(
              host.infraDir,
              "control-private/ops-agent/executions",
              `${inspected.privateCoordinatorLifecycle.pull.operationKey}.json`,
            );
            const maintenanceId = (
              prior._configurationMaintenance as { receipt: { binding: { maintenanceId: string } } }
            ).receipt.binding.maintenanceId;
            const ownerPath = join(
                host.infraDir,
                "control-private/ops-agent/configuration-maintenance",
                `${maintenanceId}.json`,
              ),
              originalOwner = readFileSync(ownerPath),
              owner = JSON.parse(originalOwner.toString()).payload,
              authority = restoreAdmittedControlExecution(installation, owner.plan.prepare),
              copied = JSON.stringify(owner.coordinatorPull);
            expect(
              Buffer.byteLength(JSON.stringify(JSON.parse(originalNormal.toString()))),
            ).toBeLessThanOrEqual(65536);
            expect(
              owner.coordinatorPull.payload.baselineAdmissionDigest ===
                controlDigest(JSON.parse(originalNormal.toString())),
            ).toBe(true);
            const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 96 * 3600000);
            try {
              let retired = 0;
              for (let round = 0; round < 24 && existsSync(normalPath); round++)
                retired += (await reconcileControlRetention(installation, { maxFamilies: 64 }))
                  .retired;
              expect(retired).toBeGreaterThan(0);
              expect(existsSync(normalPath)).toBe(false);
              expect(existsSync(ownerPath)).toBe(true);
              const proof = ownedCoordinatorPullBaseline(authority),
                old = await inspectOriginalCoordinatorServices(
                  host.owned,
                  proof,
                  new AbortController().signal,
                );
              expect(
                old.find((value) => value.serviceId === "data-manager")?.provenance.imageId,
              ).toBe(`sha256:${"b".repeat(64)}`);
              expect(
                (await host.owned.inspectOwnedServices(new AbortController().signal)).some(
                  (value) => value.serviceId === "data-manager",
                ),
              ).toBe(false);
              expect(
                JSON.stringify(JSON.parse(readFileSync(ownerPath, "utf8")).payload.coordinatorPull),
              ).toBe(copied);
              expect(() => assertControlExecutionForward(authority)).toThrow();
              const corrupt = Buffer.from(originalOwner);
              corrupt[12] = corrupt[12] === 120 ? 121 : 120;
              try {
                writeFileSync(ownerPath, corrupt);
                expect(() => ownedCoordinatorPullBaseline(authority)).toThrow();
              } finally {
                writeFileSync(ownerPath, originalOwner);
              }
              expect(() => ownedCoordinatorPullBaseline(authority)).not.toThrow();
              expect(posts.get("configurationMaintenance.prepare")).toBe(1);
              expect(posts.get("service.pull")).toBe(1);
              expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(
                0,
              );
            } finally {
              clock.mockRestore();
            }
            return;
          }
          const [retained] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, id)),
            lease = Date.parse(
              (retained!.result as Record<string, unknown>)._observationLeaseUntil as string,
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
          expect(exit.code).toBe(0);
          const row = await finished(id),
            result = row.result as Record<string, unknown>;
          expect(row.status).toBe("success");
          expect((result._execution as { version: number }).version).toBe(2);
          if (point === "decision")
            expect(JSON.stringify(result._configurationMaintenanceDecision)).toBe(decision);
          if (originalNormal && inspected.privateCoordinatorLifecycle?.action === "update") {
            expect(
              readFileSync(
                join(
                  host.infraDir,
                  "control-private/ops-agent/executions",
                  `${inspected.privateCoordinatorLifecycle.pull.operationKey}.json`,
                ),
              ).equals(originalNormal),
            ).toBe(true);
            expect(posts.get("service.pull")).toBe(1);
          }
          expect(posts.get("configurationMaintenance.prepare")).toBe(1);
          expect(posts.get("configurationMaintenance.decide")).toBe(1);
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
    it("denies a structural copy of the real production pull claim before signed admission or image staging", async () => {
      copyPullClaim = true;
      const observed = new Promise<number>((resolve) => {
        observePullReply = resolve;
      });
      const response = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      expect(response.statusCode).toBe(200);
      const observedStatus = await observed;
      const id = (response.json() as { jobId: string }).jobId;
      await finished(id);
      expect(observedStatus).toBe(403);
      expect(host.calls.filter((args) => args[0] === "image" && args[1] === "pull")).toHaveLength(
        0,
      );
      expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(0);
    }, 60000);
    it.each(coordinatorReferenceCases.slice(0, 3).map((value) => value.name))(
      "refuses a %s before actual image staging",
      async () => {
        const reply = await api.inject({
          method: "POST",
          url: "/api/admin/services/bulk-action",
          headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
          payload: { action: "update", serviceIds: ["data-manager"] },
        });
        expect(reply.statusCode).toBe(200);
        const row = await finished(reply.json().jobId);
        expect(row.status).toBe("failed");
        expect(host.calls.filter((args) => args[0] === "image" && args[1] === "pull")).toHaveLength(
          0,
        );
        expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
        expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(0);
      },
      180000,
    );
    it("allows distinct sibling coordinator tags currently sharing the OLD image", async () => {
      const reply = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      const row = await finished(reply.json().jobId);
      expect(row.status).toBe("success");
      expect(posts.get("service.pull")).toBe(1);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
      const snapshots = await host.owned.inspectOwnedServices(new AbortController().signal);
      expect(snapshots.find((s) => s.serviceId === "motis")?.provenance.imageId).toBe(
        `sha256:${"b".repeat(64)}`,
      );
      expect(snapshots.find((s) => s.serviceId === "data-manager")?.provenance.imageId).toBe(
        pulledImageId,
      );
      expect(dm.settlementSqlIo).toEqual({ updates: 1, commits: 1 });
    }, 180000);
    it.each([
      "generic resolver",
      "policy-only",
      "missing raw revision",
      "raw suffix drift",
      "consumed capture",
    ] as const)(
      "rejects %s at the actual candidate pull server before first signed admission",
      async (mode) => {
        claimCase = mode;
        const observed = new Promise<number>((resolve) => {
          observePullReply = resolve;
        });
        const reply = await api.inject({
          method: "POST",
          url: "/api/admin/services/bulk-action",
          headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
          payload: { action: "update", serviceIds: ["data-manager"] },
        });
        expect(reply.statusCode).toBe(200);
        const status = await observed;
        await finished(reply.json().jobId);
        expect(status).toBe(403);
        expect(host.calls.filter((args) => args[0] === "image" && args[1] === "pull")).toHaveLength(
          0,
        );
        expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
        expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(0);
        const executions = join(host.infraDir, "control-private/ops-agent/executions");
        expect(
          (existsSync(executions) ? readdirSync(executions) : []).filter(
            (name) =>
              JSON.parse(readFileSync(join(executions, name), "utf8")).payload?.kind ===
              "service.pull",
          ),
        ).toHaveLength(0);
      },
      60000,
    );
    it("rejects actual canonical Compose provenance exceeding the 3072-byte baseline before first admission", async () => {
      const owned = await host.owned.inspectOwnedServices(new AbortController().signal);
      const dmOwned = owned.find((value) => value.serviceId === "data-manager");
      expect(dmOwned?.state).toBe("running");
      expect(dmOwned?.provenance.composeConfigFiles).toHaveLength(2);
      const observed = new Promise<number>((resolve) => {
        observePullReply = resolve;
      });
      const reply = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      const status = await observed;
      await finished(reply.json().jobId);
      expect(status).toBe(403);
      expect(host.calls.filter((args) => args[0] === "image" && args[1] === "pull")).toHaveLength(
        0,
      );
      expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
      const executions = join(host.infraDir, "control-private/ops-agent/executions");
      expect(
        (existsSync(executions) ? readdirSync(executions) : []).filter(
          (name) =>
            JSON.parse(readFileSync(join(executions, name), "utf8")).payload?.kind ===
            "service.pull",
        ),
      ).toHaveLength(0);
    }, 60000);
    it("starts an initially stopped coordinator before pull using only its clamped original old-revision helper", async () => {
      expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
      await expect(fetch(dm.baseUrl + "/health")).rejects.toThrow();
      const reply = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
      expect(dm.settlementSqlIo).toEqual({ updates: 1, commits: 1 });
    }, 180000);
    it("closes a prepared pull locally after whole-candidate coordinator refusal without inventing an admission", async () => {
      services.writeServiceSelectionFile(host.infraDir, ["motis"]);
      const reply = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
      const result = row!.result as {
        opsProjection: {
          operations: Record<
            string,
            { phase: string; terminal: boolean; operationId?: string; receiptDelivery?: unknown }
          >;
        };
      };
      const entries = Object.values(result.opsProjection.operations);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.phase).toBe("unissued");
      expect(entries[0]!.terminal).toBe(true);
      expect(entries[0]!.operationId).toBeUndefined();
      expect(entries[0]!.receiptDelivery).toBeUndefined();
      expect(posts.get("service.pull") ?? 0).toBe(0);
      expect(posts.get("service.start") ?? 0).toBe(0);
      expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
      expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(0);
      expect(await fixture.db.select().from(schema.serviceConfig)).toHaveLength(0);
      const original = JSON.stringify(row!.result);
      services.writeServiceSelectionFile(host.infraDir, ["data-manager", "motis"]);
      const next = await api.inject({
        method: "POST",
        url: "/api/admin/services/data-manager/action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
        payload: { action: "update", serviceIds: ["data-manager"] },
      });
      const row = await finished(reply.json().jobId);
      expect(refusedDecisionWrites).toBe(1);
      expect(issuedKnownRollbacks).toBeGreaterThan(0);
      expect(row.status).toBe("failed");
      const result = row.result as {
        _configurationMaintenance: { receipt: { binding: { maintenanceId: string } } };
        _configurationMaintenanceRollback: { disposition: string };
      };
      expect(result._configurationMaintenanceRollback.disposition).toBe("known_rolled_back");
      const owner = JSON.parse(
        readFileSync(
          join(
            host.infraDir,
            "control-private/ops-agent/configuration-maintenance",
            `${result._configurationMaintenance.receipt.binding.maintenanceId}.json`,
          ),
          "utf8",
        ),
      ).payload;
      expect(owner.receipt.state).toBe("settled");
      expect(owner.final.ownerFinal.payload.outcome).toBe("unused");
      expect(owner.receipt.decision.decision).toBe("abandon");
      expect(owner.receipt.generation).toBe("not_started");
      expect(posts.get("service.pull")).toBe(1);
      expect(posts.get("stack.render") ?? 0).toBe(0);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(0);
      expect(posts.get("configurationMaintenance.prepare")).toBe(1);
      expect(posts.get("configurationMaintenance.settle")).toBe(1);
      expect(dm.settlementSqlIo).toEqual({ updates: 1, commits: 1 });
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      const original = await inspectOriginalCoordinatorServices(
        host.owned,
        ownedCoordinatorPullBaseline(
          restoreAdmittedControlExecution(installation, owner.plan.prepare),
        ),
        new AbortController().signal,
      );
      expect(original.find((s) => s.serviceId === "data-manager")?.provenance.imageId).toBe(
        `sha256:${"b".repeat(64)}`,
      );
      expect(
        (await host.owned.inspectOwnedServices(new AbortController().signal)).some(
          (s) => s.serviceId === "data-manager",
        ),
      ).toBe(false);
      expect(await fixture.db.select().from(schema.serviceConfig)).toHaveLength(0);
      expect(row.error ?? "").not.toContain('update "admin_job"');
      expect(row.error ?? "").not.toContain(host.root);
    }, 180000);
    it("refuses a valid full future owner budget before image staging or lifecycle", async () => {
      expect(host.loaded.find((s) => s.manifest.id === "motis")?.manifest.consumes).toHaveLength(
        256,
      );
      const reply = await api.inject({
        method: "POST",
        url: "/api/admin/services/bulk-action",
        headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
        if (Date.now() > until) throw Error("Actual owner capacity refusal not observable");
        await delay(10);
      }
      const observed = row!.result as {
        observation?: { state?: string; reason?: string };
        opsProjection?: {
          operations?: Record<
            string,
            { kind: string; phase: string; terminal: boolean; errorClass?: string }
          >;
        };
        _configurationCandidate?: { phase?: string };
      };
      console.info(
        "actual prelude budget diagnostic",
        JSON.stringify({
          jobState: row!.status,
          observation: observed.observation,
          candidatePhase: observed._configurationCandidate?.phase,
          posts: [...posts],
          operations: Object.values(observed.opsProjection?.operations ?? {}).map((value) => ({
            kind: value.kind,
            phase: value.phase,
            terminal: value.terminal,
            errorClass: value.errorClass,
          })),
        }),
      );
      expect(posts.get("service.pull") ?? 0).toBe(0);
      expect(host.calls.filter((args) => args[0] === "image" && args[1] === "pull")).toHaveLength(
        0,
      );
      expect(row!.status).toBe("failed");
      expect(posts.get("service.start") ?? 0).toBe(0);
      expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(0);
      expect(dm.preparePosts).toBe(0);
      expect(await fixture.db.select().from(schema.serviceConfig)).toHaveLength(0);
      expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(0);
    }, 60000);
    it("preserves actual first-delivery CAS against stale prepared and forged unissued generic checkpoints", async () => {
      const reached = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      pullAdmissionReplyGate = { reached: () => reached.resolve(), release: release.promise };
      try {
        const response = await api.inject({
            method: "POST",
            url: "/api/admin/services/bulk-action",
            headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
            payload: { action: "update", serviceIds: ["data-manager"] },
          }),
          id = response.json().jobId;
        await reached.promise;
        const [row] = await fixture.db
            .select()
            .from(schema.adminJob)
            .where(eq(schema.adminJob.id, id)),
          original = row!.result as Record<string, unknown>,
          stale = structuredClone(original);
        type Entry = {
          phase: string;
          terminal: boolean;
          operation: { candidateId: string };
          nonissuance?: unknown;
        };
        const entries = (stale.opsProjection as { operations: Record<string, Entry> }).operations,
          key = Object.keys(entries)[0]!,
          entry = entries[key]!;
        expect(entry.phase).toBe("admitting");
        entry.phase = "prepared";
        const { checkpointOwnedAdminJob } = await import("../admin-job-checkpoint"),
          execution = original._execution as { owner: string; version: number };
        const merged = await checkpointOwnedAdminJob(
          id,
          execution,
          stale,
          undefined,
          undefined,
          undefined,
          original,
        );
        expect(
          (merged.opsProjection as { operations: Record<string, Entry> }).operations[key]!.phase,
        ).toBe("admitting");
        const forged = structuredClone(original),
          fake = (forged.opsProjection as { operations: Record<string, Entry> }).operations[key]!;
        fake.phase = "unissued";
        fake.terminal = true;
        fake.nonissuance = {
          version: 1,
          candidateId: fake.operation.candidateId,
          checkedOwnerVersion: execution.version,
          checkedAt: Date.now(),
        };
        await expect(
          checkpointOwnedAdminJob(id, execution, forged, undefined, undefined, undefined, original),
        ).rejects.toThrow();
        const [unchanged] = await fixture.db
          .select()
          .from(schema.adminJob)
          .where(eq(schema.adminJob.id, id));
        expect(JSON.stringify(unchanged!.result)).toBe(JSON.stringify(merged));
        pullAdmissionReplyGate = undefined;
        release.resolve();
        expect((await finished(id)).status).toBe("success");
        expect(posts.get("service.pull")).toBe(1);
      } finally {
        pullAdmissionReplyGate = undefined;
        release.resolve();
      }
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
            headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
              row!.result as {
                opsProjection: {
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
            ).opsProjection.operations,
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
          expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(0);
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
                  headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
            headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
          headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
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
      expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(0);
      expect(posts.get("service.update")).toBe(1);
      expect(posts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
    }, 240000);
    it("closes three-target cancellation after an acknowledged ordinary prefix and successful coordinator staging", async () => {
      const { id } = await canceledSuccessfulCoordinatorStage(undefined, [
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
          headers: { "x-openmapx-local-admin": "task012-coordinator-local-admin" },
          payload: { action: "update", serviceIds },
        });
        expect(reply.statusCode).toBe(200);
        const id = reply.json().jobId,
          until = Date.now() + 180000;
        let diagnostic = false;
        let row: typeof schema.adminJob.$inferSelect | undefined;
        for (;;) {
          [row] = await fixture.db.select().from(schema.adminJob).where(eq(schema.adminJob.id, id));
          const value = row?.result as
            | {
                observation?: { state?: string; reason?: string };
                opsProjection?: {
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
                _configurationCandidate?: { phase?: string };
                _configurationMaintenance?: { phase?: string };
              }
            | undefined;
          if (
            !diagnostic &&
            (Date.now() >= until - 160000 || value?.observation?.state === "unknown")
          ) {
            diagnostic = true;
            const { readProjection } = await import("../admin-job-projection");
            try {
              readProjection(value);
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
                candidatePhase: value?._configurationCandidate?.phase,
                maintenancePhase: value?._configurationMaintenance?.phase,
                arrivals: [...arrivals],
                posts: [...posts],
                operations: Object.values(value?.opsProjection?.operations ?? {}).map((op) => ({
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
        expect(posts.get("configurationMaintenance.decide")).toBe(1);
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
