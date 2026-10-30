/** Actual API/SDK -> production registry/agent -> real DM HTTP/SQL guard and
 * separate native helper. Only the session provider and Docker executable I/O
 * are substituted; image/container replacement acceptance remains separate. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiClient } from "@openmapx/core";
import {
  applyAdminPlatformConfiguration,
  previewAdminPlatformConfiguration,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import {
  closeControlInstallation,
  controlDigest,
  openControlInstallation,
  openFixedChildInstallation,
  readConfigurationHandoffSpawnIntent,
  reconcileControlRetention,
  restoreAdmittedControlExecution,
  verifyRetainedArtifactTargetRootRelease,
  verifyRetainedArtifactTargetSettlement,
} from "@openmapx/core/build-artifacts";
import { configurationMaintenanceSettleRequestDigest } from "@openmapx/core/ops";
import { repoPaths, services } from "@openmapx/core/server";
import { eq, sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownedDataManager } from "../../../../ops-agent/src/__fixtures__/owned-data-manager";
import { ownedServiceHost } from "../../../../ops-agent/src/__fixtures__/owned-service-host";
import { runContainedProcess } from "../../../../ops-agent/src/docker-runtime";
import { openOpsJobJournal } from "../../../../ops-agent/src/journal";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import * as schema from "../../db/schema";
import { mockAdminSession } from "../../test/auth";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";
import type { JobContext } from "../job-runner";

const state = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
  services: [] as services.LoadedService[],
  registry: null as InstanceType<typeof services.ServiceRegistry> | null,
  session: null as ReturnType<typeof mockAdminSession> | null,
}));
vi.mock("../../auth", () => ({ auth: { api: { getSession: async () => state.session } } }));
vi.mock("../../db", () => ({
  get db() {
    return state.fixture.db;
  },
  get sql() {
    return state.fixture.sql;
  },
}));
vi.mock("../../integration-host", () => ({ getAllIntegrations: () => [] }));
vi.mock("../service-registry", () => ({
  getServiceRegistry: () => state.registry ?? { list: () => state.services },
}));
const writer = await import("../administrative-configuration-writer-owner");
const { withConfigurationCommitParticipant } = await import("../configuration-commit-participant");
const { preparePlatformConfigurationChange, platformConfigurationParticipation } = await import(
  "../platform-configuration-participant"
);
const prospective = await import("../prospective-configuration");
const { createApiOpsClient, createDurableOpsKey, executeAndWait } = await import("../ops-client");
const { retainPlatformPreview } = await import("../platform-preview-store");
const { loadAuthPolicy } = await import("../../account/auth-policy");
const { checkpointOwnedAdminJob } = await import("../admin-job-checkpoint");

/** Only the Docker executable is replaced. The separate Node process runs the
 * actual production entrypoint, fixed grant/adoption, source and effect code. */
async function nativeHelper(
  host: Awaited<ReturnType<typeof ownedServiceHost>>,
  environment: Record<string, string>,
  options: {
    bundled?: boolean;
    fault?: "before-effect" | "after-effect";
    failureStage?: "adoption" | "application";
    kill?: { when: Promise<void>; release(): void };
  } = {},
) {
  const { bundled = false, fault } = options;
  if (bundled)
    await runContainedProcess(
      process.execPath,
      [
        fileURLToPath(new URL("../../../../../scripts/build-runtime-bundles.mjs", import.meta.url)),
        "ops-agent",
      ],
      { signal: AbortSignal.timeout(60000), timeout: 60000, maxBuffer: 1024 * 1024 },
    );
  const bridge = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  bridge.post("/docker", async (request, reply) => {
    const args = (request.body as { args: unknown }).args;
    if (
      !Array.isArray(args) ||
      args.length > 128 ||
      args.some((value) => typeof value !== "string")
    )
      return reply.code(400).send({ error: "Invalid Docker IO" });
    try {
      return await host.execFile("docker", args, {
        signal: AbortSignal.timeout(30000),
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      return reply.code(502).send({ error: "Named Docker IO failed" });
    }
  });
  const url = await bridge.listen({ host: "127.0.0.1", port: 0 });
  try {
    const child = spawn(
      process.execPath,
      [
        ...(bundled ? [] : ["--import", createRequire(import.meta.url).resolve("tsx/esm")]),
        "--import",
        fileURLToPath(
          new URL(
            "../../../../ops-agent/src/test-fixtures/configuration-helper-docker-preload.mjs",
            import.meta.url,
          ),
        ),
        fileURLToPath(
          new URL(
            bundled
              ? "../../../../ops-agent/dist/configuration-handoff-main.mjs"
              : "../../../../ops-agent/src/configuration-handoff-main.ts",
            import.meta.url,
          ),
        ),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...environment,
          OPENMAPX_TEST_DOCKER_BRIDGE: url,
          ...(fault ? { OPENMAPX_TEST_HELPER_FAULT: fault } : {}),
          ...(options.kill
            ? { OPENMAPX_TEST_HELPER_PROCESS_FILE: join(host.root, "native-helper-processes") }
            : {}),
        },
        signal: AbortSignal.timeout(60000),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errorOutput = "",
      killed = false,
      closedSignal: NodeJS.Signals | null = null;
    child.stdout.on("data", (value) => {
      output += String(value);
    });
    child.stderr.on("data", (value) => {
      errorOutput += String(value);
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        closedSignal = signal;
        resolve(code);
      });
    });
    if (options.kill)
      void options.kill.when.then(() => {
        killed = child.kill("SIGKILL");
      });
    const code = await closed;
    options.kill?.release();
    if (options.kill) {
      expect({ code, closedSignal, killed, output, errorOutput }).toEqual({
        code: null,
        closedSignal: "SIGKILL",
        killed: true,
        output: "",
        errorOutput: "",
      });
    } else if (fault || options.failureStage) {
      expect({ code, output, errorOutput }).toEqual({
        code: 1,
        output: "",
        errorOutput: `configuration_handoff_recovery_required:${options.failureStage ?? "application"}\n`,
      });
      if (fault) expect(existsSync(join(host.root, "native-helper-fault-observed"))).toBe(true);
    } else
      expect({ code, output, errorOutput }).toEqual({
        code: 0,
        output: "configuration_handoff_applied\n",
        errorOutput: "",
      });
  } finally {
    options.kill?.release();
    await bridge.close();
    if (options.kill && existsSync(join(host.root, "native-helper-processes"))) {
      const ids = readFileSync(join(host.root, "native-helper-processes"), "utf8")
          .trim()
          .split("\n")
          .map(Number),
        alive = (pid: number) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        until = Date.now() + 5000;
      while (ids.some(alive) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ids.filter(alive)).toEqual([]);
    }
  }
}

/** Existing native production-agent driver; only external Docker I/O is bridged. */
async function nativeReleaseAgent(
  host: Awaited<ReturnType<typeof ownedServiceHost>>,
  ids: string[],
  port: number,
) {
  const bridge = Fastify();
  bridge.post("/docker", async (request, reply) => {
    const { args } = request.body as { args: string[] };
    try {
      return await host.execFile("docker", args, {
        signal: AbortSignal.timeout(30000),
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      return reply.code(502).send({ error: "Named Docker IO failed" });
    }
  });
  const dockerBridge = await bridge.listen({ host: "127.0.0.1", port: 0 });
  const child = spawn(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx/esm"),
      fileURLToPath(
        new URL(
          "../../../../ops-agent/src/test-fixtures/staged-coordinator-request-process.mjs",
          import.meta.url,
        ),
      ),
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: process.env },
  );
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  const ready = Promise.withResolvers<void>();
  let pending = "";
  child.stdout.on("data", (data) => {
    pending += String(data);
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n"),
        line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        if (JSON.parse(line).event === "ready") ready.resolve();
      } catch {
        /* Only the fixed ready event is consumed. */
      }
    }
  });
  child.stderr.resume();
  void closed.then(
    ({ code }) => ready.reject(Error(`Native agent exited before readiness (${code})`)),
    (error) => ready.reject(error),
  );
  child.stdin.end(
    JSON.stringify({
      root: host.root,
      infraDir: host.infraDir,
      stack: host.stack,
      serviceIds: ids,
      queue: host.queue,
      token: host.token,
      dockerBridge: `${dockerBridge}/docker`,
      listenPort: port,
      captureReleaseAuthority: true,
    }),
  );
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    ready.reject(Error("Native agent readiness timed out"));
  }, 30000);
  try {
    await ready.promise;
  } catch (error) {
    await bridge.close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return await closed;
  };
  return {
    kill,
    close: async () => {
      await kill();
      await bridge.close();
    },
  };
}

