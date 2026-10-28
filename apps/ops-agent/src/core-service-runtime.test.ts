import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeControlInstallation, openControlInstallation } from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownedServiceHost } from "./__fixtures__/owned-service-host";
import { openOpsJobJournal } from "./journal";
import { createProductionOpsRuntime } from "./production-runtime";
import { buildOpsAgentServer } from "./server";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const waitFor = async (condition: () => boolean) => {
  const end = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > end) throw Error("Restart did not reach Docker");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("production core restart workflow", () => {
  it.each([
    ["app-api", false],
    ["traefik", false],
    ["app-api", true],
  ] as const)(
    "keeps %s restart independent of the API observer (failure=%s)",
    async (serviceId, fail) => {
      const host = await ownedServiceHost();
      roots.push(host.cleanupRoot);
      await host.select(["app-api", "traefik"]);
      const compose = realpathSync(host.stack.composePath);
      const service = host.loaded.find((s) => s.manifest.id === serviceId)!;
      host.setRows([
        {
          ...host.row,
          ConfigImage: services.serviceContainerImageReference(service.manifest.container),
          Labels: {
            ...host.row.Labels,
            "com.docker.compose.service": serviceId,
            "com.docker.compose.project.working_dir": dirname(compose),
            "com.docker.compose.project.config_files": compose,
          },
        },
      ]);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const restarts: string[][] = [];
      const runtime = await createProductionOpsRuntime({
        rootDir: host.root,
        stack: host.stack,
        loadAuthority: host.loadAuthority,
        communityRepositories: host.repositories,
        docker: {
          fileExists: () => true,
          execFile: async (file, args, options) => {
            if (args[0] === "restart") {
              restarts.push([...args]);
              await held;
              if (fail) throw Error("Docker restart failed");
            }
            return host.execFile(file, args, options);
          },
        },
      });
      const installation = openControlInstallation({
        infraDir: host.infraDir,
        role: "ops-agent",
        serviceIds: host.loaded.map((s) => s.manifest.id),
      });
      const journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json"));
      const app = buildOpsAgentServer({
        tokens: { api: host.token, "data-manager": "d".repeat(32) },
        runtime,
        resourceClaimer: host.claimer,
        journal,
        controlInstallation: installation,
      });
      let submissions = 0,
        deletions = 0;
      app.addHook("preHandler", async (req) => {
        if (req.method === "DELETE") deletions++;
        if (
          req.method === "POST" &&
          (req.body as { operation?: { kind?: string } })?.operation?.kind === "coreService.restart"
        )
          submissions++;
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      const tokenFile = join(host.root, "api-token");
      writeFileSync(tokenFile, host.token, { mode: 0o600 });
      vi.stubEnv("OPS_AGENT_URL", `http://127.0.0.1:${address.port}`);
      vi.stubEnv("OPS_AGENT_TOKEN_FILE", tokenFile);
      vi.stubEnv("BETTER_AUTH_SECRET", "core-restart-test-only-000000000000000000000000");
      try {
        const headers = { authorization: `Bearer ${host.token}`, "x-ops-protocol-version": "2" };
        const submit = async (operation: Record<string, unknown>) => {
          const deadline = Date.now() + 60_000;
          return app.inject({
            method: "POST",
            url: "/v1/operations",
            headers,
            payload: {
              version: 2,
              requestId: `ops1_${randomBytes(16).toString("hex")}`,
              operationKey: createControlRootOperationKey({
                notAfter: deadline,
                nonce: randomBytes(16),
              }),
              issuedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 20_000).toISOString(),
              execution: { requestedDeadlineAt: deadline },
              operation,
            },
          });
        };
        for (const kind of ["service.stop", "service.restart", "service.update"]) {
          const denied = await submit({
            kind,
            serviceId,
            ...(kind === "service.update"
              ? {
                  expectedConfigurationRevisionId: services.currentConfigurationGeneration(
                    host.infraDir,
                  ),
                }
              : {}),
          });
          expect(denied.statusCode).toBe(403);
        }
        const stale = await submit({
          kind: "coreService.restart",
          serviceId,
          expectedConfigurationRevisionId: `cfg1_${"z".repeat(43)}`,
        });
        expect(stale.statusCode, stale.body).toBe(202);
        let staleStatus: { state?: string; errorClass?: string } = {};
        const until = Date.now() + 5_000;
        while (staleStatus.state !== "failed" && Date.now() < until) {
          staleStatus = (
            await app.inject({
              method: "GET",
              url: `/v1/operations/${stale.json().result.operationId}`,
              headers,
            })
          ).json().result;
          if (staleStatus.state !== "failed")
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(staleStatus).toMatchObject({ state: "failed", errorClass: "conflict" });
        expect(restarts).toEqual([]);
        submissions = 0;
        const { runCoreServiceMaintenance } = await import(
          "../../api/src/services/core-service-maintenance"
        );
        const { resumeAdminJobObservation } = await import("../../api/src/services/admin-job-ops");
        type JobContext = import("../../api/src/services/job-runner").JobContext;
        const controller = new AbortController();
        const ctx: JobContext = {
          jobId: randomUUID(),
          jobType: "service.core-restart",
          execution: { owner: randomUUID(), version: 1 },
          payload: { service: serviceId },
          signal: controller.signal,
          log: vi.fn(async () => {}),
          setProgress: vi.fn(async () => {}),
          checkpoint: async (value) => {
            ctx.checkpointResult = structuredClone(value);
          },
        };
        const first = runCoreServiceMaintenance(ctx).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await waitFor(() => restarts.length === 1);
        controller.abort();
        expect(await first).toHaveProperty("error");
        expect(deletions).toBe(0);
        const restored: JobContext = {
          ...ctx,
          execution: { owner: randomUUID(), version: 2 },
          signal: new AbortController().signal,
          observationOnly: true,
          checkpointResult: structuredClone(ctx.checkpointResult),
          checkpoint: async (value) => {
            restored.checkpointResult = structuredClone(value);
          },
        };
        release();
        if (fail) await expect(resumeAdminJobObservation(restored)).rejects.toBeDefined();
        else
          await expect(resumeAdminJobObservation(restored)).resolves.toMatchObject({
            service: serviceId,
            action: "restart",
          });
        expect(restarts).toEqual([["restart", "--time", "30", host.row.Id]]);
        expect(submissions).toBe(1);
        expect(deletions).toBe(0);
      } finally {
        release();
        await app.close();
        closeControlInstallation(installation);
      }
    },
    30_000,
  );
});
