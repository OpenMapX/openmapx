import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { closeControlInstallation, openControlInstallation } from "@openmapx/core/build-artifacts";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeterministicTarGz } from "../../../../../packages/integration-framework/src/deterministic-tar";
import { ownedServiceHost } from "../../../../ops-agent/src/__fixtures__/owned-service-host";
import { installArtifactTransferRuntime } from "../../../../ops-agent/src/artifact-transfer/runtime";
import { ArtifactTransferStore } from "../../../../ops-agent/src/artifact-transfer/store";
import { openOpsJobJournal } from "../../../../ops-agent/src/journal";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import { installStandaloneIntegrationRuntime } from "../../../../ops-agent/src/standalone-integration-runtime";
import * as schema from "../../db/schema";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";

const state = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
  host: null as unknown as Awaited<ReturnType<typeof ownedServiceHost>>,
}));
vi.mock("../../db", () => ({
  get db() {
    return state.fixture.db;
  },
  get sql() {
    return state.fixture.sql;
  },
}));
vi.mock("../../redis", () => ({ redis: null }));
vi.mock("../service-registry", async (actual) => ({
  ...(await actual<typeof import("../service-registry")>()),
  getServiceRegistry: () => ({
    list: () => state.host.loaded,
    get: (id: string) => state.host.loaded.find((service) => service.manifest.id === id),
  }),
}));
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "standalone install actual API/job/agent/host/PostgreSQL",
  () => {
    const cleanups: (() => Promise<void>)[] = [];
    let apiUrl: string, agent: ReturnType<typeof buildOpsAgentServer>, store: ArtifactTransferStore;
    let dropInstallResponse = false,
      installPosts = 0,
      cancelIntegrationId: string | null = null;
    let jobRunner: typeof import("../job-runner").jobRunner;
    beforeAll(async () => {
      state.fixture = await createMigratedPostgresFixture();
      cleanups.push(() => state.fixture.stop());
      state.host = await ownedServiceHost();
      cleanups.push(async () => rmSync(state.host.cleanupRoot, { recursive: true, force: true }));
      vi.stubEnv("BETTER_AUTH_SECRET", "standalone-fixture-auth-secret-not-for-production");
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "standalone-local-fixture");
      const tokenFile = join(state.host.cleanupRoot, "api-token");
      writeFileSync(tokenFile, state.host.token, { mode: 0o600 });
      vi.stubEnv("OPS_AGENT_TOKEN_FILE", tokenFile);
      const installation = openControlInstallation({
        infraDir: state.host.infraDir,
        role: "ops-agent",
        serviceIds: state.host.loaded.map((service) => service.manifest.id),
      });
      cleanups.push(async () => closeControlInstallation(installation));
      store = new ArtifactTransferStore({
        dataRoot: join(state.host.infraDir, "data/.openmapx-transfers"),
        privateRoot: join(state.host.cleanupRoot, "transfer-metadata"),
        token: state.host.token,
        capacity: () => ({ bytes: 4 * 1024 ** 3, inodes: 100000 }),
      });
      installArtifactTransferRuntime(state.host.runtime, store);
      installStandaloneIntegrationRuntime(state.host.runtime, { rootDir: state.host.root, store });
      agent = buildOpsAgentServer({
        tokens: { api: state.host.token, "data-manager": "b".repeat(43) },
        runtime: state.host.runtime,
        resourceClaimer: state.host.claimer,
        journal: await openOpsJobJournal(join(state.host.infraDir, "data/ops-agent/jobs-v1.json")),
        controlInstallation: installation,
        artifactTransfers: store,
      });
      agent.addHook("onSend", async (request, reply, payload) => {
        if (
          request.method === "POST" &&
          (request.body as { operation?: { kind?: string } })?.operation?.kind ===
            "integration.install"
        ) {
          installPosts++;
          if (dropInstallResponse) {
            dropInstallResponse = false;
            reply.raw.destroy();
          }
        }
        if (cancelIntegrationId && request.method === "GET" && typeof payload === "string") {
          const status = JSON.parse(payload).result;
          if (
            status?.state === "succeeded" &&
            status.kind === "integration.install" &&
            status.result?.integrationId === cancelIntegrationId
          ) {
            const target = cancelIntegrationId;
            cancelIntegrationId = null;
            const [job] = await state.fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.type, "standalone.install"))
              .then((rows) =>
                rows.filter((row) => {
                  const sealed = (row.result as { _standalone?: { body?: string } } | null)
                    ?._standalone?.body;
                  return (
                    row.status === "running" &&
                    sealed &&
                    JSON.parse(sealed).inspection.integrationId === target
                  );
                }),
              );
            if (!job) throw Error("Missing exact published standalone job");
            await jobRunner.cancel(job.id);
          }
        }
        return payload;
      });
      cleanups.push(async () => {
        await agent.close();
        store.close();
      });
      vi.stubEnv("OPS_AGENT_URL", await agent.listen({ host: "127.0.0.1", port: 0 }));
      const app = Fastify({ logger: false });
      cleanups.push(() => app.close());
      const { initIntegrations, shutdownIntegrations } = await import("../../integration-host");
      await initIntegrations(app, [
        { directory: join(state.host.root, "custom_integrations"), isBuiltIn: false },
      ]);
      cleanups.push(() => shutdownIntegrations());
      const { adminStandaloneIntegrationsRoute } = await import(
        "../../routes/admin-standalone-integrations"
      );
      await app.register(adminStandaloneIntegrationsRoute, { prefix: "/api" });
      const handlers = await import("./install");
      ({ jobRunner } = await import("../job-runner"));
      jobRunner.register("standalone.preview", handlers.handleStandalonePreview);
      jobRunner.register("standalone.install", handlers.handleStandaloneInstall);
      apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    }, 120000);
    afterAll(async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
      vi.unstubAllEnvs();
    });
    const post = async (path: string, body: unknown, key: string) => {
      const response = await fetch(`${apiUrl}/api/admin/standalone-integrations/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          "x-openmapx-local-admin": "standalone-local-fixture",
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    async function completed(jobId: unknown, observe = false) {
      const deadline = Date.now() + 60000;
      for (;;) {
        if (observe) await jobRunner.reconcile();
        const [row] = await state.fixture.db
          .select()
          .from(schema.adminJob)
          .where(eq(schema.adminJob.id, String(jobId)));
        if (row && ["success", "failed", "canceled"].includes(row.status)) return row;
        if (Date.now() > deadline)
          throw Error(
            `Standalone job did not finish: ${row?.status} ${row?.error ?? ""} ${JSON.stringify(row?.result)}`,
          );
        await delay(50);
      }
    }
    async function upload(id: string) {
      const bytes = createDeterministicTarGz([
        {
          path: "manifest.json",
          contents: Buffer.from(
            JSON.stringify({
              id,
              name: "Uploaded fixture",
              version: "1.0.0",
              platform: "1.0",
              quality: "community",
              domains: ["map-overlay"],
            }),
          ),
        },
      ]);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const stage = await store.createStage({
        purpose: "integration-artifact",
        direction: "upload",
        ownerId: "loopback",
        operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
        declaredBytes: bytes.length,
        expectedSha256: digest,
      });
      await store.upload({
        stageId: stage.stageId,
        ownerId: "loopback",
        purpose: stage.purpose,
        attemptId: randomUUID(),
        deadlineAt: Date.now() + 60000,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      });
      return {
        stage,
        source: { kind: "uploaded-artifact", stageId: stage.stageId, expectedSha256: digest },
      };
    }
    it("publishes, actually reloads and atomically records uploaded provenance without an invented URL", async () => {
      const { stage, source } = await upload("standalone-http-fixture");
      const previewKey = randomUUID(),
        preview = await post("preview", { source }, previewKey);
      expect(preview.status, JSON.stringify(preview.body)).toBe(202);
      expect(await post("preview", { source }, previewKey)).toEqual(preview);
      expect(
        (
          await post(
            "preview",
            { source: { ...source, expectedSha256: "f".repeat(64) } },
            previewKey,
          )
        ).status,
      ).toBe(409);
      const previewJob = await completed(preview.body.jobId);
      expect(previewJob.status, previewJob.error ?? JSON.stringify(previewJob.result)).toBe(
        "success",
      );
      const inspection = previewJob.result as { inspectionId: string; contentDigest: string };
      const key = randomUUID(),
        request = {
          inspectionId: inspection.inspectionId,
          expectedContentDigest: inspection.contentDigest,
        };
      const accepted = await post("install", request, key);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
      const done = await completed(accepted.body.jobId);
      expect(done.status, done.error ?? JSON.stringify(done.result)).toBe("success");
      expect(await post("install", request, key)).toEqual(accepted);
      const [parent] = await state.fixture.db
        .select()
        .from(schema.installedExtension)
        .where(eq(schema.installedExtension.id, `local-${accepted.body.operationId}`));
      expect(parent).toMatchObject({
        installationKind: "standalone",
        sourceTrust: "community",
        sourceUrl: null,
        lastOperationId: accepted.body.operationId,
        provenance: {
          kind: "uploaded-artifact",
          stageId: stage.stageId,
          artifactSha256: source.expectedSha256,
          contentDigest: inspection.contentDigest,
        },
      });
      const [integration] = await state.fixture.db
        .select()
        .from(schema.installedIntegration)
        .where(eq(schema.installedIntegration.id, "standalone-http-fixture"));
      expect(integration).toMatchObject({
        repository: null,
        managedByExtension: parent!.id,
        sourceType: "uploaded-artifact",
      });
      expect(
        (
          await store.getStage({
            stageId: stage.stageId,
            ownerId: "loopback",
            purpose: stage.purpose,
          })
        ).state,
      ).toBe("consumed");
      const { getIntegration } = await import("../../integration-host");
      expect(getIntegration("standalone-http-fixture")?.manifest.version).toBe("1.0.0");
    }, 90000);
    it("adopts a lost admission response without publishing a second installation", async () => {
      const { stage, source } = await upload("standalone-lost-response");
      const preview = await post("preview", { source }, randomUUID()),
        previewJob = await completed(preview.body.jobId);
      expect(previewJob.status).toBe("success");
      const inspection = previewJob.result as { inspectionId: string; contentDigest: string };
      dropInstallResponse = true;
      const before = installPosts;
      const accepted = await post(
        "install",
        { inspectionId: inspection.inspectionId, expectedContentDigest: inspection.contentDigest },
        randomUUID(),
      );
      const done = await completed(accepted.body.jobId);
      expect(done.status, done.error ?? JSON.stringify(done.result)).toBe("success");
      expect(installPosts - before).toBe(1);
      expect(
        (
          await store.getStage({
            stageId: stage.stageId,
            ownerId: "loopback",
            purpose: stage.purpose,
          })
        ).state,
      ).toBe("consumed");
    }, 90000);
    it("restores a conclusively rolled-back database install and permits a new inspection of the same stage", async () => {
      const { stage, source } = await upload("standalone-rollback");
      const preview = await post("preview", { source }, randomUUID()),
        previewJob = await completed(preview.body.jobId);
      expect(previewJob.status).toBe("success");
      const inspection = previewJob.result as { inspectionId: string; contentDigest: string };
      await state.fixture
        .sql`alter table installed_integration add constraint fixture_reject_standalone check (id <> 'standalone-rollback')`;
      const accepted = await post(
        "install",
        { inspectionId: inspection.inspectionId, expectedContentDigest: inspection.contentDigest },
        randomUUID(),
      );
      const done = await completed(accepted.body.jobId);
      expect(done.status, done.error ?? JSON.stringify(done.result)).toBe("failed");
      expect(done.result).toMatchObject({ outcome: "restored" });
      expect(
        await state.fixture.db
          .select()
          .from(schema.installedExtension)
          .where(eq(schema.installedExtension.id, `local-${accepted.body.operationId}`)),
      ).toEqual([]);
      expect(
        (
          await store.getStage({
            stageId: stage.stageId,
            ownerId: "loopback",
            purpose: stage.purpose,
          })
        ).state,
      ).toBe("ready");
      const { getIntegration } = await import("../../integration-host");
      expect(getIntegration("standalone-rollback")).toBeUndefined();
      await state.fixture
        .sql`alter table installed_integration drop constraint fixture_reject_standalone`;
      const retry = await post("preview", { source }, randomUUID()),
        retryJob = await completed(retry.body.jobId);
      expect(retryJob.status, retryJob.error ?? JSON.stringify(retryJob.result)).toBe("success");
    }, 90000);

    it("keeps a published cancellation pending until exact restoration and stage release", async () => {
      const { stage, source } = await upload("standalone-cancel");
      const preview = await post("preview", { source }, randomUUID()),
        previewJob = await completed(preview.body.jobId);
      expect(previewJob.status).toBe("success");
      const inspection = previewJob.result as { inspectionId: string; contentDigest: string };
      cancelIntegrationId = "standalone-cancel";
      const accepted = await post(
        "install",
        { inspectionId: inspection.inspectionId, expectedContentDigest: inspection.contentDigest },
        randomUUID(),
      );
      for (let i = 0; i < 200 && cancelIntegrationId; i++) await delay(25);
      expect(cancelIntegrationId).toBeNull();
      await delay(1000);
      const [pending] = await state.fixture.db
        .select()
        .from(schema.adminJob)
        .where(eq(schema.adminJob.id, String(accepted.body.jobId)));
      expect(pending).toMatchObject({ status: "cancel_pending", finishedAt: null });
      expect(
        (
          await store.getStage({
            stageId: stage.stageId,
            ownerId: "loopback",
            purpose: stage.purpose,
          })
        ).state,
      ).toBe("claimed");
      // Real ownership lease expires; no fake clock or forced owner replacement.
      await delay(61000);
      await jobRunner.reconcile();
      const [restored] = await state.fixture.db
        .select()
        .from(schema.adminJob)
        .where(eq(schema.adminJob.id, String(accepted.body.jobId)));
      const { hasVerifiedStandaloneRestoration } = await import("./settlement-checkpoint");
      expect(await hasVerifiedStandaloneRestoration(restored!.result, restored!.id)).toBe(true);
      const forged = structuredClone(restored!.result) as { _standalone: { mac: string } };
      forged._standalone.mac = "0".repeat(64);
      expect(await hasVerifiedStandaloneRestoration(forged, restored!.id)).toBe(false);
      const done = await completed(accepted.body.jobId, true);
      expect(done.status, done.error ?? JSON.stringify(done.result)).toBe("canceled");
      expect(
        (
          await store.getStage({
            stageId: stage.stageId,
            ownerId: "loopback",
            purpose: stage.purpose,
          })
        ).state,
      ).toBe("ready");
      expect(
        await state.fixture.db
          .select()
          .from(schema.installedIntegration)
          .where(eq(schema.installedIntegration.id, "standalone-cancel")),
      ).toEqual([]);
    }, 150000);
  },
);