/** The API's actual queued producer/reconciler runs in a killable process. */
async function nativeReleaseWorker(
  host: Awaited<ReturnType<typeof ownedServiceHost>>,
  databaseUrl: string,
  input:
    | { action: "release"; actorId: string; releaseId: string; manifestDigest: string }
    | { action: "reconcile"; jobId: string },
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx/esm"),
      fileURLToPath(new URL("./fixtures/native-coordinator-api.ts", import.meta.url)),
    ],
    {
      cwd: host.root,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        OPENMAPX_ROOT_DIR: host.root,
        NODE_ENV: "test",
        BETTER_AUTH_SECRET: "synthetic-platform-worker-auth-fixture",
      },
    },
  );
  const queued = Promise.withResolvers<string>();
  let pending = "",
    result: { status?: string; errorClass?: string } | undefined;
  child.stdout.on("data", (data) => {
    pending += String(data);
    if (pending.length > 16384) pending = "";
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n"),
        line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (event.event === "queued" && typeof event.jobId === "string")
          queued.resolve(event.jobId);
        if (event.event === "result")
          result = { status: event.status, errorClass: event.errorClass };
      } catch {
        /* Only fixed, non-secret fixture events are observed. */
      }
    }
  });
  child.stderr.resume();
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    result: typeof result;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, result }));
  });
  void done.then(
    (value) => queued.reject(Error(`Native API exited before queueing (${value.code})`)),
    (error) => queued.reject(error),
  );
  if (input.action === "reconcile") queued.resolve(input.jobId);
  child.stdin.end(JSON.stringify(input));
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    queued.reject(Error("Native API queueing timed out"));
  }, 30000);
  let jobId: string;
  try {
    jobId = await queued.promise;
  } finally {
    clearTimeout(timer);
  }
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return await done;
  };
  return { jobId, done, kill };
}

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "owned platform preparation",
  () => {
    beforeEach(async () => {
      state.fixture = await createMigratedPostgresFixture();
    }, 90000);
    afterEach(async () => {
      await state.fixture?.stop();
    });
    it.each([
      "old",
      "1",
      "launch",
      "launch-lost",
      "policy-change",
      "launch-apply",
      "launch-native",
      "launch-bundle",
      "launch-native-before-effect",
      "launch-native-after-effect",
      "launch-native-killed",
      "launch-native-producer",
      "launch-native-recovery",
      "launch-native-job",
      "launch-native-resource",
      "launch-native-release",
      "launch-native-release-wrong-config",
      "launch-native-system-release",
      "launch-native-system-release-ack-loss",
      "launch-native-system-release-killed",
      "launch-native-system-release-agent-restart",
      "launch-native-system-release-api-before-save",
      "launch-native-system-release-api-after-save",
      "launch-native-system-release-late-cancel",
      "launch-native-system-release-pull-failure",
    ])(
      "guards and retains helper mode %s through original ownership",
      async (version) => {
        const nativeAgents: Array<Awaited<ReturnType<typeof nativeReleaseAgent>>> = [];
        const nativeWorkers: Array<Awaited<ReturnType<typeof nativeReleaseWorker>>> = [];
        let nativeAgentExited = false;
        const helperEffectEntered = Promise.withResolvers<void>(),
          continueHelperEffect = Promise.withResolvers<void>();
        let writersWereReleased = false;
        const native = version.startsWith("launch-native") || version === "launch-bundle",
          application = version === "launch-apply" || native,
          systemRelease = version.startsWith("launch-native-system-release"),
          apiRestart = version.startsWith("launch-native-system-release-api-");
        const ids = [
          "motis",
          "ops-agent",
          "app-api",
          "traefik",
          "postgis",
          "redis",
          "data-manager",
        ];
        const host = await ownedServiceHost({
          withCoordinator: true,
          selectedRoots: ids,
          environment: {
            "ops-agent": { BACKUP_RETENTION_DAYS: "${BACKUP_RETENTION_DAYS:-30}" },
            "app-api": { BACKUP_RETENTION_DAYS: "${BACKUP_RETENTION_DAYS:-30}" },
          },
          configurationHelperVersion: version === "old" ? "old" : "1",
          configurationHelperLaunchResponseLoss: version === "launch-lost",
          configurationHelperReleaseInventory: application,
          configurationReleaseMetadata:
            version.startsWith("launch-native-release") || systemRelease,
          ...(application
            ? {
                schemas: {
                  "ops-agent": JSON.parse(
                    readFileSync(
                      new URL("../../../../../services/ops-agent/service.json", import.meta.url),
                      "utf8",
                    ),
                  ).configSchema,
                },
              }
            : {}),
          actualComposeConfig: true,
        });
        state.services = host.loaded;
        if (
          [
            "launch-native-producer",
            "launch-native-recovery",
            "launch-native-job",
            "launch-native-resource",
            "launch-native-release",
            "launch-native-release-wrong-config",
            "launch-native-system-release",
            "launch-native-system-release-ack-loss",
            "launch-native-system-release-killed",
            "launch-native-system-release-agent-restart",
            "launch-native-system-release-api-before-save",
            "launch-native-system-release-api-after-save",
            "launch-native-system-release-late-cancel",
            "launch-native-system-release-pull-failure",
          ].includes(version)
        ) {
          state.registry = new services.ServiceRegistry({
            rootDir: host.root,
            enabledIds: new Set(ids),
          });
          await state.registry.load();
          state.services = state.registry.list();
        }
        let rows = ids.map((id, index) => ({
          ...host.row,
          Id: String(index + 1).repeat(64),
          ConfigImage: `example/${id}:1`,
          Labels: { ...host.row.Labels, "com.docker.compose.service": id },
        }));
        host.setRows(rows);
        let checkedRelease: { releaseId: string; manifestDigest: string } | undefined;
        if (version.startsWith("launch-native-release") || systemRelease) {
          vi.stubEnv("OPENMAPX_RELEASE", "main");
          vi.stubEnv("OPENMAPX_RELEASE_MANIFEST_REPOSITORY", "ghcr.io/openmapx/release-manifest");
          const manifest = services.parseReleaseManifest(
            JSON.stringify({
              schemaVersion: 1,
              release: "checked-runtime-release-01",
              images: Object.fromEntries(
                services.RELEASE_IMAGE_NAMES.map((image) => [
                  image,
                  `ghcr.io/openmapx/${image}@sha256:${"9".repeat(64)}`,
                ]),
              ),
              privacyReleaseValidation: {
                version: 1,
                sourceBuildFingerprint: "f".repeat(64),
                validatedAt: "2026-10-30T00:00:00.000Z",
                checks: {
                  translationsConsistent: true,
                  openApiConsistent: true,
                  policyConsistent: true,
                },
              },
            }),
          );
          const raw = services.canonicalReleaseManifest(manifest);
          checkedRelease = {
            releaseId: manifest.release,
            manifestDigest: createHash("sha256").update(raw).digest("hex"),
          };
          mkdirSync(join(host.infraDir, ".ops-agent-releases"), { recursive: true, mode: 0o700 });
          writeFileSync(
            join(host.infraDir, ".ops-agent-releases", `${manifest.release}.json`),
            raw,
            { mode: 0o600 },
          );
          host.setImagePullProcess(async (reference) => {
            if (version === "launch-native-system-release-pull-failure")
              throw Error("Named release pull process failure");
            host.setImageIdentity(reference, `sha256:${"e".repeat(64)}`);
          });
        }
        if (application) {
          const inspections: Parameters<typeof host.setRuntimeInspections>[0] = {};
          if (checkedRelease) {
            for (const old of rows)
              inspections[old.Id] = {
                Id: old.Id,
                Image: old.Image,
                State: { Status: "running", Running: true, Health: { Status: "healthy" } },
                Config: { Image: old.ConfigImage, Labels: old.Labels, Env: [] },
                HostConfig: { Memory: 0, NanoCpus: 0 },
                Mounts: [],
              };
            host.setRuntimeInspections(inspections);
          }
          host.setCreatingProcess(async (args) => {
            const id = args.at(-1)!,
              old = rows.find((row) => row.Labels["com.docker.compose.service"] === id);
            if (
              !old ||
              !(
                checkedRelease ? ["data-manager", "app-api", "ops-agent"] : ["app-api", "ops-agent"]
              ).includes(id)
            )
              throw Error("Unexpected protected target");
            if (
              version === "launch-native-killed" ||
              version === "launch-native-system-release-killed"
            ) {
              await services.withConfigurationGenerationWriter(host.infraDir, async () => {
                const lock = await services.acquireReleaseStoreLock(
                  join(host.infraDir, ".ops-agent-releases"),
                  {},
                  { failIfBusy: true },
                );
                lock.release();
                writersWereReleased = true;
              });
              helperEffectEntered.resolve();
              await continueHelperEffect.promise;
              return;
            }
            if (version === "launch-native-system-release-agent-restart" && id === "ops-agent") {
              expect(await nativeAgents[0]!.kill()).toEqual({ code: null, signal: "SIGKILL" });
              nativeAgentExited = true;
            }
            const prefix = args.slice(0, args.indexOf("up")),
              options = {
                signal: new AbortController().signal,
                timeout: 15000,
                maxBuffer: 1024 * 1024,
              },
              config = JSON.parse(
                (await host.execFile("docker", [...prefix, "config", "--format", "json"], options))
                  .stdout,
              ),
              hash = (
                await host.execFile("docker", [...prefix, "config", "--hash", id], options)
              ).stdout
                .trim()
                .split(/\s+/)
                .at(-1)!,
              compose = services.configurationGenerationComposeFile(
                host.infraDir,
                services.currentConfigurationGeneration(host.infraDir)!,
              ),
              row = {
                ...old,
                Id: (id === "app-api" ? "a" : id === "data-manager" ? "c" : "b").repeat(64),
                ...(checkedRelease
                  ? { Image: `sha256:${"e".repeat(64)}`, ConfigImage: config.services[id].image }
                  : {}),
                Labels: {
                  ...old.Labels,
                  "com.docker.compose.project.working_dir": join(compose, ".."),
                  "com.docker.compose.project.config_files": checkedRelease
                    ? `${compose},${host.stack.composeReleasePath}`
                    : compose,
                  "com.docker.compose.config-hash": hash,
                },
              },
              spec = config.services[id],
              limits = spec.deploy?.resources?.limits;
            rows = rows.map((value) => (value === old ? row : value));
            host.setRows(rows);
            inspections[row.Id] = {
              Id: row.Id,
              Image: row.Image,
              State: { Status: "running", Running: true, Health: { Status: "healthy" } },
              Config: {
                Image: row.ConfigImage,
                Labels: row.Labels,
                Env: Object.entries(spec.environment ?? {}).map(
                  ([key, value]) => `${key}=${value}`,
                ),
              },
              HostConfig: {
                Memory: Number(limits?.memory ?? 0),
                NanoCpus: Math.round(Number(limits?.cpus ?? 0) * 1e9),
              },
              Mounts:
                checkedRelease && version !== "launch-native-release-wrong-config"
                  ? (spec.configs ?? []).map((mount: { source: string; target?: string }) => ({
                      Type: "bind",
                      Source: config.configs[mount.source].file,
                      Destination: mount.target ?? `/${mount.source}`,
                      RW: false,
                    }))
                  : [],
            };
            host.setRuntimeInspections(inspections);
          });
        }
        const installation = openControlInstallation({
          infraDir: host.infraDir,
          role: "ops-agent",
          serviceIds: ids,
        });
        const dm = await ownedDataManager({
          sql: state.fixture.sql,
          infraDir: host.infraDir,
          serviceIds: ids,
          pausePrepareResponse: version === "launch-native-system-release-api-before-save",
        });
        const journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json"));
        const app = buildOpsAgentServer({
          tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
          runtime: host.runtime,
          resourceClaimer: host.claimer,
          journal,
          controlInstallation: installation,
        });
        let acknowledgementLost = false;
        app.addHook("onSend", async (request, reply, payload) => {
          const operation = (
            request.body as { operation?: { kind?: string; operationKey?: string } } | undefined
          )?.operation;
          if (
            version === "launch-native-system-release-ack-loss" &&
            !acknowledgementLost &&
            reply.statusCode === 200 &&
            operation?.kind === "controlRetention.acknowledge" &&
            journal
              .records()
              .some(
                (row) =>
                  row.operationKey === operation.operationKey &&
                  row.operation.kind === "configurationHandoff.prepare",
              )
          ) {
            acknowledgementLost = true;
            reply.raw.destroy();
          }
          return payload;
        });
        const url = await app.listen({ host: "127.0.0.1", port: 0 });
        if (version === "launch-native-system-release-agent-restart") await app.close();
        const tokenFile = join(host.root, "platform-api-token");
        writeFileSync(tokenFile, host.token, { mode: 0o600 });
        for (const [key, value] of Object.entries({
          OPS_AGENT_URL: url,
          OPS_AGENT_TOKEN_FILE: tokenFile,
          OPS_TRUSTED_CONFIG_DIR: host.queue,
          OPS_TRUSTED_CONFIG_UID: String(statSync(host.queue).uid),
          OPS_TRUSTED_CONFIG_GID: String(statSync(host.queue).gid),
          OPENMAPX_SECRETS_KEY: "31".repeat(32),
          DOMAIN: "example.test",
          DATA_MANAGER_URL: dm.baseUrl,
          DATA_MANAGER_AUTH_TOKEN: dm.token,
          OPENMAPX_DISABLE_LOCALHOST_AUTH: "1",
        }))
          vi.stubEnv(key, value);
        if (version === "launch-native-system-release-agent-restart")
          nativeAgents.push(
            await nativeReleaseAgent(
              host,
              host.loaded.map((service) => service.manifest.id),
              Number(new URL(url).port),
            ),
          );
        let publicApi: FastifyInstance | undefined;
        try {
          const actorId = randomUUID(),
            jobId = randomUUID(),
            execution = { owner: randomUUID(), version: 1 },
            operationKey = `opk1_${randomUUID().replaceAll("-", "")}`;
          await state.fixture.db.insert(schema.user).values({
            id: actorId,
            name: "Synthetic admin",
            email: `${actorId}@example.test`,
            role: "admin",
          });
          if (application)
            await state.fixture.db.insert(schema.serviceConfig).values({
              id: randomUUID(),
              serviceId: "ops-agent",
              config: { OPENMAPX_MEMORY_MIB: 256, OPENMAPX_CPU_LIMIT: 0.5 },
            });
          if (
            [
              "launch-native-job",
              "launch-native-resource",
              "launch-native-release",
              "launch-native-release-wrong-config",
              "launch-native-system-release",
              "launch-native-system-release-ack-loss",
              "launch-native-system-release-killed",
              "launch-native-system-release-agent-restart",
              "launch-native-system-release-api-before-save",
              "launch-native-system-release-api-after-save",
              "launch-native-system-release-late-cancel",
              "launch-native-system-release-pull-failure",
            ].includes(version)
          ) {
            const { adminPlatformRoute } = await import("../../routes/admin-platform"),
              { adminSystemRoute } = await import("../../routes/admin-system"),
              { jobRunner } = await import("../job-runner"),
              { createDirectAdminOpsKey } = await import("../direct-ops-idempotency");
            state.session = mockAdminSession();
            state.session.user.id = actorId;
            state.session.session.userId = actorId;
            publicApi = Fastify();
            await publicApi.register(adminPlatformRoute, { prefix: "/api" });
            await publicApi.register(adminSystemRoute, { prefix: "/api" });
            const publicUrl = await publicApi.listen({ host: "127.0.0.1", port: 0 }),
              client = createApiClient({ baseUrl: publicUrl }),
              headers = { "idempotency-key": operationKey },
              reviewed = systemRelease
                ? undefined
                : unwrapAdminResponse(
                    await previewAdminPlatformConfiguration(
                      {
                        expectedCurrentRevisionId: host.initial.revisionId,
                        changes: [
                          "launch-native-resource",
                          "launch-native-release",
                          "launch-native-release-wrong-config",
                          "launch-native-system-release",
                          "launch-native-system-release-ack-loss",
                          "launch-native-system-release-killed",
                          "launch-native-system-release-agent-restart",
                          "launch-native-system-release-api-before-save",
                          "launch-native-system-release-api-after-save",
                          "launch-native-system-release-late-cancel",
                          "launch-native-system-release-pull-failure",
                        ].includes(version)
                          ? { version: 1 as const }
                          : {
                              version: 1 as const,
                              backupRetentionDays: { source: "database", value: 14 },
                            },
                        ...(version === "launch-native-resource"
                          ? { reconcileServiceIds: ["ops-agent" as const] }
                          : {}),
                        ...(checkedRelease ? { release: checkedRelease } : {}),
                      },
                      headers,
                      { client },
                    ),
                  ),
              input = reviewed
                ? {
                    expectedCurrentRevisionId: reviewed.preview.expectedCurrentRevisionId,
                    previewFingerprint: reviewed.preview.previewFingerprint,
                    confirmations: reviewed.preview.requiredConfirmation,
                  }
                : undefined;
            if (systemRelease) {
              const { handleSystemUpdateJob } = await import("../system-maintenance");
              jobRunner.register("system.update", handleSystemUpdateJob);
            }
            const apply = async () => {
              if (systemRelease) {
                if (apiRestart) {
                  const worker = await nativeReleaseWorker(host, state.fixture.connectionUri, {
                    action: "release",
                    actorId,
                    releaseId: checkedRelease!.releaseId,
                    manifestDigest: checkedRelease!.manifestDigest,
                  });
                  nativeWorkers.push(worker);
                  return { ok: true as const, jobId: worker.jobId };
                }
                const response = await fetch(`${publicUrl}/api/admin/system/updates/apply`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    confirmation: "UPDATE OPENMAPX",
                    createBackup: false,
                    releaseId: checkedRelease!.releaseId,
                    expectedDigest: checkedRelease!.manifestDigest,
                  }),
                });
                expect(response.status).toBe(200);
                const body = await response.json();
                expect(body).toEqual({ ok: true, jobId: expect.any(String) });
                return body as { ok: true; jobId: string };
              }
              return unwrapAdminResponse(
                await applyAdminPlatformConfiguration(input!, headers, { client }),
              );
            };
            const accepted = await apply();
            if (version === "launch-native-resource") {
              expect(reviewed!.preview.configuration).toEqual({ version: 1 });
              expect(reviewed!.preview.affectedServiceIds).toEqual(["ops-agent"]);
              expect(reviewed!.preview.oldOrigin).toBe(reviewed!.preview.newOrigin);
            }
            if (!systemRelease) expect(await apply()).toEqual(accepted);
            const readJob = async () =>
              (
                await state.fixture.db
                  .select()
                  .from(schema.adminJob)
                  .where(eq(schema.adminJob.id, accepted.jobId))
              )[0]!;
            const waitForOriginalLease = async () => {
              const until = Date.now() + 65000;
              for (;;) {
                const row = await readJob(),
                  expiry = (row.result as { _observationLeaseUntil?: string } | null)
                    ?._observationLeaseUntil;
                expect(typeof expiry).toBe("string");
                if (Date.parse(expiry!) <= Date.now()) break;
                expect(Date.now()).toBeLessThan(until);
                await new Promise((resolve) => setTimeout(resolve, 250));
              }
            };
            const readDesiredPlatform = async () => {
              const { PLATFORM_CONFIGURATION_SETTING } = await import("../platform-configuration");
              return state.fixture.db
                .select({ key: schema.systemSettings.key, rowVersion: sql<string>`xmin::text` })
                .from(schema.systemSettings)
                .where(eq(schema.systemSettings.key, PLATFORM_CONFIGURATION_SETTING));
            };
            if (version === "launch-native-system-release-api-before-save") {
              await Promise.race([
                dm.prepareReplyEntered,
                nativeWorkers[0]!.done.then(() => {
                  throw Error("API exited before prepared response");
                }),
              ]);
              expect(await nativeWorkers[0]!.kill()).toMatchObject({
                code: null,
                signal: "SIGKILL",
              });
              dm.releasePrepareResponse();
              await waitForOriginalLease();
              const replacement = await nativeReleaseWorker(host, state.fixture.connectionUri, {
                action: "reconcile",
                jobId: accepted.jobId,
              });
              nativeWorkers.push(replacement);
              expect(await replacement.done).toMatchObject({
                code: 2,
                signal: null,
                result: { status: "failed" },
              });
              const recovered = await readJob(),
                result = recovered.result as Record<string, unknown>;
              expect((result._execution as { version: number }).version).toBe(2);
              expect(result.configuration).toMatchObject({
                outcome: "not_committed",
                cleanupFailed: false,
              });
              expect(result.phase).toBe("not_applied");
              expect(await readDesiredPlatform()).toEqual([]);
              expect(dm.preparePosts).toBe(1);
              expect(dm.settlePosts).toBe(1);
              await dm.assertDataAdmission();
              expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
                host.initial.revisionId,
              );
              expect(
                host.calls.some(
                  (args) =>
                    args[0] === "run" ||
                    args.includes("up") ||
                    args[0] === "pull" ||
                    (args[0] === "image" && args[1] === "pull"),
                ),
              ).toBe(false);
              return;
            }
            const launchDeadline = Date.now() + 60000;
            while (!host.calls.some((args) => args[0] === "run") && Date.now() < launchDeadline) {
              const current = await readJob();
              expect(
                current.status,
                JSON.stringify({
                  error: current.error?.split("\n")[0].slice(0, 200),
                  preflight: (current.result as Record<string, unknown> | null)
                    ?.configurationPreflight,
                  configuration: (current.result as Record<string, unknown> | null)?.configuration,
                  states: journal.records().map((record) => ({
                    kind: record.operation.kind,
                    state: record.state,
                    errorClass: record.errorClass,
                  })),
                }),
              ).not.toBe("failed");
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            const args = host.calls.find((args) => args[0] === "run");
            expect(args).toBeDefined();
            if (version === "launch-native-system-release-late-cancel") {
              const until = Date.now() + 15000;
              for (;;) {
                const row = await readJob(),
                  projection = (
                    row.result as {
                      opsProjection?: {
                        operations?: Record<
                          string,
                          { kind: string; receiptDelivery?: { state: string } }
                        >;
                      };
                    } | null
                  )?.opsProjection;
                if (
                  Object.values(projection?.operations ?? {}).some(
                    (operation) =>
                      operation.kind === "configurationHandoff.prepare" &&
                      operation.receiptDelivery?.state === "confirmed",
                  )
                )
                  break;
                expect(Date.now()).toBeLessThan(until);
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              // The return value means confirmed containment, not stored intent.
              expect(await jobRunner.cancel(accepted.jobId)).toBe(false);
              expect((await readJob()).finishedAt).toBeNull();
              expect(dm.settlePosts).toBe(0);
            }
            let originalRows: unknown, originalPlatformRows: unknown;
            if (version === "launch-native-system-release-api-after-save") {
              const original = (await readJob()).result as {
                _configurationCandidate?: { sealedOperationKey?: string; rowVersions?: unknown };
              };
              const packet = join(
                  host.queue,
                  ".candidates",
                  `${original._configurationCandidate!.sealedOperationKey}.json`,
                ),
                bytes = readFileSync(packet);
              originalRows = original._configurationCandidate!.rowVersions;
              originalPlatformRows = await readDesiredPlatform();
              expect(originalPlatformRows).toHaveLength(1);
              expect(originalRows).toBeDefined();
              expect(await nativeWorkers[0]!.kill()).toMatchObject({
                code: null,
                signal: "SIGKILL",
              });
              expect(readFileSync(packet)).toEqual(bytes);
            }
            const env = (name: string) =>
              args!.find((value) => value.startsWith(`${name}=`))!.slice(name.length + 1);
            await nativeHelper(
              host,
              {
                OPENMAPX_ROOT_DIR: host.root,
                OPS_CONFIGURATION_HANDOFF_ID: env("OPS_CONFIGURATION_HANDOFF_ID"),
                OPENMAPX_CONTROL_DELEGATION: env("OPENMAPX_CONTROL_DELEGATION"),
                OPENMAPX_CONTROL_EXECUTION: env("OPENMAPX_CONTROL_EXECUTION"),
              },
              version === "launch-native-release-wrong-config" ||
                version === "launch-native-system-release-pull-failure"
                ? { failureStage: "application" }
                : version === "launch-native-system-release-killed"
                  ? {
                      kill: {
                        when: helperEffectEntered.promise,
                        release: () => continueHelperEffect.resolve(),
                      },
                    }
                  : {},
            );
            if (version === "launch-native-system-release-pull-failure") {
              const file = join(
                  host.infraDir,
                  "control-private/ops-agent/observations",
                  `configuration-handoff-${env("OPS_CONFIGURATION_HANDOFF_ID")}.completion.json`,
                ),
                original = readFileSync(file);
              expect(JSON.parse(String(original)).payload).toMatchObject({
                phase: "recovery_required",
                completedAt: null,
              });
              await nativeHelper(
                host,
                {
                  OPENMAPX_ROOT_DIR: host.root,
                  OPS_CONFIGURATION_HANDOFF_ID: env("OPS_CONFIGURATION_HANDOFF_ID"),
                  OPENMAPX_CONTROL_DELEGATION: env("OPENMAPX_CONTROL_DELEGATION"),
                  OPENMAPX_CONTROL_EXECUTION: env("OPENMAPX_CONTROL_EXECUTION"),
                },
                { failureStage: "adoption" },
              );
              expect(readFileSync(file)).toEqual(original);
              await jobRunner.reconcile();
              const pending = await readJob();
              expect(pending.status).toBe("running");
              expect(pending.finishedAt).toBeNull();
              expect(dm.settlePosts).toBe(0);
              await expect(dm.assertDataAdmission()).rejects.toThrow();
              expect(
                host.calls.filter((args) => args[0] === "image" && args[1] === "pull"),
              ).toHaveLength(1);
              expect(host.calls.some((args) => args[0] === "compose" && args.includes("up"))).toBe(
                false,
              );
              expect(existsSync(join(host.infraDir, ".ops-agent-releases/current.json"))).toBe(
                false,
              );
              return;
            }
            if (version === "launch-native-system-release-agent-restart") {
              expect(nativeAgentExited).toBe(true);
              nativeAgents.push(
                await nativeReleaseAgent(
                  host,
                  host.loaded.map((service) => service.manifest.id),
                  Number(new URL(url).port),
                ),
              );
            }
            if (version === "launch-native-system-release-api-after-save") {
              await waitForOriginalLease();
              const replacement = await nativeReleaseWorker(host, state.fixture.connectionUri, {
                action: "reconcile",
                jobId: accepted.jobId,
              });
              nativeWorkers.push(replacement);
              expect(await replacement.done).toMatchObject({
                code: 0,
                signal: null,
                result: { status: "success" },
              });
              const recovered = (await readJob()).result as {
                _execution?: { version: number };
                _configurationCandidate?: { rowVersions?: unknown };
              };
              expect(recovered._execution?.version).toBe(2);
              expect(recovered._configurationCandidate?.rowVersions).toEqual(originalRows);
              expect(await readDesiredPlatform()).toEqual(originalPlatformRows);
            }
            if (version === "launch-native-system-release-killed") {
              const file = join(
                  host.infraDir,
                  "control-private/ops-agent/observations",
                  `configuration-handoff-${env("OPS_CONFIGURATION_HANDOFF_ID")}.completion.json`,
                ),
                original = readFileSync(file),
                environment = {
                  OPENMAPX_ROOT_DIR: host.root,
                  OPS_CONFIGURATION_HANDOFF_ID: env("OPS_CONFIGURATION_HANDOFF_ID"),
                  OPENMAPX_CONTROL_DELEGATION: env("OPENMAPX_CONTROL_DELEGATION"),
                  OPENMAPX_CONTROL_EXECUTION: env("OPENMAPX_CONTROL_EXECUTION"),
                };
              expect(writersWereReleased).toBe(true);
              expect(JSON.parse(String(original)).payload).toMatchObject({
                phase: "applying",
                completedAt: null,
              });
              await nativeHelper(host, environment, { failureStage: "adoption" });
              expect(readFileSync(file)).toEqual(original);
              await jobRunner.reconcile();
              expect((await readJob()).status).toBe("running");
              expect(dm.settlePosts).toBe(0);
              await expect(dm.assertDataAdmission()).rejects.toThrow();
              expect(
                host.calls.filter((args) => args[0] === "image" && args[1] === "pull"),
              ).toHaveLength(services.RELEASE_IMAGE_NAMES.length);
              expect(
                host.calls
                  .filter((args) => args[0] === "compose" && args.includes("up"))
                  .map((args) => args.at(-1)),
              ).toEqual(["data-manager"]);
              expect(existsSync(join(host.infraDir, ".ops-agent-releases/current.json"))).toBe(
                false,
              );
              return;
            }
            if (version === "launch-native-release-wrong-config") {
              await jobRunner.reconcile();
              expect((await readJob()).status).toBe("running");
              expect(dm.settlePosts).toBe(0);
              expect(existsSync(join(host.infraDir, ".ops-agent-releases", "current.json"))).toBe(
                false,
              );
              expect(
                host.calls
                  .filter((args) => args[0] === "compose" && args.includes("up"))
                  .map((args) => args.at(-1)),
              ).toEqual(["data-manager", "app-api"]);
              return;
            }
            const settleDeadline = Date.now() + 90000;
            let job = await readJob();
            while (
              ["running", "cancel_pending"].includes(job.status) &&
              Date.now() < settleDeadline
            ) {
              if (!apiRestart) await jobRunner.reconcile();
              await new Promise((resolve) => setTimeout(resolve, 250));
              job = await readJob();
            }
            expect(
              job.status,
              JSON.stringify({
                error: job.error?.split("\n")[0].slice(0, 200),
                observation: (job.result as Record<string, unknown> | null)?.observation,
                settled: !!(job.result as Record<string, unknown> | null)?._settled,
                candidate: (() => {
                  const value = (
                    job.result as {
                      _configurationCandidate?: { phase?: string; retirement?: unknown };
                    } | null
                  )?._configurationCandidate;
                  return { phase: value?.phase, retired: !!value?.retirement };
                })(),
                configuration: (job.result as Record<string, unknown> | null)?.configuration,
                states: journal.records().map((value) => ({
                  kind: value.operation.kind,
                  state: value.state,
                  errorClass: value.errorClass,
                })),
              }),
            ).toBe("success");
            if (version === "launch-native-system-release-late-cancel")
              expect(
                typeof (job.result as { _cancelRequestedAt?: unknown })._cancelRequestedAt,
              ).toBe("string");
            expect(job.payload).toEqual(
              systemRelease
                ? {
                    operation: "apply",
                    workflow: "guarded-release",
                    createBackup: false,
                    releaseId: checkedRelease!.releaseId,
                    expectedDigest: checkedRelease!.manifestDigest,
                  }
                : {
                    operationKey: createDirectAdminOpsKey(actorId, operationKey),
                  },
            );
            expect(job.result).toMatchObject({
              configuration: { outcome: "committed", followUp: "complete" },
            });
            if (!systemRelease) expect(await apply()).toEqual(accepted);
            if (checkedRelease) {
              const pulls = host.calls.filter((args) => args[0] === "image" && args[1] === "pull");
              expect(pulls).toHaveLength(services.RELEASE_IMAGE_NAMES.length);
              expect(pulls.map((args) => args.at(-1))).toEqual(
                services.RELEASE_IMAGE_NAMES.map(
                  (image) => `ghcr.io/openmapx/${image}@sha256:${"9".repeat(64)}`,
                ),
              );
              expect(
                rows
                  .filter((row) =>
                    ["data-manager", "app-api", "ops-agent"].includes(
                      row.Labels["com.docker.compose.service"],
                    ),
                  )
                  .every((row) => row.Image === `sha256:${"e".repeat(64)}`),
              ).toBe(true);
              expect(
                JSON.parse(
                  readFileSync(join(host.infraDir, ".ops-agent-releases", "current.json"), "utf8"),
                ),
              ).toMatchObject({
                releaseId: checkedRelease.releaseId,
                digest: checkedRelease.manifestDigest,
              });
            }
            if (version === "launch-native-system-release-ack-loss")
              expect(acknowledgementLost).toBe(true);
            expect(dm.settlePosts).toBe(1);
            expect(host.calls.filter((args) => args[0] === "run")).toHaveLength(1);
            expect(
              host.calls
                .filter((args) => args[0] === "compose" && args.includes("up"))
                .map((args) => args.at(-1)),
            ).toEqual(
              version === "launch-native-resource"
                ? ["ops-agent"]
                : checkedRelease
                  ? ["data-manager", "app-api", "ops-agent"]
                  : ["app-api", "ops-agent"],
            );
            return;
          }
          await state.fixture.db.insert(schema.adminJob).values({
            id: jobId,
            type: "platform.apply",
            status: "running",
            createdBy: actorId,
            result: { _execution: execution },
          });
          const ctx: JobContext = {
            jobId,
            jobType: "platform.apply",
            execution,
            payload: {},
            signal: new AbortController().signal,
            checkpointResult: { _execution: execution },
            log: async () => {},
            setProgress: async () => {},
            checkpoint: async (result, progress, key, address) => {
              if ((result.opsProjection as { version?: number })?.version === 3)
                ctx.checkpointResult = await checkpointOwnedAdminJob(
                  jobId,
                  execution,
                  result,
                  progress,
                  key,
                  address,
                  ctx.checkpointResult ?? {},
                );
              else {
                await state.fixture.db
                  .update(schema.adminJob)
                  .set({ result })
                  .where(eq(schema.adminJob.id, jobId));
                ctx.checkpointResult = result;
              }
            },
          };
          await writer.withAdministrativeConfigurationJob(ctx, () =>
            writer.withAdministrativeConfigurationWriter(
              { actorId, operationKey, integrationIds: [] },
              async (owned) => {
                const source = await executeAndWait(
                  createApiOpsClient(),
                  { kind: "configuration.sources.inspect" },
                  createDurableOpsKey("platform.sources", jobId),
                );
                const policy = await loadAuthPolicy(state.fixture.db);
                const preview = services.buildPlatformConfigurationPreview({
                  actorId,
                  previewId: randomUUID(),
                  authPolicyRevision: policy.revision,
                  sourceRevision: source.sourceRevision,
                  currentRevisionId: source.revisionId,
                  expectedCurrentRevisionId: source.revisionId,
                  currentPlatform: source.platform,
                  changes: { version: 1, backupRetentionDays: { source: "database", value: 14 } },
                  env: process.env,
                  services: state.services,
                });
                await retainPlatformPreview(
                  {
                    actorId,
                    operationKey,
                    requestFingerprint: "a".repeat(64),
                    preview,
                    sourceSnapshot: source,
                    desiredRowVersion: null,
                  },
                  state.fixture.db,
                );
                const intent = await preparePlatformConfigurationChange(
                  {
                    previewFingerprint: preview.previewFingerprint,
                    expectedCurrentRevisionId: source.revisionId,
                    confirmations: preview.requiredConfirmation,
                  },
                  owned,
                );
                const participation = platformConfigurationParticipation(intent, owned);
                const run = () =>
                  withConfigurationCommitParticipant(owned, participation.participant, async () => {
                    const candidate = await prospective.prepareProspectiveConfiguration({
                      actorId,
                      operationKey,
                      expectedCurrentRevisionId: source.revisionId,
                      overlay: participation.overlay,
                    });
                    await prospective.stageProspectiveConfigurationMaintenance(candidate);
                    await prospective.prepareConfigurationMaintenance(candidate);
                    if (version.startsWith("launch") || version === "policy-change") {
                      const decision =
                        await prospective.commitProspectiveConfigurationMaintenance(candidate);
                      await prospective.decideConfigurationMaintenance(decision);
                      const prepared = await prospective.inspectConfigurationMaintenance({
                        maintenanceId:
                          prospective.validatedConfigurationCandidateState(candidate).record
                            .maintenanceId!,
                        candidateId: candidate.candidateId,
                      });
                      if (version === "policy-change") {
                        const { applyAuthPolicy, defaultAuthPolicySettings } = await import(
                          "../../account/auth-policy"
                        );
                        await applyAuthPolicy(
                          {
                            confirmed: true,
                            expectedRevision: policy.revision,
                            idempotencyKey: randomUUID(),
                            settings: { ...defaultAuthPolicySettings, passwordMinLength: 14 },
                          },
                          actorId,
                          state.fixture.db,
                        );
                        await expect(
                          prospective.executeConfigurationMaintenanceStep(candidate, 0),
                        ).rejects.toThrow(/policy|preview/i);
                        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
                          host.initial.revisionId,
                        );
                        expect(host.calls.filter((args) => args[0] === "run")).toHaveLength(0);
                        expect(existsSync(join(host.queue, `${candidate.revisionId}.json`))).toBe(
                          false,
                        );
                        const [desired] = await state.fixture.db
                          .select()
                          .from(schema.systemSettings)
                          .where(eq(schema.systemSettings.key, "platformConfiguration"));
                        expect(desired?.value).toMatchObject({
                          candidateId: candidate.candidateId,
                          revisionId: candidate.revisionId,
                        });
                        await expect(dm.assertDataAdmission()).rejects.toThrow();
                        return candidate;
                      }
                      for (const step of prepared.steps)
                        await prospective.executeConfigurationMaintenanceStep(
                          candidate,
                          step.ordinal,
                        );
                      expect(host.calls.filter((args) => args[0] === "run")).toHaveLength(1);
                      if (["launch-native-producer", "launch-native-recovery"].includes(version)) {
                        const args = host.calls.find((args) => args[0] === "run")!,
                          env = (name: string) =>
                            args
                              .find((value) => value.startsWith(`${name}=`))!
                              .slice(name.length + 1);
                        await nativeHelper(host, {
                          OPENMAPX_ROOT_DIR: host.root,
                          OPS_CONFIGURATION_HANDOFF_ID: env("OPS_CONFIGURATION_HANDOFF_ID"),
                          OPENMAPX_CONTROL_DELEGATION: env("OPENMAPX_CONTROL_DELEGATION"),
                          OPENMAPX_CONTROL_EXECUTION: env("OPENMAPX_CONTROL_EXECUTION"),
                        });
                        if (version === "launch-native-recovery") return candidate;
                        const result = await prospective.persistAndApplyProspectiveConfiguration(
                          candidate,
                          { coordinatorMode: "require-running" },
                        );
                        expect(result).toMatchObject({
                          saved: "committed",
                          application: {
                            outcome: "committed",
                            followUp: "complete",
                            publisherCleanupFailed: false,
                            registryUpdateFailed: false,
                          },
                        });
                        const [retired] = await state.fixture.db
                          .select()
                          .from(schema.platformConfigurationPreview)
                          .where(eq(schema.platformConfigurationPreview.id, preview.previewId));
                        expect(retired?.retiredAt).toBeInstanceOf(Date);
                        const original =
                          prospective.validatedConfigurationCandidateState(candidate);
                        expect(
                          existsSync(
                            join(host.queue, ".candidates", `${original.record.operationKey}.json`),
                          ),
                        ).toBe(false);
                        expect(ctx.checkpointResult?._completion).toMatchObject({
                          result: {
                            platformConfiguration: {
                              previewFingerprint: preview.previewFingerprint,
                              revisionId: candidate.revisionId,
                              followUp: "complete",
                            },
                          },
                        });
                        expect(dm.settlePosts).toBe(1);
                        expect(host.calls.filter((args) => args[0] === "run")).toHaveLength(1);
                        expect(
                          host.calls
                            .filter((args) => args[0] === "compose" && args.includes("up"))
                            .map((args) => args.at(-1)),
                        ).toEqual(["app-api", "ops-agent"]);
                        return candidate;
                      }
                      // Reattachment observes the same terminal preparation;
                      // it cannot consume another dispatch ticket/create again.
                      await prospective.executeConfigurationMaintenanceStep(
                        candidate,
                        prepared.steps.at(-1)!.ordinal,
                      );
                      expect(host.calls.filter((args) => args[0] === "run")).toHaveLength(1);
                    }
                    return candidate;
                  });
                if (version === "old")
                  await expect(run()).rejects.toMatchObject({
                    result: { configurationPreflight: { errorClass: "host_update_required" } },
                  });
                else {
                  let candidate: Awaited<
                    ReturnType<typeof prospective.prepareProspectiveConfiguration>
                  >;
                  try {
                    candidate = await run();
                  } catch (error) {
                    console.info(
                      "platform-step-status",
                      journal.records().map((job) => ({
                        kind: job.operation.kind,
                        state: job.state,
                        errorClass: job.errorClass,
                      })),
                    );
                    const value = error as {
                      result?: { errorCode?: unknown; configurationPreflight?: unknown };
                    };
                    console.info(
                      "platform-preflight-diagnostic",
                      JSON.stringify({
                        errorCode: value.result?.errorCode,
                        preflight: value.result?.configurationPreflight,
                      }),
                    );
                    throw error;
                  }
                  if (version === "launch-native-recovery") {
                    const { readOwnedConfigurationMaintenance } = await import(
                        "../../../../ops-agent/src/configuration-maintenance-store"
                      ),
                      { inspectMaintenanceDockerRuntime } = await import(
                        "../../../../ops-agent/src/configuration-maintenance-docker-inspection"
                      ),
                      { installationState } = await import(
                        "../../../../../packages/core/src/build-artifacts/control-authority"
                      ),
                      record = prospective.validatedConfigurationCandidateState(candidate).record,
                      receipt = await prospective.inspectConfigurationMaintenance({
                        maintenanceId: record.maintenanceId!,
                        candidateId: candidate.candidateId,
                      }),
                      authority = restoreAdmittedControlExecution(installation, receipt.prepare),
                      owner = readOwnedConfigurationMaintenance(authority),
                      containers = await host.owned.inspectOwnedServices(
                        new AbortController().signal,
                      ),
                      lock = await services.acquireReleaseStoreLock(
                        join(host.infraDir, ".ops-agent-releases"),
                      );
                    const callsBeforeInspection = host.calls.length;
                    try {
                      await expect(
                        inspectMaintenanceDockerRuntime({
                          stack: repoPaths(host.root),
                          execFile: host.execFile,
                          owner,
                          containers,
                          privateKey: installationState(installation).privateKey,
                          signal: new AbortController().signal,
                        }),
                      ).rejects.toThrow("Release store is busy");
                      expect(host.calls).toHaveLength(callsBeforeInspection);
                    } finally {
                      lock.release();
                    }
                    execution.version = 2;
                    ctx.checkpointResult = {
                      ...ctx.checkpointResult,
                      _execution: { ...execution },
                    };
                    await state.fixture.db
                      .update(schema.adminJob)
                      .set({ result: ctx.checkpointResult })
                      .where(eq(schema.adminJob.id, jobId));
                    const recovered = await prospective.resumeRetainedConfigurationCandidate();
                    expect(recovered).toMatchObject({
                      configuration: { outcome: "committed", followUp: "complete" },
                    });
                    expect(dm.settlePosts).toBe(1);
                    expect(host.calls.filter((args) => args[0] === "run")).toHaveLength(1);
                    expect(
                      host.calls
                        .filter((args) => args[0] === "compose" && args.includes("up"))
                        .map((args) => args.at(-1)),
                    ).toEqual(["app-api", "ops-agent"]);
                    return;
                  }
                  if (version === "policy-change" || version === "launch-native-producer") return;
                  const retained = ctx.checkpointResult?._configurationMaintenance as
                    | { phase?: string; receipt?: { state?: string; steps?: { phase: string }[] } }
                    | undefined;
                  expect(retained?.receipt?.state).toBe(
                    version.startsWith("launch") ? "authorized" : "prepared",
                  );
                  expect(retained?.receipt?.steps?.at(-1)?.phase).toBe("maintenance-handoff");
                  expect(candidate.affectedServiceIds).toEqual(["app-api", "ops-agent"]);
                  const receipt = await prospective.inspectConfigurationMaintenance({
                    maintenanceId:
                      prospective.validatedConfigurationCandidateState(candidate).record
                        .maintenanceId!,
                    candidateId: candidate.candidateId,
                  });
                  const { readOwnedConfigurationMaintenance } = await import(
                    "../../../../ops-agent/src/configuration-maintenance-store"
                  );
                  const owner = readOwnedConfigurationMaintenance(
                    restoreAdmittedControlExecution(installation, receipt.prepare),
                  );
                  expect(owner.plan.handoff?.expectedImageIdentities).toEqual({
                    "app-api": host.row.Image,
                    "ops-agent": host.row.Image,
                  });
                  expect(owner.plan.nestedHandoff?.recipient).toBe("configuration-helper");
                  expect(receipt.binding.expectedSourceRevision).toBe(source.sourceRevision);
                  if (version.startsWith("launch")) {
                    const handoff = await createApiOpsClient().execute({
                      kind: "configurationHandoff.inspect",
                      handoffId: owner.plan.handoff!.handoffId,
                    });
                    expect(handoff).toMatchObject({
                      execution: "sync",
                      value: {
                        phase: "prepared",
                        appliedRevisionId: null,
                        completedServiceIds: [],
                        failedServiceIds: [],
                      },
                    });
                    expect(receipt).toMatchObject({
                      state: "applying",
                      followUp: "unknown",
                      dmFence: { state: "prepared" },
                    });
                    await expect(dm.assertDataAdmission()).rejects.toThrow();
                    const [saved] = await state.fixture.db
                      .select()
                      .from(schema.systemSettings)
                      .where(eq(schema.systemSettings.key, "platformConfiguration"));
                    expect(saved?.value).toMatchObject({
                      candidateId: candidate.candidateId,
                      revisionId: candidate.revisionId,
                    });
                    expect(dm.settlePosts).toBe(0);
                    const blocked = await fetch(`${url}/v1/operations`, {
                      method: "POST",
                      headers: {
                        authorization: `Bearer ${host.token}`,
                        "x-ops-protocol-version": "2",
                        "content-type": "application/json",
                      },
                      body: JSON.stringify({
                        version: 2,
                        requestId: `ops1_${randomUUID().replaceAll("-", "")}`,
                        operationKey: createDurableOpsKey("platform.blocked", jobId),
                        issuedAt: new Date().toISOString(),
                        expiresAt: new Date(Date.now() + 15000).toISOString(),
                        execution: { requestedDeadlineAt: Date.now() + 60000 },
                        operation: { kind: "service.restart", serviceId: "motis" },
                      }),
                    });
                    expect(blocked.status).toBe(409);
                    expect(await blocked.json()).toMatchObject({ error: { class: "busy" } });
                    expect(
                      (await createApiOpsClient().execute({ kind: "docker.status" })).execution,
                    ).toBe("sync");
                    const childControl = await import(
                      "../../../../ops-agent/src/configuration-handoff-control"
                    );
                    const args = host.calls.find((args) => args[0] === "run")!;
                    const env = (name: string) =>
                      args.find((value) => value.startsWith(`${name}=`))!.slice(name.length + 1);
                    await expect(
                      childControl.openConfigurationHandoffChild({
                        rootDir: host.root,
                        handoffId: owner.plan.handoff!.handoffId,
                        assertion: env("OPENMAPX_CONTROL_DELEGATION"),
                        execution: {
                          ...JSON.parse(env("OPENMAPX_CONTROL_EXECUTION")),
                          executionId: randomUUID(),
                        },
                      }),
                    ).rejects.toThrow("Original configuration helper spawn required");
                    let nativeInstallation:
                      | ReturnType<typeof openFixedChildInstallation>
                      | undefined;
                    const child = native
                      ? undefined
                      : await childControl.openConfigurationHandoffChild({
                          rootDir: host.root,
                          handoffId: owner.plan.handoff!.handoffId,
                          assertion: env("OPENMAPX_CONTROL_DELEGATION"),
                          execution: JSON.parse(env("OPENMAPX_CONTROL_EXECUTION")),
                        });
                    try {
                      if (child)
                        await childControl.waitForConfigurationHandoffPreparation(
                          child,
                          AbortSignal.timeout(2000),
                        );
                      if (application) {
                        if (native) {
                          const environment = {
                              OPENMAPX_ROOT_DIR: host.root,
                              OPS_CONFIGURATION_HANDOFF_ID: owner.plan.handoff!.handoffId,
                              OPENMAPX_CONTROL_DELEGATION: env("OPENMAPX_CONTROL_DELEGATION"),
                              OPENMAPX_CONTROL_EXECUTION: env("OPENMAPX_CONTROL_EXECUTION"),
                            },
                            fault =
                              version === "launch-native-before-effect"
                                ? "before-effect"
                                : version === "launch-native-after-effect"
                                  ? "after-effect"
                                  : undefined;
                          await nativeHelper(host, environment, {
                            bundled: version === "launch-bundle",
                            fault,
                            ...(version === "launch-native-killed"
                              ? {
                                  kill: {
                                    when: helperEffectEntered.promise,
                                    release: () => continueHelperEffect.resolve(),
                                  },
                                }
                              : {}),
                          });
                          if (version === "launch-native-killed") {
                            const file = join(
                                host.infraDir,
                                "control-private/ops-agent/observations",
                                `configuration-handoff-${owner.plan.handoff!.handoffId}.completion.json`,
                              ),
                              original = readFileSync(file);
                            expect(writersWereReleased).toBe(true);
                            expect(JSON.parse(String(original)).payload).toMatchObject({
                              phase: "applying",
                              completedAt: null,
                            });
                            await nativeHelper(host, environment, { failureStage: "adoption" });
                            expect(readFileSync(file)).toEqual(original);
                            expect(
                              host.calls.filter(
                                (args) => args[0] === "compose" && args.includes("up"),
                              ),
                            ).toHaveLength(1);
                            expect(dm.settlePosts).toBe(0);
                            await expect(dm.assertDataAdmission()).rejects.toThrow();
                            expect(() =>
                              verifyRetainedArtifactTargetRootRelease(
                                restoreAdmittedControlExecution(installation, owner.plan.prepare),
                              ),
                            ).toThrow();
                            const { inspectConfigurationHandoff } = await import(
                                "../../../../ops-agent/src/configuration-handoff-store"
                              ),
                              execution = JSON.parse(environment.OPENMAPX_CONTROL_EXECUTION),
                              clock = vi
                                .spyOn(Date, "now")
                                .mockReturnValue(execution.deadlineAt + 1);
                            try {
                              expect(
                                inspectConfigurationHandoff(
                                  host.infraDir,
                                  owner.plan.handoff!.handoffId,
                                ),
                              ).toMatchObject({
                                phase: "recovery_required",
                                appliedRevisionId: null,
                              });
                            } finally {
                              clock.mockRestore();
                            }
                            return;
                          }
                          if (fault) {
                            const file = join(
                                host.infraDir,
                                "control-private/ops-agent/observations",
                                `configuration-handoff-${owner.plan.handoff!.handoffId}.completion.json`,
                              ),
                              before = readFileSync(file);
                            await expect(dm.assertDataAdmission()).rejects.toThrow();
                            const { inspectConfigurationHandoff } = await import(
                              "../../../../ops-agent/src/configuration-handoff-store"
                            );
                            expect(
                              inspectConfigurationHandoff(
                                host.infraDir,
                                owner.plan.handoff!.handoffId,
                              ),
                            ).toMatchObject({
                              phase: "recovery_required",
                              appliedRevisionId: null,
                            });
                            await nativeHelper(host, environment);
                            expect(readFileSync(file)).toEqual(before);
                            await nativeHelper(host, environment);
                            expect(readFileSync(file)).toEqual(before);
                          }
                          nativeInstallation = openFixedChildInstallation({
                            infraDir: host.infraDir,
                            assertion: env("OPENMAPX_CONTROL_DELEGATION"),
                          });
                        } else {
                          if (!child) throw Error("Original inline helper required");
                          const { runConfigurationHandoffApplication } = await import(
                            "../../../../ops-agent/src/configuration-handoff-application"
                          );
                          expect(
                            await runConfigurationHandoffApplication({
                              child,
                              rootDir: host.root,
                              execFile: host.execFile,
                            }),
                          ).toMatchObject({
                            phase: "applied",
                            completedServiceIds: ["app-api", "ops-agent"],
                          });
                        }
                        const actual = child
                          ? childControl.configurationHandoffChildState(child)
                          : {
                              installation: nativeInstallation!,
                              intent: readConfigurationHandoffSpawnIntent(
                                nativeInstallation!,
                                JSON.parse(env("OPENMAPX_CONTROL_EXECUTION")),
                                owner.plan.handoff!.handoffId,
                              ),
                            };
                        verifyRetainedArtifactTargetSettlement(
                          actual.installation,
                          {
                            leaseId: actual.intent.leaseId,
                            delegationId: actual.intent.delegationId,
                            phase: "ready",
                          },
                          actual.intent.helper,
                        );
                        const { inspectConfigurationHandoff } = await import(
                          "../../../../ops-agent/src/configuration-handoff-store"
                        );
                        const completionFile = join(
                            host.infraDir,
                            "control-private/ops-agent/observations",
                            `configuration-handoff-${actual.intent.operation.handoffId}.completion.json`,
                          ),
                          retainedFile = `${completionFile}.retained`;
                        renameSync(completionFile, retainedFile);
                        try {
                          writeFileSync(completionFile, readFileSync(retainedFile), {
                            mode: 0o600,
                          });
                          expect(() =>
                            inspectConfigurationHandoff(
                              host.infraDir,
                              actual.intent.operation.handoffId,
                            ),
                          ).toThrow();
                        } finally {
                          rmSync(completionFile);
                          renameSync(retainedFile, completionFile);
                        }
                        expect(
                          await inspectConfigurationHandoff(
                            host.infraDir,
                            actual.intent.operation.handoffId,
                          ),
                        ).toMatchObject({
                          phase: "applied",
                          appliedRevisionId: candidate.revisionId,
                          completedServiceIds: ["app-api", "ops-agent"],
                          recoveryCodes: [],
                        });
                        const applied = await prospective.inspectConfigurationMaintenance({
                          maintenanceId: receipt.binding.maintenanceId,
                          candidateId: candidate.candidateId,
                        });
                        expect(applied.followUp).toBe("complete");
                        const settled = await prospective.settleConfigurationMaintenance({
                          kind: "configurationMaintenance.settle",
                          maintenanceId: applied.binding.maintenanceId,
                          candidateId: candidate.candidateId,
                          prepareOperationKey: applied.prepare.operationKey,
                          prepareFingerprint: applied.prepare.operationFingerprint,
                          planDigest: applied.planDigest,
                          decisionId: applied.decision!.decisionId,
                          expectedSequence: applied.sequence,
                          evidenceDigest: configurationMaintenanceSettleRequestDigest(applied),
                        });
                        expect(settled.state).toBe("settled");
                        expect(dm.settlePosts).toBe(1);
                        await dm.assertDataAdmission();
                        const { configurationHandoffPendingMaintenanceIds } = await import(
                          "../../../../ops-agent/src/configuration-maintenance-store"
                        );
                        expect(configurationHandoffPendingMaintenanceIds(host.runtime).size).toBe(
                          0,
                        );
                        expect(
                          host.calls
                            .filter((args) => args[0] === "compose" && args.includes("up"))
                            .map((args) => args.at(-1)),
                        ).toEqual(["app-api", "ops-agent"]);
                        if (version === "launch-native-after-effect") {
                          const location = (role: string) =>
                              join(
                                host.infraDir,
                                "control-private",
                                role,
                                "retention-locations",
                                `${controlDigest(owner.origin)}.json`,
                              ),
                            clock = vi
                              .spyOn(Date, "now")
                              .mockReturnValue(Date.now() + 96 * 3600000);
                          try {
                            for (
                              let round = 0;
                              round < 16 &&
                              (existsSync(location("ops-agent")) ||
                                existsSync(location("data-manager")));
                              round++
                            ) {
                              await reconcileControlRetention(installation, { maxFamilies: 64 });
                              await dm.reconcileRetention();
                            }
                            if (existsSync(location("ops-agent"))) {
                              const family = JSON.parse(
                                  readFileSync(location("ops-agent"), "utf8"),
                                ),
                                progress = JSON.parse(
                                  readFileSync(
                                    join(
                                      host.infraDir,
                                      "control-private/ops-agent/retention-families",
                                      family.name,
                                      "progress.json",
                                    ),
                                    "utf8",
                                  ),
                                ),
                                fact = progress.executions[controlDigest(actual.intent.helper)];
                              console.info("original helper retention fact", {
                                known: fact?.known,
                                terminalAt: fact?.terminalAt,
                                requiresJournal: fact?.requiresJournal,
                              });
                            }
                            expect(existsSync(location("ops-agent"))).toBe(false);
                            expect(existsSync(location("data-manager"))).toBe(false);
                          } finally {
                            clock.mockRestore();
                          }
                        }
                        return;
                      }
                      if (!child) throw Error("Original inline helper required");
                      childControl.assertConfigurationHandoffHostSources(child);
                      writeFileSync(join(host.infraDir, ".env"), "OPENMAPX_SYNTHETIC_DRIFT=1\n");
                      expect(() =>
                        childControl.assertConfigurationHandoffHostSources(child),
                      ).toThrow("Helper host sources changed");
                      expect(
                        host.calls.filter((args) => args[0] === "compose" && args.includes("up")),
                      ).toHaveLength(0);
                    } finally {
                      if (child) childControl.closeConfigurationHandoffChild(child);
                      if (nativeInstallation) closeControlInstallation(nativeInstallation);
                    }
                    return;
                  }
                  const abandon =
                    await prospective.prepareConfigurationMaintenanceAbandon(candidate);
                  await prospective.decideConfigurationMaintenance(abandon);
                  const unused = await prospective.inspectConfigurationMaintenance({
                    maintenanceId: receipt.binding.maintenanceId,
                    candidateId: candidate.candidateId,
                  });
                  const settled = await prospective.settleConfigurationMaintenance({
                    kind: "configurationMaintenance.settle",
                    maintenanceId: receipt.binding.maintenanceId,
                    candidateId: candidate.candidateId,
                    prepareOperationKey: unused.prepare.operationKey,
                    prepareFingerprint: unused.prepare.operationFingerprint,
                    planDigest: unused.planDigest,
                    decisionId: abandon.decisionId,
                    expectedSequence: unused.sequence,
                    evidenceDigest: configurationMaintenanceSettleRequestDigest(unused),
                  });
                  expect(settled.state).toBe("settled");
                  expect(dm.settlePosts).toBe(1);
                  await dm.assertDataAdmission();
                  await prospective.discardUnusedPreparedProspectiveConfiguration(candidate);
                }
                expect(dm.preparePosts).toBe(version === "old" ? 0 : 1);
                expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
                  host.initial.revisionId,
                );
                const [desired] = await state.fixture.db
                  .select()
                  .from(schema.systemSettings)
                  .where(eq(schema.systemSettings.key, "platformConfiguration"));
                expect(desired).toBeUndefined();
                const [retained] = await state.fixture.db
                  .select()
                  .from(schema.platformConfigurationPreview)
                  .where(eq(schema.platformConfigurationPreview.id, preview.previewId));
                expect(retained?.consumedAt).toBeNull();
              },
            ),
          );
        } finally {
          await publicApi?.close();
          for (const worker of nativeWorkers) await worker.kill();
          for (const agent of nativeAgents) await agent.close();
          await dm.close();
          await app.close();
          closeControlInstallation(installation);
          state.services = [];
          state.registry = null;
          state.session = null;
          vi.unstubAllEnvs();
          rmSync(host.cleanupRoot, { recursive: true, force: true });
        }
      },
      240000,
    );
  },
);
