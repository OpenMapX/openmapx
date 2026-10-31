import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeControlInstallation, openControlInstallation } from "@openmapx/core/build-artifacts";
import { packageIntegration } from "@openmapx/integration-framework/installer";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ownedServiceHost } from "../../../ops-agent/src/__fixtures__/owned-service-host";
import {
  IntegrationStore,
  installIntegrationRuntime,
} from "../../../ops-agent/src/integration-store";
import { openOpsJobJournal } from "../../../ops-agent/src/journal";
import { buildOpsAgentServer } from "../../../ops-agent/src/server";
import * as schema from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";
import type { JobContext } from "./job-runner";

const state = vi.hoisted(() => ({
  fixture: null as Awaited<ReturnType<typeof createMigratedPostgresFixture>> | null,
}));
vi.mock("../db", () => ({
  get db() {
    return state.fixture!.db;
  },
  get sql() {
    return state.fixture!.sql;
  },
}));
vi.mock("./extension-store", () => ({
  getKillSwitch: async () => ({ removed: new Map(), critical: new Map(), stale: false }),
}));
vi.mock("../integration-host", () => ({
  getAllIntegrations: () => [],
  reloadIntegrations: async () => ({ message: "ok", reloaded: 1, enabled: 1 }),
}));
const enabled = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1";
let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
let host: Awaited<ReturnType<typeof ownedServiceHost>>;
let agent: ReturnType<typeof buildOpsAgentServer>;
let installation: ReturnType<typeof openControlInstallation>;
let publications = 0;
beforeAll(async () => {
  if (!enabled) return;
  fixture = await createMigratedPostgresFixture();
  state.fixture = fixture;
  host = await ownedServiceHost({ actualComposeConfig: true });
  writeFileSync(
    join(host.infraDir, ".env"),
    `UID=${process.getuid?.() ?? 0}\nGID=${process.getgid?.() ?? 0}\n`,
    { mode: 0o600 },
  );
  const source = join(host.root, "artifact-source");
  mkdirSync(source);
  writeFileSync(
    join(source, "manifest.json"),
    JSON.stringify({
      id: "workflow-map",
      name: "Workflow",
      version: "1.0.0",
      domains: ["map-overlay"],
      quality: "community",
      platform: "1.0",
    }),
  );
  const artifact = join(host.root, "workflow.tar.gz");
  await packageIntegration({ rootDir: host.root, source, outFile: artifact });
  const store = new IntegrationStore({
    rootDir: host.root,
    uid: process.geteuid?.() ?? 0,
    builtInIds: () => new Set(),
    download: async ({ destination }) => {
      copyFileSync(artifact, destination);
    },
  });
  installIntegrationRuntime(host.runtime, store);
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
  agent.addHook("preHandler", async (request) => {
    const kind = (request.body as { operation?: { kind?: string } } | undefined)?.operation?.kind;
    if (
      request.method === "POST" &&
      ["catalogIntegration.publish", "catalogIntegration.settle"].includes(kind ?? "")
    )
      publications++;
  });

  const url = await agent.listen({ host: "127.0.0.1", port: 0 });
  const token = join(host.root, "api-token");
  writeFileSync(token, host.token, { mode: 0o600 });
  for (const [key, value] of Object.entries({
    OPS_AGENT_URL: url,
    OPS_AGENT_TOKEN_FILE: token,
    OPENMAPX_ROOT_DIR: host.root,
    OPS_TRUSTED_CONFIG_DIR: host.queue,
    OPS_TRUSTED_CONFIG_UID: String(statSync(host.queue).uid),
    OPS_TRUSTED_CONFIG_GID: String(statSync(host.queue).gid),
    DOMAIN: "example.test",
    POSTGRES_PASSWORD: "p".repeat(24),
    BETTER_AUTH_SECRET: "a".repeat(32),
    DATA_MANAGER_AUTH_TOKEN: "d".repeat(32),
  }))
    vi.stubEnv(key, value);
}, 90000);
afterAll(async () => {
  await agent?.close();
  if (installation) closeControlInstallation(installation);
  if (host) rmSync(host.root, { recursive: true, force: true });
  await fixture?.stop();
  vi.restoreAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it.skipIf(!enabled)(
  "uses the original real SQL job and agent broker for publication, bookkeeping and settlement",
  async () => {
    const { checkpointOwnedAdminJob } = await import("./admin-job-checkpoint");
    const { openExtensionWorkflow } = await import("./extension-workflow");
    const { handleExtensionInstallJob } = await import("./extension-installer");
    const artifact = readFileSync(join(host.root, "workflow.tar.gz"));
    const payload = {
      manifest: {
        id: "workflow-bundle",
        name: "Workflow bundle",
        version: "1.0.0",
        integrations: [
          {
            id: "workflow-map",
            artifact: "https://example.test/workflow.tar.gz",
            sha256: createHash("sha256").update(artifact).digest("hex"),
          },
        ],
      },
      sourceTrust: "community",
    };
    const execution = { owner: randomUUID(), version: 1 };
    const id = randomUUID();
    await fixture.db.insert(schema.adminJob).values({
      id,
      type: "extension.install",
      payload,
      status: "running",
      result: { _execution: execution },
    });
    let baseline: Record<string, unknown> = { _execution: execution };
    const ctx: JobContext = {
      jobId: id,
      jobType: "extension.install",
      execution,
      payload,
      signal: new AbortController().signal,
      checkpointResult: { _execution: execution },
      log: async () => {},
      setProgress: async () => {},
      checkpoint: async (value, progress, key, address) => {
        if (value.opsProjection)
          ctx.checkpointResult = await checkpointOwnedAdminJob(
            id,
            ctx.execution,
            value,
            progress,
            key,
            address,
            baseline,
          );
        else {
          const rows = await fixture.db
            .update(schema.adminJob)
            .set({ result: value })
            .where(eq(schema.adminJob.id, id))
            .returning();
          ctx.checkpointResult = rows[0]!.result as Record<string, unknown>;
        }
        baseline = structuredClone(ctx.checkpointResult ?? {});
      },
    };
    await openExtensionWorkflow(ctx, payload);
    expect(await handleExtensionInstallJob(ctx)).toEqual({ id: "workflow-bundle", components: 1 });
    const count = publications;
    const [installed] = await fixture.db
      .select()
      .from(schema.installedIntegration)
      .where(eq(schema.installedIntegration.id, "workflow-map"));
    expect(installed?.lastTransactionId).toBeTruthy();
    const [before] =
      await fixture.sql`select xmin::text as xmin from installed_extension where id='workflow-bundle'`;
    expect(await handleExtensionInstallJob(ctx)).toEqual({ id: "workflow-bundle", components: 1 });
    expect(publications).toBe(count);
    const [after] =
      await fixture.sql`select xmin::text as xmin from installed_extension where id='workflow-bundle'`;
    expect(after?.xmin).toBe(before?.xmin);
  },
  90000,
);

it.skipIf(!enabled)(
  "reclaims native API death before and after atomic bookkeeping without a second publication",
  async () => {
    const { claimAdminJob } = await import("./admin-job-state");
    for (const stopAt of ["published", "bookkept"]) {
      const id = randomUUID(),
        bundle = "workflow-bundle";
      const source = {
        kind: "artifact",
        url: "https://example.test/workflow.tar.gz",
        sha256: createHash("sha256")
          .update(readFileSync(join(host.root, "workflow.tar.gz")))
          .digest("hex"),
      };
      await fixture.db.insert(schema.adminJob).values({
        id,
        type: "extension.install",
        status: "running",
        payload: { source, bundle },
        result: { _execution: { owner: randomUUID(), version: 1 } },
      });
      const count = publications;
      const start = (boundary: string) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            createRequire(import.meta.url).resolve("tsx/esm"),
            fileURLToPath(
              new URL("./__tests__/fixtures/extension-workflow-native.ts", import.meta.url),
            ),
            id,
            boundary,
          ],
          {
            env: { ...process.env, DATABASE_URL: fixture.connectionUri },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        let errors = "";
        child.stderr!.on("data", (data) => {
          errors += String(data).slice(0, 4000);
        });
        const exited = new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => resolve(code));
        });
        const reached = new Promise<void>((resolve, reject) => {
          child.on("message", (message) => {
            if ((message as { boundary?: string }).boundary === boundary) resolve();
          });
          child.once("exit", () => reject(new Error(`Native boundary absent: ${errors}`)));
        });
        void reached.catch(() => {});
        return { child, exited, reached, errors: () => errors };
      };
      const first = start(stopAt);
      try {
        await first.reached;
      } catch (error) {
        first.child.kill("SIGKILL");
        throw error;
      }
      const before =
        await fixture.sql`select xmin::text as xmin from installed_extension where id=${bundle}`;
      first.child.kill("SIGKILL");
      await first.exited;
      const [row] = await fixture.db
        .select()
        .from(schema.adminJob)
        .where(eq(schema.adminJob.id, id));
      const reclaimed = await claimAdminJob(row!);
      expect(reclaimed).toBeTruthy();
      const replacement = start("none");
      expect(await replacement.exited, replacement.errors()).toBe(0);
      expect(publications - count).toBe(2); // one publish, one original settlement
      const after =
        await fixture.sql`select xmin::text as xmin from installed_extension where id=${bundle}`;
      expect(after).toHaveLength(1);
      if (stopAt === "bookkept") expect(after[0]!.xmin).toBe(before[0]!.xmin);
      const { readInstalledIntegrations } = await import("./agent-integrations");
      expect(
        (await readInstalledIntegrations()).integrations.find(
          (entry) => entry.integrationId === "workflow-map",
        )?.pending,
      ).toBeNull();
    }
  },
  90000,
);

