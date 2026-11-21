/** A platform or release change through the API's routes, the production
 * agent, data-manager's fence and the production configuration helper. Only
 * the session provider and Docker's executable I/O are substituted: the helper
 * the agent starts with `docker run` runs in this process with the same I/O. */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApiClient } from "@openmapx/core";
import {
  applyAdminPlatformConfiguration,
  previewAdminPlatformConfiguration,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import {
  closeControlInstallation,
  leaseStoreDirectory,
  openControlInstallation,
  openLeaseStore,
} from "@openmapx/core/build-artifacts";
import { itemAt } from "@openmapx/core/item-at";
import { services } from "@openmapx/core/server";
import { eq, sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { heldTargets } from "../../../../../packages/core/src/build-artifacts/__fixtures__/held-targets";
import { releaseProvenance } from "../../../../../packages/core/src/services/__fixtures__/release-provenance";
import { ownedDataManager } from "../../../../ops-agent/src/__fixtures__/owned-data-manager";
import { ownedServiceHost } from "../../../../ops-agent/src/__fixtures__/owned-service-host";
import { createConfigurationHandoffHost } from "../../../../ops-agent/src/configuration-handoff-application";
import { runConfigurationHandoff } from "../../../../ops-agent/src/handoff-helper";
import { openOpsJobJournal } from "../../../../ops-agent/src/journal";
import { readMaintenance } from "../../../../ops-agent/src/maintenance";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import * as schema from "../../db/schema";
import { mockAdminSession } from "../../test/auth";
import { dataManagerTokenFile } from "../../test/data-manager-token";
import type { createMigratedPostgresFixture } from "../../test/postgres-fixture";
import { createPostgresFixturePool } from "../../test/postgres-fixture-pool";

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

type Mode =
  | "platform"
  | "launch-reply-lost"
  | "resource"
  | "release"
  | "release-slow-pull"
  | "release-wrong-config"
  | "system-release"
  | "system-release-pull-failure";

const IDS = ["motis", "ops-agent", "app-api", "traefik", "postgis", "redis", "data-manager"];
const RELEASE_IMAGE = `sha256:${"e".repeat(64)}`;

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "platform and release changes through the configuration helper",
  () => {
    let pool: Awaited<ReturnType<typeof createPostgresFixturePool>>;
    beforeAll(async () => {
      pool = await createPostgresFixturePool();
    }, 90000);
    afterAll(async () => {
      await pool?.stop();
    });
    beforeEach(async () => {
      // Each scenario is an independent installation with a fresh limiter bucket.
      (await import("../../utils/rate-limit")).systemMaintenanceLimit.reset();
      state.fixture = await pool.create();
    }, 90000);
    afterEach(async () => {
      await state.fixture?.stop();
    });

    it.each<Mode>([
      "platform",
      "launch-reply-lost",
      "resource",
      "release",
      "release-slow-pull",
      "system-release",
      "system-release-pull-failure",
      "release-wrong-config",
    ])(
      "applies or holds a %s change through one maintenance",
      async (mode) => {
        const release = mode.startsWith("release") || mode.startsWith("system-release"),
          systemRelease = mode.startsWith("system-release");
        const host = await ownedServiceHost({
          withCoordinator: true,
          selectedRoots: IDS,
          environment: {
            "ops-agent": { BACKUP_RETENTION_DAYS: "${BACKUP_RETENTION_DAYS:-30}" },
            "app-api": { BACKUP_RETENTION_DAYS: "${BACKUP_RETENTION_DAYS:-30}" },
          },
          configurationHelperVersion: "1",
          configurationHelperLaunchResponseLoss: mode === "launch-reply-lost",
          configurationHelperReleaseInventory: true,
          configurationReleaseMetadata: release,
          schemas: {
            "ops-agent": JSON.parse(
              readFileSync(
                new URL("../../../../../services/ops-agent/service.json", import.meta.url),
                "utf8",
              ),
            ).configSchema,
          },
          actualComposeConfig: true,
        });
        state.registry = new services.ServiceRegistry({
          rootDir: host.root,
          enabledIds: new Set(IDS),
        });
        await state.registry.load();
        state.services = state.registry.list();
        let rows = IDS.map((id, index) => ({
          ...host.row,
          Id: String(index + 1).repeat(64),
          ConfigImage: `example/${id}:1`,
          Labels: { ...host.row.Labels, "com.docker.compose.service": id },
        }));
        host.setRows(rows);
        let checkedRelease: { releaseId: string; manifestDigest: string } | undefined;
        let releaseReferences: string[] = [];
        if (release) {
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
              ...releaseProvenance(),
            }),
          );
          checkedRelease = {
            releaseId: manifest.release,
            manifestDigest: createHash("sha256")
              .update(services.canonicalReleaseManifest(manifest))
              .digest("hex"),
          };
          services.cacheReleaseManifest(host.infraDir, manifest);
          releaseReferences = Object.values(manifest.images) as string[];
          // The images reach the host only through the pull before maintenance.
          host.setUnpulledImages(releaseReferences);
          host.setImagePullProcess(async (reference) => {
            if (mode === "system-release-pull-failure")
              throw Error("Named release pull process failure");
            if (mode === "release-slow-pull" && !vi.isFakeTimers()) {
              // The download takes longer than the preview's lifetime.
              vi.useFakeTimers({ toFake: ["Date"] });
              vi.setSystemTime(Date.now() + 11 * 60_000);
            }
            host.setImageIdentity(reference, RELEASE_IMAGE);
          });
        }
        const protectedTargets = release
          ? ["data-manager", "app-api", "ops-agent"]
          : ["app-api", "ops-agent"];
        const inspections: Parameters<typeof host.setRuntimeInspections>[0] = {};
        if (release) {
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
        // A recreate replaces the container with one running the new generation.
        host.setCreatingProcess(async (args) => {
          const id = args.at(-1),
            old = rows.find((row) => row.Labels["com.docker.compose.service"] === id);
          if (!id || !old || !protectedTargets.includes(id))
            throw Error("Unexpected protected target");
          const revision = services.currentConfigurationGeneration(host.infraDir);
          if (!revision) throw Error("Actual committed configuration generation unavailable");
          const prefix = args.slice(0, args.indexOf("up")),
            options = { signal: new AbortController().signal, timeout: 15000, maxBuffer: 1 << 20 },
            config = JSON.parse(
              (await host.execFile("docker", [...prefix, "config", "--format", "json"], options))
                .stdout,
            ),
            hash = (
              await host.execFile("docker", [...prefix, "config", "--hash", id], options)
            ).stdout
              .trim()
              .replace(/^.*\s/s, ""),
            compose = services.configurationGenerationComposeFile(host.infraDir, revision),
            row = {
              ...old,
              Id: (id === "app-api" ? "a" : id === "data-manager" ? "c" : "b").repeat(64),
              ...(release ? { Image: RELEASE_IMAGE, ConfigImage: config.services[id].image } : {}),
              Labels: {
                ...old.Labels,
                "com.docker.compose.project.working_dir": join(compose, ".."),
                "com.docker.compose.project.config_files": compose,
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
              // The API container no longer matches the release's Compose
              // definition in the wrong-configuration case.
              Env: Object.entries(spec.environment ?? {}).map(([key, value]) =>
                mode === "release-wrong-config" && id === "app-api"
                  ? `${key}=${value}-changed`
                  : `${key}=${value}`,
              ),
            },
            HostConfig: {
              Memory: Number(limits?.memory ?? 0),
              NanoCpus: Math.round(Number(limits?.cpus ?? 0) * 1e9),
            },
            Mounts: release
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
        // The production helper, as the container the agent starts runs it.
        const helperOutcomes: string[] = [];
        host.setHelperProcess(async (env) => {
          expect(env.OPENMAPX_ROOT_DIR).toBe(host.root);
          const variable = (name: string) => {
            const value = env[name];
            assert.isDefined(value, `the helper environment has no ${name}`);
            return value;
          };
          const installation = openControlInstallation({
            infraDir: host.infraDir,
            role: "ops-agent",
          });
          try {
            const outcome = await runConfigurationHandoff({
              installation,
              store: openLeaseStore({
                directory: leaseStoreDirectory(host.infraDir),
                purpose: "configuration helper",
              }),
              host: await createConfigurationHandoffHost({
                installation,
                rootDir: host.root,
                execFile: host.execFile,
              }),
              maintenanceId: variable("OPENMAPX_MAINTENANCE_ID"),
              handoffId: variable("OPS_CONFIGURATION_HANDOFF_ID"),
              leaseId: variable("OPENMAPX_LEASE_ID"),
              leaseChild: variable("OPENMAPX_LEASE_CHILD"),
              signal: AbortSignal.timeout(60000),
            });
            helperOutcomes.push(outcome);
            return outcome === "applied" ? 0 : 1;
          } catch (error) {
            helperOutcomes.push(`failed: ${(error as Error).message}`);
            throw error;
          } finally {
            closeControlInstallation(installation);
          }
        });
        const installation = openControlInstallation({
          infraDir: host.infraDir,
          role: "ops-agent",
          serviceIds: IDS,
        });
        const dm = await ownedDataManager({
          sql: state.fixture.sql,
          infraDir: host.infraDir,
          serviceIds: IDS,
        });
        const journal = await openOpsJobJournal(
          join(host.infraDir, "state/ops-agent/jobs-v1.json"),
        );
        const app = buildOpsAgentServer({
          tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
          runtime: host.runtime,
          resourceClaimer: host.claimer,
          journal,
          controlInstallation: installation,
          leaseStore: openLeaseStore({
            directory: leaseStoreDirectory(host.infraDir),
            purpose: "test agent",
          }),
        });
        const url = await app.listen({ host: "127.0.0.1", port: 0 });
        const tokenFile = join(host.root, "platform-api-token");
        writeFileSync(tokenFile, host.token, { mode: 0o600 });
        for (const [key, value] of Object.entries({
          OPS_AGENT_URL: url,
          OPS_AGENT_TOKEN_FILE: tokenFile,
          OPENMAPX_SECRETS_KEY: "31".repeat(32),
          DOMAIN: "example.test",
          DATA_MANAGER_URL: dm.baseUrl,
          DATA_MANAGER_TOKEN_FILE: dataManagerTokenFile(dm.token),
          OPENMAPX_DISABLE_LOCALHOST_AUTH: "1",
        }))
          vi.stubEnv(key, value);
        let publicApi: FastifyInstance | undefined;
        try {
          const actorId = randomUUID();
          let operationKey = `opk1_${randomUUID().replaceAll("-", "")}`;
          await state.fixture.db.insert(schema.user).values({
            id: actorId,
            name: "Synthetic admin",
            email: `${actorId}@example.test`,
            role: "admin",
          });
          await state.fixture.db.insert(schema.serviceConfig).values({
            id: randomUUID(),
            serviceId: "ops-agent",
            config: { OPENMAPX_MEMORY_MIB: 256, OPENMAPX_CPU_LIMIT: 0.5 },
          });
          const { adminPlatformRoute } = await import("../../routes/admin-platform"),
            { adminSystemRoute } = await import("../../routes/admin-system"),
            { jobRunner } = await import("../job-runner");
          state.session = mockAdminSession();
          state.session.user.id = actorId;
          state.session.session.userId = actorId;
          publicApi = Fastify();
          await publicApi.register(adminPlatformRoute, { prefix: "/api" });
          await publicApi.register(adminSystemRoute, { prefix: "/api" });
          const publicUrl = await publicApi.listen({ host: "127.0.0.1", port: 0 }),
            client = createApiClient({ baseUrl: publicUrl }),
            headers = {
              get "idempotency-key"() {
                return operationKey;
              },
            };
          const previewPlatform = async () =>
            unwrapAdminResponse(
              await previewAdminPlatformConfiguration(
                {
                  expectedCurrentRevisionId: host.initial.revisionId,
                  changes:
                    release || mode === "resource"
                      ? { version: 1 as const }
                      : {
                          version: 1 as const,
                          backupRetentionDays: { source: "database", value: 14 },
                        },
                  ...(mode === "resource" ? { reconcileServiceIds: ["ops-agent" as const] } : {}),
                  ...(checkedRelease && !systemRelease ? { release: checkedRelease } : {}),
                },
                headers,
                { client },
              ),
            );
          let input: Parameters<typeof applyAdminPlatformConfiguration>[0] | undefined;
          const review = async () => {
            const reviewed = await previewPlatform();
            input = {
              expectedCurrentRevisionId: reviewed.preview.expectedCurrentRevisionId,
              previewFingerprint: reviewed.preview.previewFingerprint,
              confirmations: reviewed.preview.requiredConfirmation,
            };
            return reviewed;
          };
          if (systemRelease) {
            const { handleSystemUpdateJob } = await import("../system-maintenance");
            jobRunner.register("system.update", handleSystemUpdateJob);
          } else {
            const reviewed = await review();
            if (mode === "resource") {
              expect(reviewed.preview.configuration).toEqual({ version: 1 });
              expect(reviewed.preview.affectedServiceIds).toEqual(["ops-agent"]);
            }
          }
          const apply = async (): Promise<{ ok: true; jobId: string }> => {
            if (!systemRelease) {
              assert.isDefined(input, "the configuration was not reviewed");
              return unwrapAdminResponse(
                await applyAdminPlatformConfiguration(input, headers, { client }),
              );
            }
            assert.isDefined(checkedRelease, "the release was not checked");
            const response = await fetch(`${publicUrl}/api/admin/system/updates/apply`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                confirmation: "UPDATE OPENMAPX",
                createBackup: false,
                releaseId: checkedRelease.releaseId,
                expectedDigest: checkedRelease.manifestDigest,
              }),
            });
            expect(response.status).toBe(200);
            return (await response.json()) as { ok: true; jobId: string };
          };
          const readJob = async (jobId: string) =>
            itemAt(
              await state.fixture.db
                .select()
                .from(schema.adminJob)
                .where(eq(schema.adminJob.id, jobId)),
              0,
            );
          const settledJob = async (
            jobId: string,
            until: (status: string) => boolean,
            timeoutMs = 90000,
          ) => {
            const deadline = Date.now() + timeoutMs;
            let job = await readJob(jobId);
            while (!until(job.status) && Date.now() < deadline) {
              await jobRunner.reconcile();
              await new Promise((resolve) => setTimeout(resolve, 250));
              job = await readJob(jobId);
            }
            return job;
          };
          const readDesiredPlatform = async () => {
            const { PLATFORM_CONFIGURATION_SETTING } = await import("../platform-configuration");
            return state.fixture.db
              .select({ key: schema.systemSettings.key, rowVersion: sql<string>`xmin::text` })
              .from(schema.systemSettings)
              .where(eq(schema.systemSettings.key, PLATFORM_CONFIGURATION_SETTING));
          };
          /** The agent's record of the job's maintenance. */
          const maintenanceOf = async (jobId: string) => {
            const { protocol } = await readJob(jobId),
              recorded = (
                protocol as {
                  operations?: {
                    operations?: Record<string, { kind?: string; operation?: unknown }>;
                  };
                } | null
              )?.operations?.operations,
              id = (
                Object.values(recorded ?? {}).find(
                  (operation) => operation.kind === "configurationMaintenance.prepare",
                )?.operation as { maintenanceId?: string } | undefined
              )?.maintenanceId;
            return readMaintenance(installation, String(id)).record;
          };
          const untouched = async () => {
            expect(dm.preparePosts).toBe(0);
            expect(dm.settlePosts).toBe(0);
            await dm.assertDataAdmission();
            expect(
              journal
                .records()
                .some((record) => record.operation.kind.startsWith("configurationMaintenance")),
            ).toBe(false);
            expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
              host.initial.revisionId,
            );
            expect(
              host.calls.some(
                (args) =>
                  args[0] === "run" ||
                  args.includes("up") ||
                  args.includes("stop") ||
                  args.includes("--force-recreate"),
              ),
            ).toBe(false);
          };

          let accepted = await apply();
          if (mode === "system-release-pull-failure") {
            // The registry is unreachable. Images download before any
            // maintenance, so the job fails with the installation untouched.
            const failed = await settledJob(accepted.jobId, (status) => status === "failed");
            expect(failed.status).toBe("failed");
            await untouched();
            expect(await readDesiredPlatform()).toEqual([]);
            expect(
              host.calls.filter((args) => args[0] === "image" && args[1] === "pull"),
            ).toHaveLength(1);
            return;
          }
          if (mode === "release-slow-pull") {
            // The download outlasted the preview: the job fails after the pull,
            // before maintenance or any other host effect.
            let failed = await readJob(accepted.jobId);
            for (let attempt = 0; failed.status !== "failed" && attempt < 600; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              failed = await readJob(accepted.jobId);
            }
            expect(failed.status).toBe("failed");
            expect(failed.error).toContain("Create a new preview and apply again");
            await untouched();
            vi.useRealTimers();
            // A new preview applies without downloading again.
            operationKey = `opk1_${randomUUID().replaceAll("-", "")}`;
            await review();
            accepted = await apply();
          }
          // A repeated request under the same key returns the same job.
          if (!systemRelease) expect(await apply()).toEqual(accepted);
          if (mode === "release-wrong-config") {
            // The helper finds the API container unlike the release and stops:
            // the maintenance needs recovery, holds its targets and the fence,
            // and the job stays running for the operator.
            const deadline = Date.now() + 60000;
            while (!helperOutcomes.length && Date.now() < deadline)
              await new Promise((resolve) => setTimeout(resolve, 100));
            expect(helperOutcomes).toEqual([expect.stringMatching(/^failed: /)]);
            const held = await settledJob(accepted.jobId, () => false, 10000);
            expect(held.status).toBe("running");
            expect(dm.settlePosts).toBe(0);
            expect((await maintenanceOf(accepted.jobId)).state).toBe("recovery_required");
            expect(heldTargets(host.infraDir)).not.toEqual([]);
            expect(
              host.calls
                .filter((args) => args[0] === "compose" && args.includes("up"))
                .map((args) => args.at(-1)),
            ).toEqual(["data-manager", "app-api"]);
            // A cancel cannot finish it either; it only stops this process's handler.
            expect(await jobRunner.cancel(accepted.jobId)).toBe(false);
            return;
          }
          const job = await settledJob(
            accepted.jobId,
            (status) => !["queued", "running", "cancel_pending"].includes(status),
          );
          expect(
            job.status,
            JSON.stringify({
              error: job.error?.split("\n")[0]?.slice(0, 200),
              configuration: (job.result as Record<string, unknown> | null)?.configuration,
              helperOutcomes,
              states: journal.records().map((value) => ({
                kind: value.operation.kind,
                state: value.state,
                errorClass: value.errorClass,
              })),
            }),
          ).toBe("success");
          expect(job.result).toMatchObject({
            configuration: { outcome: "committed", followUp: "complete" },
          });
          expect(helperOutcomes).toEqual(["applied"]);
          const maintenance = await maintenanceOf(accepted.jobId);
          expect(maintenance).toMatchObject({
            state: "settled",
            generation: "committed",
            followUp: "complete",
            fenceOutcome: "applied",
          });
          expect(maintenance.steps.at(-1)).toMatchObject({
            phase: "maintenance-handoff",
            outcome: "committed",
          });
          expect(dm.preparePosts).toBe(1);
          expect(dm.settlePosts).toBe(1);
          await dm.assertDataAdmission();
          expect(heldTargets(host.infraDir)).toEqual([]);
          // One helper, recorded before it started, removed once it exited.
          expect(host.calls.filter((args) => args[0] === "run")).toHaveLength(1);
          expect(host.helperContainers()).toEqual([]);
          // Each target once, the agent last.
          expect(
            host.calls
              .filter((args) => args[0] === "compose" && args.includes("up"))
              .map((args) => args.at(-1)),
          ).toEqual(mode === "resource" ? ["ops-agent"] : protectedTargets);
          if (!release && mode !== "resource") expect(await readDesiredPlatform()).toHaveLength(1);
          if (checkedRelease) {
            const pulls = host.calls.filter((args) => args[0] === "image" && args[1] === "pull");
            expect(pulls.map((args) => args.at(-1))).toEqual(releaseReferences);
            expect(
              rows
                .filter((row) =>
                  protectedTargets.includes(row.Labels["com.docker.compose.service"]),
                )
                .every((row) => row.Image === RELEASE_IMAGE),
            ).toBe(true);
            expect(services.readAppliedRelease(host.infraDir)?.manifestDigest).toBe(
              checkedRelease.manifestDigest,
            );
          }
        } finally {
          vi.useRealTimers();
          await publicApi?.close();
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
