import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import {
  createControlRootOperationKey,
  OpsClient,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { expect, it } from "vitest";
import { createDockerRuntime } from "./docker-runtime";
import { openOpsJobJournal } from "./journal";
import { createProductionRegistryResourceClaimer, denyAllTrustedOpsData } from "./policy";
import { buildOpsAgentServer } from "./server";

it.each(["succeeded", "canceled"] as const)(
  "owns the actual traffic target across its Docker adapter and HTTP cancellation (%s)",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "omx-traffic-target-")),
      data = join(root, "data");
    mkdirSync(data, { mode: 0o700 });
    await control.provisionControlInstallation(root);
    const installation = control.openControlInstallation({
        infraDir: root,
        role: "ops-agent",
        serviceIds: ["valhalla"],
      }),
      journal = await openOpsJobJournal(coreServices.agentStatePaths(root).journal);
    let ready = () => {},
      release = () => {},
      aborted = () => {},
      effects = 0;
    const started = new Promise<void>((resolve) => {
        ready = resolve;
      }),
      held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      canceled = new Promise<void>((resolve) => {
        aborted = resolve;
      });
    const runtime = createDockerRuntime({
        fileExists: existsSync,
        stack: {
          infraDir: root,
          composePath: join(root, "compose.yml"),
          composeReleasePath: join(root, "release.yml"),
        },
        execFile: async (_file, args, options) => {
          if (args.includes("valhalla_ways_to_edges")) {
            effects++;
            ready();
            options.signal.addEventListener("abort", aborted, { once: true });
            if (options.signal.aborted) aborted();
            await held;
          }
          return { stdout: "", stderr: "" };
        },
      }),
      token = "d".repeat(43),
      tokenFile = join(root, "token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const app = buildOpsAgentServer({
      runtime,
      journal,
      controlInstallation: installation,
      tokens: { api: "a".repeat(43), "data-manager": token },
      resourceClaimer: createProductionRegistryResourceClaimer({
        services: [{ serviceId: "valhalla", enabled: true, isBuiltIn: true }],
        integrationIds: [],
        trustedData: denyAllTrustedOpsData,
      }),
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw Error("Actual agent endpoint missing");
    const baseUrl = `http://127.0.0.1:${address.port}`,
      client = new OpsClient({ baseUrl, tokenFile });
    try {
      const operation = { kind: "valhalla.traffic.refreshWaysToEdges" as const },
        deadline = Date.now() + 60000,
        operationKey = createControlRootOperationKey({
          notAfter: deadline,
          nonce: randomBytes(16),
        }),
        admitted = await client.execute(operation, {
          operationKey,
          execution: { requestedDeadlineAt: deadline },
        });
      if (admitted.execution !== "async") throw Error("Async traffic root required");
      await started;
      expect(effects).toBe(1);
      expect(existsSync(join(data, ".admin-target-control/locks/valhalla"))).toBe(true);
      if (mode === "canceled") {
        const status = await client.status(operation.kind, admitted.operationId),
          lossy = new OpsClient({
            baseUrl,
            tokenFile,
            fetch: async (url, options) => {
              const response = await fetch(url, options);
              if (options?.method === "DELETE") {
                await response.body?.cancel();
                throw Error("Synthetic lost cancel response");
              }
              return response;
            },
          });
        await expect(
          lossy.cancel(admitted.operationId, { fingerprint: status.fingerprint }),
        ).rejects.toThrow();
        await canceled;
        expect((await client.status(operation.kind, admitted.operationId)).state).toBe(
          "termination_pending",
        );
        expect(existsSync(join(data, ".admin-target-control/locks/valhalla"))).toBe(true);
        if (!status.fingerprint || !status.deadlineAt)
          throw Error("Original dated traffic identity required");
        const authority = control.restoreAdmittedControlExecution(installation, {
          executor: "ops-agent",
          principal: "data-manager",
          executionId: admitted.operationId,
          operationKey,
          operationFingerprint: opsOperationFingerprint(operation),
          fingerprint: status.fingerprint,
          deadlineAt: status.deadlineAt,
        });
        expect(() => control.assertControlExecutionForward(authority)).toThrow();
        release();
        await expect
          .poll(async () => (await client.status(operation.kind, admitted.operationId)).state, {
            timeout: 10000,
          })
          .toBe("failed");
        expect(existsSync(join(data, ".admin-target-control/locks/valhalla"))).toBe(true);
      } else {
        release();
        await expect
          .poll(async () => (await client.status(operation.kind, admitted.operationId)).state, {
            timeout: 10000,
          })
          .toBe("succeeded");
        expect(existsSync(join(data, ".admin-target-control/locks/valhalla"))).toBe(false);
      }
    } finally {
      release();
      app.server.closeAllConnections();
      await app.close();
      control.closeControlInstallation(installation);
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