it.skipIf(!enabled)(
  "installs and removes a service-bearing extension through original-job repository, configuration and Docker brokers",
  async () => {
    const { checkpointOwnedAdminJob } = await import("./admin-job-checkpoint");
    const { openExtensionWorkflow } = await import("./extension-workflow");
    const { handleExtensionInstallJob, handleExtensionRemoveJob } = await import(
      "./extension-installer"
    );
    const { initServiceRegistry } = await import("./service-registry");
    await initServiceRegistry({ strict: true });
    host.setCreatingProcess(async (args) => {
      if (!args.includes("community-live")) return;
      const { services } = await import("@openmapx/core/server");
      const compose = services.configurationGenerationComposeFile(
        host.infraDir,
        services.currentConfigurationGeneration(host.infraDir)!,
      );
      host.setRows([
        host.row,
        {
          ...host.row,
          Id: "c".repeat(64),
          ConfigImage: `example/community-live@sha256:${"b".repeat(64)}`,
          Labels: {
            ...host.row.Labels,
            "com.docker.compose.service": "community-live",
            "com.docker.compose.project.config_files": compose,
            "com.docker.compose.project.working_dir": (await import("node:path")).dirname(compose),
          },
        },
      ]);
    });
    host.setRemovingProcess(async (args) => {
      if (args.includes("community-live")) host.setRows([host.row]);
    });

    async function context(type: string, payload: Record<string, unknown>) {
      const id = randomUUID(),
        execution = { owner: randomUUID(), version: 1 };
      await fixture.db
        .insert(schema.adminJob)
        .values({ id, type, status: "running", payload, result: { _execution: execution } });
      let baseline: Record<string, unknown> = { _execution: execution };
      const ctx: JobContext = {
        jobId: id,
        jobType: type,
        payload,
        execution,
        signal: new AbortController().signal,
        checkpointResult: { _execution: execution },
        log: async () => {},
        setProgress: async () => {},
        checkpoint: async (value, progress, key, address) => {
          if (value.opsProjection)
            ctx.checkpointResult = await checkpointOwnedAdminJob(
              id,
              ctx.execution,
              value,
              progress,
              key,
              address,
              baseline,
            );
          else {
            const [saved] = await fixture.db
              .update(schema.adminJob)
              .set({ result: value })
              .where(eq(schema.adminJob.id, id))
              .returning();
            ctx.checkpointResult = saved!.result as Record<string, unknown>;
          }
          baseline = structuredClone(ctx.checkpointResult ?? {});
        },
      };
      return ctx;
    }
    const payload = {
      manifest: {
        id: "service-workflow",
        name: "Service workflow",
        version: "1.0.0",
        services: [
          { repo: "https://github.com/example/community-services", service: "community-live" },
        ],
      },
      sourceTrust: "community",
    };
    const ctx = await context("extension.install", payload);
    await openExtensionWorkflow(ctx, payload);
    async function complete<T>(owner: JobContext, run: () => Promise<T>): Promise<T> {
      const { claimAdminJob, readJobExecution } = await import("./admin-job-state");
      for (let n = 0; n < 8; n++) {
        try {
          return await run();
        } catch (error) {
          if ((error as { reason?: string }).reason !== "receipt_delivery" || n === 7) throw error;
          const [row] = await fixture.db
            .select()
            .from(schema.adminJob)
            .where(eq(schema.adminJob.id, owner.jobId));
          const claimed = await claimAdminJob(row!);
          if (!claimed) throw error;
          owner.execution = readJobExecution(claimed.result);
          owner.checkpointResult = claimed.result as Record<string, unknown>;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      throw Error("Original observation unavailable");
    }
    try {
      expect(await complete(ctx, () => handleExtensionInstallJob(ctx))).toEqual({
        id: "service-workflow",
        components: 1,
      });
    } catch (error) {
      console.error(
        "extension-phase",
        JSON.stringify({
          candidate: ctx.checkpointResult?._configurationCandidate,
          configuration: ctx.checkpointResult?.configuration,
        }),
      );
      throw error;
    }
    const operations = (
      ctx.checkpointResult!.opsProjection as {
        operations: Record<
          string,
          {
            kind: string;
            operation?: { expectedConfigurationRevisionId?: string };
            attempt?: { apiJobId: string };
          }
        >;
      }
    ).operations;
    expect(Object.values(operations).some((op) => op.kind === "serviceRepository.publish")).toBe(
      true,
    );
    expect(
      Object.values(operations).find((op) => op.kind === "service.pull")?.operation
        ?.expectedConfigurationRevisionId,
    ).toMatch(/^cfg1_/);
    expect(Object.values(operations).every((op) => op.attempt?.apiJobId === ctx.jobId)).toBe(true);
    const remove = await context("extension.remove", { id: "service-workflow" });
    await openExtensionWorkflow(remove, { id: "service-workflow" });
    expect(await complete(remove, () => handleExtensionRemoveJob(remove))).toEqual({
      id: "service-workflow",
      removed: 1,
    });
    expect(
      await fixture.db
        .select()
        .from(schema.installedExtension)
        .where(eq(schema.installedExtension.id, "service-workflow")),
    ).toEqual([]);
  },
  180000,
);
