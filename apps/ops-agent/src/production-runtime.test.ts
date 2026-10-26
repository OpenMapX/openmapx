import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
} from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey, type OpsOperation } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterEach, describe, expect, it } from "vitest";
import { ownedServiceHost } from "./__fixtures__/owned-service-host";
import { openOpsJobJournal } from "./journal";
import { dispatchOpsOperation } from "./runtime";
import { buildOpsAgentServer } from "./server";
import { initializeTrustedConfigurationRuntime } from "./trusted-config-runtime";

const roots: string[] = [];
async function fixture() {
  const host = await ownedServiceHost();
  roots.push(host.root);
  return host;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("assembled production service authority", () => {
  it("executes Stop and post-stop Logs for a deselected owned container through the installed adapters", async () => {
    const host = await fixture();
    await host.deselect();
    expect(host.calls.some((args) => args[0] === "stop")).toBe(false);
    const inspect = { kind: "services.inspect" } as const;
    const before = await dispatchOpsOperation(host.runtime, inspect, await host.context(inspect));
    const service = before.services.find((s) => s.serviceId === "motis");
    expect(service?.actions.stop.available).toBe(true);
    expect(service?.actions.logs.available).toBe(true);
    for (const action of ["start", "restart", "update", "build", "pull", "apply"] as const)
      expect(service?.actions[action]).toMatchObject({ available: false, reason: "disabled" });
    const stop = { kind: "service.stop", serviceId: "motis" } as const;
    await dispatchOpsOperation(host.runtime, stop, await host.context(stop));
    const logs = { kind: "service.logs", serviceId: "motis", tail: 20 } as const;
    expect(await dispatchOpsOperation(host.runtime, logs, await host.context(logs))).toEqual({
      lines: ["retained log"],
      truncated: false,
    });
    expect(host.calls).toContainEqual(["stop", host.row.Id]);
    expect(host.calls).toContainEqual(["logs", "--tail=20", host.row.Id]);
    const follow = {
      kind: "service.logs.follow",
      serviceId: "motis",
      tail: 20,
      maxDurationSeconds: 1,
    } as const;
    await expect(
      dispatchOpsOperation(host.runtime, follow, await host.context(follow)),
    ).resolves.toEqual({ lines: 1, truncated: false });
    expect(host.calls).toContainEqual(["logs", "--follow", "--tail=20", host.row.Id]);
    expect(host.calls.some((args) => args[0] === "compose" && args.includes("stop"))).toBe(false);
    expect(existsSync(host.firstCompose)).toBe(true);
    expect((await host.loadAuthority()).services.some((s) => s.manifest.id === "motis")).toBe(true);
  });

  it("authorizes deselected Stop and post-stop Logs through authenticated HTTP with original control authority", async () => {
    const host = await fixture();
    await host.deselect();
    mkdirSync(join(host.infraDir, "data"), { mode: 0o700 });
    await provisionControlInstallation(host.infraDir);
    const installation = openControlInstallation({
      infraDir: host.infraDir,
      role: "ops-agent",
      serviceIds: host.loaded.map((s) => s.manifest.id),
    });
    const journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json"));
    const app = buildOpsAgentServer({
      tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
      runtime: host.runtime,
      resourceClaimer: host.claimer,
      journal,
      controlInstallation: installation,
    });
    const headers = { authorization: `Bearer ${host.token}`, "x-ops-protocol-version": "2" };
    const requestedDeadlineAt = Date.now() + 60_000;
    let count = 0;
    const submit = (operation: OpsOperation) =>
      app.inject({
        method: "POST",
        url: "/v1/operations",
        headers,
        payload: {
          version: 2,
          requestId: `ops1_cleanupHttp${String(++count).padStart(12, "0")}`,
          operationKey: createControlRootOperationKey({
            notAfter: requestedDeadlineAt,
            nonce: randomBytes(16),
          }),
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 20_000).toISOString(),
          execution: { requestedDeadlineAt },
          operation,
        },
      });
    try {
      const admitted = await submit({ kind: "service.stop", serviceId: "motis" });
      expect(admitted.statusCode, admitted.body).toBe(202);
      const operationId = admitted.json().result.operationId;
      let status: { state: string; result?: unknown } = { state: "pending" };
      const until = Date.now() + 3_000;
      do {
        status = (
          await app.inject({ method: "GET", url: `/v1/operations/${operationId}`, headers })
        ).json().result;
        if (status.state !== "succeeded") await new Promise((resolve) => setTimeout(resolve, 10));
      } while (status.state !== "succeeded" && Date.now() < until);
      expect(status).toMatchObject({ state: "succeeded", result: { changed: true } });
      expect(journal.records()).toHaveLength(1);
      const logs = await submit({ kind: "service.logs", serviceId: "motis", tail: 20 });
      expect(logs.statusCode, logs.body).toBe(200);
      expect(logs.json().result.value.lines).toEqual(["retained log"]);
      expect(host.calls).toContainEqual(["stop", host.row.Id]);
      expect(host.calls).toContainEqual(["logs", "--tail=20", host.row.Id]);
    } finally {
      await app.close();
      closeControlInstallation(installation);
    }
  });

  it("preserves legacy retained generations at startup before the first owned inventory acquisition", async () => {
    const host = await fixture();
    for (let i = 0; i < 15; i++)
      await services.commitConfigurationGeneration({
        infraDir: host.infraDir,
        services: host.loaded,
        input: {
          domain: "example.test",
          selectedRoots: [],
          serviceConfigs: [],
          integrationConfigs: [],
          serviceSecrets: [],
        },
      });
    // Deployments predating owned retention have complete generations but no new metadata file.
    rmSync(join(host.infraDir, ".owned-service-generations.json"));
    await initializeTrustedConfigurationRuntime(host.infraDir);
    expect(existsSync(host.firstCompose)).toBe(true);
    const logs = { kind: "service.logs", serviceId: "motis", tail: 20 } as const;
    await expect(
      dispatchOpsOperation(host.runtime, logs, await host.context(logs)),
    ).resolves.toMatchObject({ lines: ["retained log"] });
  });

  it("retains the original generation for a live legacy current-alias container and releases it only after cleanup", async () => {
    const host = await fixture();
    host.row.Labels["com.docker.compose.project.config_files"] = host.stack.composePath;
    host.row.Labels["com.docker.compose.project.working_dir"] = host.stack.composePath.slice(
      0,
      host.stack.composePath.lastIndexOf("/"),
    );
    expect(await host.deselect()).toMatchObject({ outcome: "committed" });
    for (let i = 0; i < 18; i++)
      expect(await host.select([])).toMatchObject({ outcome: "committed" });
    expect(existsSync(host.firstCompose)).toBe(true);
    const logs = { kind: "service.logs", serviceId: "motis", tail: 20 } as const;
    await expect(
      dispatchOpsOperation(host.runtime, logs, await host.context(logs)),
    ).resolves.toMatchObject({ lines: ["retained log"] });
    host.row.Image = `sha256:${"c".repeat(64)}`;
    expect(await host.select([])).toMatchObject({ outcome: "committed" });
    expect(existsSync(host.firstCompose)).toBe(true);
    host.setRows([]);
    expect(await host.select([])).toMatchObject({ outcome: "committed" });
    expect(existsSync(host.firstCompose)).toBe(false);
    await expect(host.context(logs)).rejects.toThrow("Admission denied");
  });

  it("rechecks deselection after admission before invoking a lifecycle effect", async () => {
    const host = await fixture();
    const operation = { kind: "service.start", serviceId: "motis" } as const;
    const context = await host.context(operation);
    await host.deselect();
    await expect(dispatchOpsOperation(host.runtime, operation, context)).rejects.toThrow(
      "Service action denied",
    );
    expect(host.calls.some((args) => args.includes("up"))).toBe(false);
  });

  it("rechecks the admitted immutable ID before an enabled Restart", async () => {
    const host = await fixture();
    const operation = { kind: "service.restart", serviceId: "motis" } as const;
    const ctx = await host.context(operation);
    host.row.Id = "c".repeat(64);
    await expect(dispatchOpsOperation(host.runtime, operation, ctx)).rejects.toThrow(
      "Owned service claim changed",
    );
    expect(host.calls.some((args) => args.includes("restart"))).toBe(false);
  });

  it("keeps core workflows unavailable and dependency lifecycle host-only while permitting verified core logs", async () => {
    const host = await fixture();
    host.row.Labels["com.docker.compose.service"] = "ops-agent";
    host.row.ConfigImage = "example/ops-agent:1";
    const inspect = { kind: "services.inspect" } as const;
    const result = await dispatchOpsOperation(host.runtime, inspect, await host.context(inspect));
    const agent = result.services.find((s) => s.serviceId === "ops-agent");
    expect(agent?.actions.logs.available).toBe(true);
    expect(agent?.actions.stop).toMatchObject({ available: false, reason: "control_plane" });
    for (const id of ["app-api", "traefik"])
      expect(result.services.find((s) => s.serviceId === id)?.actions.restart).toMatchObject({
        available: false,
        execution: "workflow",
        reason: "unavailable",
        workflow: "core-restart",
      });
    for (const id of ["redis", "postgis"])
      expect(result.services.find((s) => s.serviceId === id)?.actions.stop).toMatchObject({
        available: false,
        execution: "host",
        reason: "host_only",
      });
    const logs = { kind: "service.logs", serviceId: "ops-agent", tail: 20 } as const;
    await expect(
      dispatchOpsOperation(host.runtime, logs, await host.context(logs)),
    ).resolves.toMatchObject({ lines: ["retained log"] });
  });

  it("refuses installed community removal until its stopped owned container is removed", async () => {
    const host = await fixture();
    const published = await host.repositories.publish(
      {
        kind: "serviceRepository.publish",
        url: "https://github.com/example/services",
        commit: "1".repeat(40),
        extensionId: "test-extension",
        recovery: {
          selectionBefore: ["motis"],
          touchedServiceIds: ["community-live"],
          previouslyEnabledServiceIds: [],
        },
      },
      new AbortController().signal,
    );
    await host.repositories.settle({
      kind: "serviceRepository.settle",
      repository: published.repository,
      transactionId: published.transactionId,
      outcome: "commit",
    });
    host.row.Labels["com.docker.compose.service"] = "community-live";
    host.row.ConfigImage = `example/community-live:1@sha256:${"b".repeat(64)}`;
    host.row.State = "exited";
    const remove = {
      kind: "serviceRepository.remove",
      repository: published.repository,
      extensionId: "test-extension",
    } as const;
    await expect(
      dispatchOpsOperation(host.runtime, remove, await host.context(remove)),
    ).rejects.toThrow("require cleanup");
    expect(
      (await host.loadAuthority()).services.some((s) => s.manifest.id === "community-live"),
    ).toBe(true);
    host.row.Image = `sha256:${"c".repeat(64)}`;
    await expect(
      dispatchOpsOperation(host.runtime, remove, await host.context(remove)),
    ).rejects.toThrow("provenance requires host cleanup");
    host.setMalformedInspect();
    await expect(
      dispatchOpsOperation(host.runtime, remove, await host.context(remove)),
    ).rejects.toThrow("inventory unavailable");
    host.setRows([]);
    await expect(
      dispatchOpsOperation(host.runtime, remove, await host.context(remove)),
    ).resolves.toMatchObject({ removed: true });
    expect(
      (await host.loadAuthority()).services.some((s) => s.manifest.id === "community-live"),
    ).toBe(false);
  });

  it("uses API-role synchronous inspection and rejects unauthenticated/data-manager requests without Docker I/O", async () => {
    const host = await fixture();
    const api = Buffer.alloc(32, 31).toString("base64url"),
      dm = Buffer.alloc(32, 32).toString("base64url");
    const app = buildOpsAgentServer({
      tokens: { api, "data-manager": dm },
      runtime: host.runtime,
      resourceClaimer: host.claimer,
    });
    const payload = {
      version: 2,
      requestId: "ops1_inspectionRole0000",
      operationKey: "opk1_inspectionRole0000",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
      operation: { kind: "services.inspect" },
    };
    const before = host.calls.length;
    try {
      for (const token of [undefined, dm]) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/operations",
          payload,
          headers: {
            "x-ops-protocol-version": "2",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        });
        expect(res.statusCode).toBe(token ? 403 : 401);
      }
      expect(host.calls).toHaveLength(before);
      const result = await app.inject({
        method: "POST",
        url: "/v1/operations",
        payload,
        headers: { "x-ops-protocol-version": "2", authorization: `Bearer ${api}` },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().result.value.services).toHaveLength(host.loaded.length);
    } finally {
      await app.close();
    }
  });

  it("keeps the production DM source, startup ordering and all installer calls in the actual entry point", () => {
    const entry = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(entry).toContain("createProductionOpsRuntime({");
    expect(entry).toContain(
      "createDataTransitTrustedOpsDataSource(\n            controlStartup.installation,",
    );
    expect(entry).toContain("createFileTrustedOpsDataSource({");
    expect(entry.indexOf("await communityRepositories.recover()")).toBeLessThan(
      entry.indexOf("const controlStartup ="),
    );
  });
});
