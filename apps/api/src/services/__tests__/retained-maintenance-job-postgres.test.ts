import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient } from "@openmapx/core";
import { clearAdminReleaseSelection, pullAdminServiceImages } from "@openmapx/core/api-admin-sdk";
import { closeControlInstallation, openControlInstallation } from "@openmapx/core/build-artifacts";
import { services } from "@openmapx/core/server";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ownedServiceHost } from "../../../../ops-agent/src/__fixtures__/owned-service-host";
import { openOpsJobJournal } from "../../../../ops-agent/src/journal";
import {
  createProductionOpsRuntime,
  productionOwnedServices,
} from "../../../../ops-agent/src/production-runtime";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import { adminJob, user } from "../../db/schema";
import {
  createAdminTestApp,
  installAdminRouteMocks,
} from "../../routes/__tests__/admin-test-helpers";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";

const state = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
  services: [] as services.LoadedService[],
}));
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
  getServiceRegistry: () => ({
    list: () => state.services,
    get: (id: string) => state.services.find((service) => service.manifest.id === id),
  }),
}));
const adminMocks = installAdminRouteMocks();

import { MaintenanceRequestConflict, retainMaintenanceJob } from "../retained-maintenance-job";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
dbDescribe("retained finite maintenance requests", () => {
  let root: string, actor: string;
  const acceptedIds: string[] = [];
  beforeAll(async () => {
    state.fixture = await createMigratedPostgresFixture();
    root = await mkdtemp(join(tmpdir(), "openmapx-maintenance-key-"));
    const token = join(root, "token");
    await writeFile(token, Buffer.alloc(32, 91).toString("base64url"), { mode: 0o600 });
    vi.stubEnv("OPS_AGENT_TOKEN_FILE", token);
    actor = randomUUID();
    adminMocks.session.user.id = actor;
    await state.fixture.db.insert(user).values({
      id: actor,
      email: `${actor}@example.test`,
      name: "Synthetic administrator",
      role: "admin",
    });
  }, 90000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await state.fixture?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const body = { expectedReleaseId: "checked-pin", confirmation: "CLEAR RELEASE PIN" };
  it("serializes competing requests and preserves terminal duplicates across a new call", async () => {
    const key = "same-release-intent-001",
      ids = await Promise.all(
        Array.from({ length: 3 }, () => retainMaintenanceJob("release.clear", body, actor, key)),
      );
    expect(new Set(ids).size).toBe(1);
    const id = ids[0]!;
    acceptedIds.push(id);
    await state.fixture.db
      .update(adminJob)
      .set({ status: "success", result: { cleared: true }, finishedAt: new Date() })
      .where(eq(adminJob.id, id));
    expect(await retainMaintenanceJob("release.clear", body, actor, key)).toBe(id);
    const [row] = await state.fixture.db.select().from(adminJob).where(eq(adminJob.id, id));
    expect(row?.status).toBe("success");
    expect(row?.result).toEqual({ cleared: true });
    await expect(
      retainMaintenanceJob(
        "release.clear",
        { ...body, expectedReleaseId: "changed-pin" },
        actor,
        key,
      ),
    ).rejects.toBeInstanceOf(MaintenanceRequestConflict);
  });
  it("allows only one changed-intent winner and scopes equal keys to the original actor", async () => {
    const key = "competing-release-intent-002",
      results = await Promise.allSettled([
        retainMaintenanceJob("release.clear", body, actor, key),
        retainMaintenanceJob(
          "release.clear",
          { ...body, expectedReleaseId: "other-pin" },
          actor,
          key,
        ),
      ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const other = randomUUID();
    await state.fixture.db.insert(user).values({
      id: other,
      email: `${other}@example.test`,
      name: "Other synthetic administrator",
      role: "admin",
    });
    for (const result of results) if (result.status === "fulfilled") acceptedIds.push(result.value);
    const otherId = await retainMaintenanceJob("release.clear", body, other, key);
    acceptedIds.push(otherId);
    expect(
      results.some((result) => result.status === "fulfilled" && result.value === otherId),
    ).toBe(false);
  });
  it("runs the real queued route and worker through the production agent, retaining the same job after success", async () => {
    await state.fixture.db
      .update(adminJob)
      .set({ status: "failed" })
      .where(inArray(adminJob.id, acceptedIds));
    const host = await ownedServiceHost();
    state.services = host.loaded;
    const installation = openControlInstallation({
      infraDir: host.infraDir,
      role: "ops-agent",
      serviceIds: host.loaded.map((s) => s.manifest.id),
    });
    const journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json"));
    const agent = buildOpsAgentServer({
      tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
      runtime: host.runtime,
      resourceClaimer: host.claimer,
      journal,
      controlInstallation: installation,
    });
    const manifest = services.parseReleaseManifest(
      JSON.stringify({
        schemaVersion: 1,
        release: "checked-pin",
        images: Object.fromEntries(
          services.RELEASE_IMAGE_NAMES.map((name) => [
            name,
            `ghcr.io/openmapx/${name}@sha256:${"a".repeat(64)}`,
          ]),
        ),
        privacyReleaseValidation: {
          version: 1,
          sourceBuildFingerprint: "a".repeat(64),
          validatedAt: "2026-10-30T00:00:00.000Z",
          checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
        },
      }),
    );
    const overlay = join(host.infraDir, "docker-compose.release.yml");
    services.writeReleaseComposeArtifacts(manifest, overlay);
    const tokenFile = join(host.root, "clear-api-token");
    writeFileSync(tokenFile, host.token, { mode: 0o600 });
    const agentUrl = await agent.listen({ host: "127.0.0.1", port: 0 });
    vi.stubEnv("OPS_AGENT_URL", agentUrl);
    vi.stubEnv("OPS_AGENT_TOKEN_FILE", tokenFile);
    vi.stubEnv("OPS_TRUSTED_CONFIG_DIR", host.queue);
    const { jobRunner } = await import("../job-runner"),
      { handleReleaseClearJob } = await import("../admin-release-controls"),
      { adminReleaseControlsRoute } = await import("../../routes/admin-release-controls");
    jobRunner.register("release.clear", handleReleaseClearJob);
    const api = await createAdminTestApp(adminReleaseControlsRoute, { prefix: "/api" });
    const url = await api.listen({ host: "127.0.0.1", port: 0 }),
      options = { client: createApiClient({ baseUrl: url }) };
    const pointer = services.currentConfigurationGeneration(host.infraDir),
      key = { "idempotency-key": "actual-clear-request-003" };
    try {
      const accepted = await clearAdminReleaseSelection(
        { expectedReleaseId: "checked-pin", confirmation: "CLEAR RELEASE PIN" },
        key,
        options,
      );
      expect(accepted.status).toBe(202);
      if (accepted.status !== 202) throw Error("Clear was not accepted");
      const id = accepted.data.jobId;
      await vi.waitFor(
        async () => {
          const [row] = await state.fixture.db.select().from(adminJob).where(eq(adminJob.id, id));
          expect(row?.status).toBe("success");
        },
        { timeout: 20000, interval: 100 },
      );
      expect(existsSync(overlay)).toBe(false);
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(pointer);
      expect(
        journal.records().filter((row) => row.operation.kind === "release.clear"),
      ).toHaveLength(1);
      const duplicate = await clearAdminReleaseSelection(
        { expectedReleaseId: "checked-pin", confirmation: "CLEAR RELEASE PIN" },
        key,
        options,
      );
      expect(duplicate.status).toBe(202);
      expect(duplicate.data).toEqual({ ok: true, jobId: id });
      expect(
        journal.records().filter((row) => row.operation.kind === "release.clear"),
      ).toHaveLength(1);
      expect(
        host.calls.some(
          (args) =>
            args[0] === "pull" ||
            args[0] === "run" ||
            args.includes("up") ||
            args.includes("restart"),
        ),
      ).toBe(false);
    } finally {
      await api.close();
      // The real runner schedules its final queue scan in a timer. Drain this
      // fixture's worker before closing its disposable SQL connection.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const worker = jobRunner as unknown as { active: Map<string, unknown>; pumping: boolean };
      await vi.waitFor(() => {
        expect(worker.active.size).toBe(0);
        expect(worker.pumping).toBe(false);
      });
      await agent.close();
      closeControlInstallation(installation);
      state.services = [];
      rmSync(host.cleanupRoot, { recursive: true, force: true });
    }
  }, 60000);
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "stages immutable images or refuses incompatible metadata without source writes (pinned=%s, invalidMetadata=%s)",
    async (pinned, invalidMetadata) => {
      vi.stubEnv("OPENMAPX_RELEASE", pinned ? "main" : "local");
      const ids = ["motis", "data-manager", "ops-agent"],
        host = await ownedServiceHost({
          withCoordinator: true,
          selectedRoots: ids,
          imageReferences: pinned
            ? undefined
            : {
                motis: { image: "example/shared", tag: "1" },
                "data-manager": { image: "example/shared", tag: "1" },
              },
        });
      state.services = host.loaded;
      const oldId = host.row.Image,
        newId = `sha256:${"e".repeat(64)}`,
        digest = `sha256:${"c".repeat(64)}`,
        stageCalls: string[][] = [];
      const compose = services.configurationGenerationComposeFile(
          host.infraDir,
          host.initial.revisionId,
        ),
        args = services.stackComposeArgs({
          infraDir: host.infraDir,
          composePath: compose,
          composeReleasePath: host.stack.composeReleasePath,
        });
      const rows = await Promise.all(
        ids.map(async (id, index) => ({
          ...host.row,
          Id: String(index + 1).repeat(64),
          ConfigImage: services.serviceContainerImageReference(
            host.loaded.find((service) => service.manifest.id === id)!.manifest.container,
          ),
          Labels: {
            ...host.row.Labels,
            "com.docker.compose.service": id,
            "com.docker.compose.config-hash": (
              await host.execFile("docker", [...args, "config", "--hash", id], {
                signal: new AbortController().signal,
                timeout: 15000,
                maxBuffer: 1024 * 1024,
              })
            ).stdout
              .trim()
              .split(/\s+/)
              .at(-1)!,
          },
        })),
      );
      host.setRows(rows);
      const overlay = join(host.infraDir, "docker-compose.release.yml");
      if (pinned)
        services.writeReleaseComposeArtifacts(
          services.parseReleaseManifest(
            JSON.stringify({
              schemaVersion: 1,
              release: "stage-pin",
              images: Object.fromEntries(
                services.RELEASE_IMAGE_NAMES.map((name) => [
                  name,
                  `ghcr.io/openmapx/${name}@sha256:${"a".repeat(64)}`,
                ]),
              ),
              privacyReleaseValidation: {
                version: 1,
                sourceBuildFingerprint: "a".repeat(64),
                validatedAt: "2026-10-30T00:00:00.000Z",
                checks: {
                  translationsConsistent: true,
                  openApiConsistent: true,
                  policyConsistent: true,
                },
              },
            }),
          ),
          overlay,
        );
      const beforeOverlay = existsSync(overlay) ? readFileSync(overlay, "utf8") : null;
      const execFile: typeof host.execFile = async (file, argv, io) => {
        stageCalls.push([...argv]);
        if (argv[0] === "info") return { stdout: "linux/amd64", stderr: "" };
        if (argv[0] === "manifest" && argv[1] === "inspect")
          return {
            stdout: JSON.stringify([
              {
                Descriptor: {
                  digest,
                  mediaType: "application/vnd.oci.image.manifest.v1+json",
                  platform: { architecture: invalidMetadata ? "riscv64" : "amd64", os: "linux" },
                },
              },
            ]),
            stderr: "",
          };
        if (argv[0] === "image" && argv[1] === "ls") return { stdout: oldId, stderr: "" };
        if (argv[0] === "image" && argv[1] === "inspect" && argv.at(-1)?.includes("@"))
          return { stdout: newId, stderr: "" };
        if (argv[0] === "image" && argv[1] === "pull")
          return { stdout: "Downloaded immutable image", stderr: "" };
        return host.execFile(file, argv, io);
      };
      const runtime = await createProductionOpsRuntime({
        rootDir: host.root,
        stack: host.stack,
        loadAuthority: host.loadAuthority,
        communityRepositories: host.repositories,
        candidateSource: {
          directory: host.queue,
          token: host.token,
          ownerUid: statSync(host.queue).uid,
          ownerGid: statSync(host.queue).gid,
        },
        docker: { execFile, fileExists: existsSync },
      });
      const installation = openControlInstallation({
          infraDir: host.infraDir,
          role: "ops-agent",
          serviceIds: host.loaded.map((service) => service.manifest.id),
        }),
        journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json"));
      const agent = buildOpsAgentServer({
        tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
        runtime,
        resourceClaimer: host.claimer,
        journal,
        controlInstallation: installation,
      });
      let lostAdmissionResponse = false;
      agent.addHook("onSend", async (request, reply, payload) => {
        const submitted = request.body as { operation?: { kind?: string } } | undefined;
        if (
          !lostAdmissionResponse &&
          request.method === "POST" &&
          reply.statusCode === 202 &&
          submitted?.operation?.kind === "service.image.stage"
        ) {
          lostAdmissionResponse = true;
          reply.code(503);
          return JSON.stringify({ error: "Synthetic lost admission response" });
        }
        return payload;
      });
      const agentUrl = await agent.listen({ host: "127.0.0.1", port: 0 }),
        tokenFile = join(host.root, "stage-api-token");
      writeFileSync(tokenFile, host.token, { mode: 0o600 });
      vi.stubEnv("OPS_AGENT_URL", agentUrl);
      vi.stubEnv("OPS_AGENT_TOKEN_FILE", tokenFile);
      vi.stubEnv("OPS_TRUSTED_CONFIG_DIR", host.queue);
      const { jobRunner } = await import("../job-runner"),
        { handleImageStageJob } = await import("../admin-image-staging"),
        { adminReleaseControlsRoute } = await import("../../routes/admin-release-controls");
      jobRunner.register("service.images.pull", handleImageStageJob);
      const api = await createAdminTestApp(adminReleaseControlsRoute, { prefix: "/api" }),
        url = await api.listen({ host: "127.0.0.1", port: 0 }),
        options = { client: createApiClient({ baseUrl: url }) },
        key = {
          "idempotency-key": `actual-stage-request-${pinned ? "pinned" : "floating"}-${invalidMetadata ? "invalid" : "valid"}-004`,
        };
      try {
        const accepted = await pullAdminServiceImages({ serviceIds: ids }, key, options);
        expect(accepted.status).toBe(202);
        if (accepted.status !== 202) throw Error("Stage was not accepted");
        const id = accepted.data.jobId;
        await vi.waitFor(
          async () => {
            const [row] = await state.fixture.db.select().from(adminJob).where(eq(adminJob.id, id));
            expect(["success", "failed"]).toContain(row?.status);
          },
          { timeout: 20000, interval: 100 },
        );
        const [finished] = await state.fixture.db
          .select()
          .from(adminJob)
          .where(eq(adminJob.id, id));
        expect(lostAdmissionResponse).toBe(true);
        expect(
          finished?.status,
          JSON.stringify({
            error: finished?.error,
            batch: (finished?.result as Record<string, unknown>)?.serviceBatch,
            records: journal.records().map((job) => ({
              kind: job.operation.kind,
              serviceId: "serviceId" in job.operation ? job.operation.serviceId : null,
              state: job.state,
              errorClass: job.errorClass,
            })),
            calls: stageCalls.filter((argv) =>
              ["manifest", "info", "image"].includes(argv[0] ?? ""),
            ),
          }),
        ).toBe(invalidMetadata ? "failed" : "success");
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        expect(existsSync(overlay) ? readFileSync(overlay, "utf8") : null).toBe(beforeOverlay);
        const pulls = stageCalls.filter((argv) => argv[0] === "image" && argv[1] === "pull");
        expect(pulls).toHaveLength(invalidMetadata ? 0 : 3);
        expect(pulls.every((argv) => /@sha256:[a-f0-9]{64}$/.test(argv[2] ?? ""))).toBe(true);
        expect(
          stageCalls.some(
            (argv) =>
              argv[0] === "run" ||
              argv.includes("up") ||
              argv.includes("restart") ||
              argv[0] === "tag",
          ),
        ).toBe(false);
        if (!pinned) {
          const owned = await productionOwnedServices(runtime).inspectOwnedServices(
            new AbortController().signal,
          );
          expect(
            ids.every((serviceId) =>
              owned.some(
                (container) =>
                  container.serviceId === serviceId && container.provenance.imageId === oldId,
              ),
            ),
          ).toBe(true);
        }
        const duplicate = await pullAdminServiceImages({ serviceIds: ids }, key, options);
        expect(duplicate.status).toBe(202);
        expect(duplicate.data).toEqual({ ok: true, jobId: id });
        expect(stageCalls.filter((argv) => argv[0] === "image" && argv[1] === "pull")).toHaveLength(
          invalidMetadata ? 0 : 3,
        );
        expect(
          journal.records().filter((job) => job.operation.kind === "service.image.stage"),
        ).toHaveLength(invalidMetadata ? 1 : 3);
      } finally {
        await api.close();
        await new Promise((resolve) => setTimeout(resolve, 25));
        const worker = jobRunner as unknown as { active: Map<string, unknown>; pumping: boolean };
        await vi.waitFor(() => {
          expect(worker.active.size).toBe(0);
          expect(worker.pumping).toBe(false);
        });
        await agent.close();
        closeControlInstallation(installation);
        state.services = [];
        rmSync(host.cleanupRoot, { recursive: true, force: true });
      }
    },
    60000,
  );
});
