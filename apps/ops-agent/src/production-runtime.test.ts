import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
} from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey, type OpsOperation } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { installedCompose } from "../../../packages/core/src/services/__fixtures__/compose-path-host";
import { ownedComposePathRuntime } from "./__fixtures__/owned-compose-path-runtime";
import { ownedServiceHost } from "./__fixtures__/owned-service-host";
import { createAgentHandoffBindings, createDefaultReleaseEffects } from "./administrative-runtime";
import { agentHandoffPath, readAgentHandoff, writeAgentHandoff } from "./agent-handoff";
import { startOpsAgentServer } from "./bootstrap";
import { runContainedProcess } from "./docker-runtime";
import { openOpsJobJournal } from "./journal";
import { createProductionOpsRuntime, productionReleaseEffects } from "./production-runtime";
import { dispatchOpsOperation, OpsNotWiredError } from "./runtime";
import { buildOpsAgentServer } from "./server";
import { initializeTrustedConfigurationRuntime } from "./trusted-config-runtime";

const roots: string[] = [];
async function fixture(options: Parameters<typeof ownedServiceHost>[0] = {}) {
  const host = await ownedServiceHost(options);
  roots.push(host.root);
  return host;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("assembled production service authority", () => {
  it.each(["1", "old", undefined])(
    "reports guarded maintenance readiness from the actual helper image (%s)",
    async (version) => {
      const ids = ["motis", "data-manager", "ops-agent"];
      const host = await fixture({
        withCoordinator: true,
        configurationHelperVersion: version,
        selectedRoots: ids,
      });
      host.setRows(
        ids.map((id, index) => ({
          ...host.row,
          Id: String(index + 1).repeat(64),
          ConfigImage: services.serviceContainerImageReference(
            host.loaded.find((service) => service.manifest.id === id)!.manifest.container,
          ),
          Labels: { ...host.row.Labels, "com.docker.compose.service": id },
        })),
      );
      const effects = productionReleaseEffects(host.runtime);
      const io = { signal: new AbortController().signal, emitLog() {} };
      const before = services.currentConfigurationGeneration(host.infraDir);
      await expect(effects.inspectSystem(io)).resolves.toMatchObject({
        maintenanceReady: version === "1",
      });
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(before);
      expect(
        host.calls.some((args) => args[0] === "run" || args.includes("up") || args[0] === "pull"),
      ).toBe(false);
      if (version === "1") {
        host.setServiceState("data-manager", "exited");
        await expect(effects.inspectSystem(io)).resolves.toMatchObject({ maintenanceReady: false });
        host.setServiceState("data-manager", "running");
        const path = join(services.releaseStatePaths(host.infraDir).store, "transaction.json");
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, "{}", { mode: 0o600 });
        await expect(effects.inspectSystem(io)).resolves.toMatchObject({ maintenanceReady: false });
        expect(readFileSync(path, "utf8")).toBe("{}");
      }
    },
  );

  it("clears only the exact selected pin through the production runtime without Docker mutation", async () => {
    const host = await fixture(),
      path = services.releaseStatePaths(host.infraDir).overlay;
    const manifest = {
      schemaVersion: 1 as const,
      release: "checked-pin",
      images: Object.fromEntries(
        services.RELEASE_IMAGE_NAMES.map((name) => [
          name,
          `ghcr.io/openmapx/${name}@sha256:${"a".repeat(64)}`,
        ]),
      ),
      privacyReleaseValidation: {
        version: 1 as const,
        sourceBuildFingerprint: "a".repeat(64),
        validatedAt: "2026-09-05T12:00:00.000Z",
        checks: {
          translationsConsistent: true as const,
          openApiConsistent: true as const,
          policyConsistent: true as const,
        },
      },
    };
    services.writeReleaseComposeArtifacts(manifest as services.ReleaseManifest, host.infraDir);
    expect(await productionReleaseEffects(host.runtime).inspect()).toMatchObject({
      selectedReleaseId: "checked-pin",
    });
    const before = readFileSync(path, "utf8"),
      pointer = services.currentConfigurationGeneration(host.infraDir);
    const changed = { kind: "release.clear", releaseId: "different-pin" } as OpsOperation;
    await expect(
      dispatchOpsOperation(host.runtime, changed, await host.context(changed)),
    ).rejects.toThrow(/changed/);
    expect(readFileSync(path, "utf8")).toBe(before);
    const operation = { kind: "release.clear", releaseId: "checked-pin" } as OpsOperation;
    expect(
      await dispatchOpsOperation(host.runtime, operation, await host.context(operation)),
    ).toEqual({ releaseId: "checked-pin", cleared: true });
    expect(existsSync(path)).toBe(false);
    expect(services.currentConfigurationGeneration(host.infraDir)).toBe(pointer);
    expect(
      host.calls.some(
        (args) =>
          args[0] === "pull" ||
          args[0] === "run" ||
          args.includes("up") ||
          args.includes("restart"),
      ),
    ).toBe(false);
  });
  it("refuses unsupported legacy release mutation without staging and keeps inspection available", async () => {
    const host = await fixture();
    const effects = productionReleaseEffects(host.runtime);
    const io = { signal: new AbortController().signal, emitLog() {} };
    const before = services.currentConfigurationGeneration(host.infraDir);
    host.calls.length = 0;
    await expect(effects.apply("release-unavailable", ["app-api"], io)).rejects.toBeInstanceOf(
      OpsNotWiredError,
    );
    await expect(
      effects.updateAgent?.(
        {
          releaseId: "release-unavailable",
          expectedDigest: "a".repeat(64),
          handoffId: "handoff-unavailable",
          otherActiveOperations: 0,
        },
        io,
      ),
    ).rejects.toBeInstanceOf(OpsNotWiredError);
    await expect(
      dispatchOpsOperation(
        host.runtime,
        {
          kind: "system.update",
          releaseId: "release-unavailable",
          expectedDigest: "a".repeat(64),
          createBackup: true,
          backupId: "unavailable-backup",
        },
        await host.context({ kind: "configuration.inspect" }),
      ),
    ).rejects.toBeInstanceOf(OpsNotWiredError);
    expect(
      host.calls.every(
        (args) =>
          (args[0] === "container" && ["ls", "inspect"].includes(args[1] ?? "")) ||
          (args[0] === "image" && args[1] === "inspect") ||
          (args[0] === "compose" && args.includes("config")),
      ),
    ).toBe(true);
    expect(
      existsSync(join(services.releaseStatePaths(host.infraDir).store, "transaction.json")),
    ).toBe(false);
    expect(existsSync(agentHandoffPath(host.root))).toBe(false);
    expect(services.currentConfigurationGeneration(host.infraDir)).toBe(before);
    await expect(effects.inspect()).resolves.toBeDefined();
    await expect(effects.runtimeInspect?.()).resolves.toEqual({});
    await expect(effects.inspectSystem(io)).resolves.toMatchObject({ maintenanceReady: false });
  });

  it("production helper entry and write bindings preserve original handoff evidence", async () => {
    const host = await fixture();
    const record = {
      version: 1 as const,
      handoffId: "handoff-unavailable",
      releaseId: "release-unavailable",
      digest: "a".repeat(64),
      phase: "launched" as const,
      previousOverlay: "previous\n",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
    };
    mkdirSync(dirname(agentHandoffPath(host.root)), { recursive: true, mode: 0o700 });
    writeAgentHandoff(host.root, record);
    const path = agentHandoffPath(host.root),
      bytes = readFileSync(path);
    const bindings = createAgentHandoffBindings(host.root);
    expect(() => bindings.writeOverlay(record.releaseId, record.digest)).toThrow(OpsNotWiredError);
    expect(() => bindings.restoreOverlay(record.previousOverlay)).toThrow(OpsNotWiredError);
    expect(() => bindings.assertAvailable()).toThrow(OpsNotWiredError);
    const entry = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx/esm"),
        fileURLToPath(new URL("./agent-handoff-main.ts", import.meta.url)),
      ],
      {
        env: {
          ...process.env,
          OPENMAPX_ROOT_DIR: host.root,
          OPS_AGENT_HANDOFF_ID: record.handoffId,
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    expect(entry.status, entry.stderr).toBe(1);
    expect(entry.stderr).toContain("Typed adapter is not wired");
    expect(readFileSync(path)).toEqual(bytes);
    expect(readAgentHandoff(host.root)).toEqual(record);
    expect(existsSync(host.stack.composeReleasePath)).toBe(false);
  });

  it("production startup preserves actual interrupted legacy transaction and handoff while reads remain available", async () => {
    const host = await fixture();
    const directory = services.releaseStatePaths(host.infraDir).store;
    const manifest = services.parseReleaseManifest(
      JSON.stringify({
        schemaVersion: 1,
        release: "release-legacy",
        images: Object.fromEntries(
          services.RELEASE_IMAGE_NAMES.map((name) => [
            name,
            `ghcr.io/openmapx/${name}@sha256:${"a".repeat(64)}`,
          ]),
        ),
        privacyReleaseValidation: {
          version: 1,
          sourceBuildFingerprint: "a".repeat(64),
          validatedAt: "2026-09-05T12:00:00.000Z",
          checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
        },
      }),
    );
    writeFileSync(
      join(directory, "release-legacy.json"),
      services.canonicalReleaseManifest(manifest),
      { mode: 0o600 },
    );
    const legacy = createDefaultReleaseEffects(
      host.root,
      async () => {
        throw Error("No CLI expected before prepared");
      },
      {
        afterReleasePhase(phase) {
          if (phase === "prepared") throw Error("actual legacy prepared interruption");
        },
      },
    );
    await expect(
      legacy.apply(
        manifest.release,
        ["app-api"],
        await host.context({ kind: "configuration.inspect" }),
      ),
    ).rejects.toThrow("actual legacy prepared interruption");
    mkdirSync(dirname(agentHandoffPath(host.root)), { recursive: true, mode: 0o700 });
    writeAgentHandoff(host.root, {
      version: 1,
      handoffId: "handoff-legacy",
      releaseId: manifest.release,
      digest: "a".repeat(64),
      phase: "overlay_written",
      previousOverlay: null,
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
    });
    const transaction = join(directory, "transaction.json"),
      handoff = agentHandoffPath(host.root);
    const before = [readFileSync(transaction), readFileSync(handoff)];
    const restarted = await createProductionOpsRuntime({
      rootDir: host.root,
      stack: host.stack,
      loadAuthority: host.loadAuthority,
      communityRepositories: host.repositories,
      docker: { execFile: host.execFile, fileExists: existsSync },
    });
    const effects = productionReleaseEffects(restarted);
    host.calls.length = 0;
    await expect(effects.initialize?.()).rejects.toMatchObject({ errorClass: "recovery_required" });
    await expect(effects.inspect()).resolves.toMatchObject({
      availableReleaseId: manifest.release,
    });
    await expect(effects.runtimeInspect?.()).resolves.toEqual({});
    await expect(effects.inspectAgentHandoff?.("handoff-legacy")).resolves.toMatchObject({
      phase: "overlay_written",
    });
    expect([readFileSync(transaction), readFileSync(handoff)]).toEqual(before);
    expect(host.calls).toEqual([]);
    const app = await startOpsAgentServer(
      {
        tokens: {
          api: Buffer.alloc(32, 1).toString("base64url"),
          "data-manager": Buffer.alloc(32, 2).toString("base64url"),
        },
        runtime: restarted,
        resourcePolicy: { allowGlobal: () => true, allowService: () => true },
      },
      effects,
      { host: "127.0.0.1", port: 0 },
    );
    try {
      expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({
        ok: true,
        releaseRecovery: { ready: false, reason: "recovery_required" },
      });
      expect([readFileSync(transaction), readFileSync(handoff)]).toEqual(before);
    } finally {
      await app.close();
    }
  });
  it("production service.update pulls then prepares and recreates", async () => {
    const host = await fixture({
      defaultCliEntry: fileURLToPath(new URL("./index.ts", import.meta.url)),
      actualComposeConfig: true,
    });
    const bin = join(host.root, "fake-bin"),
      trace = join(host.root, "docker-trace.jsonl");
    mkdirSync(bin);
    const docker = join(bin, "docker"),
      realDocker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
    writeFileSync(
      docker,
      `#!${process.execPath}\nconst fs=require("node:fs"),cp=require("node:child_process"),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(a)+"\\n");if(a[0]==="compose"&&a.includes("config")){const r=cp.spawnSync(${JSON.stringify(realDocker)},a,{encoding:"utf8"});process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");process.exit(r.status??1);}\n`,
      { mode: 0o700 },
    );
    chmodSync(docker, 0o700);
    for (const [key, value] of Object.entries({
      PATH: `${bin}:${process.env.PATH}`,
      OPENMAPX_ROOT_DIR: host.root,
      OPENMAPX_RELEASE: "local",
      DOMAIN: "example.test",
      POSTGRES_PASSWORD: "p".repeat(24),
      BETTER_AUTH_SECRET: "a".repeat(32),
      DATA_MANAGER_AUTH_TOKEN: "d".repeat(32),
      OPENMAPX_ENABLED_SERVICES: "",
    }))
      vi.stubEnv(key, value);
    const installation = openControlInstallation({
      infraDir: host.infraDir,
      role: "ops-agent",
      serviceIds: host.loaded.map((s) => s.manifest.id),
    });
    const journal = await openOpsJobJournal(services.agentStatePaths(host.infraDir).journal);
    const app = buildOpsAgentServer({
      tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
      runtime: host.runtime,
      resourceClaimer: host.claimer,
      journal,
      controlInstallation: installation,
    });
    const operation = {
      kind: "service.update",
      serviceId: "motis",
      expectedConfigurationRevisionId: host.initial.revisionId,
    } as const;
    const requestedDeadlineAt = Date.now() + 90000,
      headers = { authorization: `Bearer ${host.token}`, "x-ops-protocol-version": "2" };
    try {
      const submitted = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers,
        payload: {
          version: 2,
          requestId: "ops1_productionUpdate0000001",
          operationKey: createControlRootOperationKey({
            notAfter: requestedDeadlineAt,
            nonce: randomBytes(16),
          }),
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 20000).toISOString(),
          execution: { requestedDeadlineAt },
          operation,
        },
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      const id = submitted.json().result.operationId,
        until = Date.now() + 45000;
      let status: {
        state: string;
        result?: { changed: boolean; revisionId: string };
        failureResult?: unknown;
      } = { state: "pending" };
      do {
        status = (await app.inject({ method: "GET", url: `/v1/operations/${id}`, headers })).json()
          .result;
        if (!["succeeded", "failed", "timed_out"].includes(status.state))
          await new Promise((resolve) => setTimeout(resolve, 20));
      } while (!["succeeded", "failed", "timed_out"].includes(status.state) && Date.now() < until);
      expect(status).toMatchObject({
        state: "succeeded",
        result: { changed: true, revisionId: expect.stringMatching(/^cfg1_/) },
      });
      expect(status.result?.revisionId).toBe(
        services.currentConfigurationGeneration(host.infraDir),
      );
      expect(status.result?.revisionId).not.toBe(host.initial.revisionId);
      const calls = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const effects = calls.filter(
        (args) => args.includes("pull") || args.includes("--force-recreate"),
      );
      expect(effects).toHaveLength(2);
      expect(effects[0]!.slice(-2)).toEqual(["pull", "motis"]);
      expect(effects[1]!.slice(-4)).toEqual(["up", "-d", "--force-recreate", "motis"]);
      expect(calls.some((args) => args.includes("config"))).toBe(true);
      expect(
        JSON.parse(
          readFileSync(
            services.currentConfigurationFile(host.infraDir, services.SERVICE_SELECTION_FILE),
            "utf8",
          ),
        ).selected,
      ).toContain("motis");
    } finally {
      await app.close();
      closeControlInstallation(installation);
    }
  }, 60000);
  it("refuses a declared indirect coordinator recreation at actual production registry admission", async () => {
    const host = await fixture({
        withCoordinator: true,
        coordinatorDependency: true,
        actualComposeConfig: true,
      }),
      operation = {
        kind: "service.start",
        serviceId: "motis",
        expectedConfigurationRevisionId: host.initial.revisionId,
      } as const;
    const claim = await host.claimer.claim(
      operation,
      (await import("@openmapx/core/ops")).opsOperationFingerprint(operation),
      new AbortController().signal,
      {
        role: "api",
        operationKey: (await import("./__fixtures__/execution")).testExecution().operationKey,
      },
    );
    expect(claim).toBeNull();
    const inspect = { kind: "services.inspect" } as const,
      status = await dispatchOpsOperation(host.runtime, inspect, await host.context(inspect)),
      motis = status.services.find((service) => service.serviceId === "motis");
    for (const action of ["start", "apply", "update"] as const)
      expect(motis?.actions[action]).toMatchObject({ available: false, reason: "unavailable" });
    expect(host.calls.some((args) => args.includes("up") || args.includes("pull"))).toBe(false);
  }, 60000);
  it("refuses a foreign native Compose dependency before an actual normal Start can recreate the coordinator", async () => {
    const host = await fixture({ withCoordinator: true, actualComposeConfig: true }),
      compose = parseYaml(readFileSync(host.firstCompose, "utf8"));
    compose.services.motis.depends_on = {
      "data-manager": { condition: "service_started", required: true },
    };
    writeFileSync(host.firstCompose, JSON.stringify(compose));
    mkdirSync(join(host.infraDir, "data/ops-agent"), { recursive: true, mode: 0o700 });
    const installation = openControlInstallation({
        infraDir: host.infraDir,
        role: "ops-agent",
        serviceIds: host.loaded.map((service) => service.manifest.id),
      }),
      app = buildOpsAgentServer({
        tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
        runtime: host.runtime,
        resourceClaimer: host.claimer,
        journal: await openOpsJobJournal(services.agentStatePaths(host.infraDir).journal),
        controlInstallation: installation,
      }),
      deadline = Date.now() + 60000,
      headers = { authorization: `Bearer ${host.token}`, "x-ops-protocol-version": "2" };
    try {
      const submitted = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers,
        payload: {
          version: 2,
          requestId: "ops1_indirectCoordinator0001",
          operationKey: createControlRootOperationKey({
            notAfter: deadline,
            nonce: randomBytes(16),
          }),
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 20000).toISOString(),
          execution: { requestedDeadlineAt: deadline },
          operation: {
            kind: "service.start",
            serviceId: "motis",
            expectedConfigurationRevisionId: host.initial.revisionId,
          },
        },
      });
      expect(submitted.statusCode).toBe(202);
      let state = "queued";
      const until = Date.now() + 45000;
      while (!["succeeded", "failed", "timed_out"].includes(state)) {
        state = (
          await app.inject({
            method: "GET",
            url: `/v1/operations/${submitted.json().result.operationId}`,
            headers,
          })
        ).json().result.state;
        if (Date.now() > until) throw Error("Actual indirect Start did not settle");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(state).toBe("failed");
      expect(host.calls.some((args) => args.includes("up"))).toBe(false);
    } finally {
      await app.close();
      closeControlInstallation(installation);
    }
  }, 60000);
  it("refuses a prepared Start after a competing generation before any up effect", async () => {
    const host = await fixture();
    const operation = {
      kind: "service.start",
      serviceId: "motis",
      expectedConfigurationRevisionId: host.initial.revisionId,
    } as const;
    const context = await host.context(operation);
    expect(await host.select(["motis"])).toMatchObject({ outcome: "committed" });
    host.calls.length = 0;
    await expect(dispatchOpsOperation(host.runtime, operation, context)).rejects.toMatchObject({
      errorClass: "conflict",
    });
    expect(host.calls.some((args) => args.includes("up"))).toBe(false);
  });
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
    mkdirSync(join(host.infraDir, "data"), { mode: 0o700, recursive: true });
    await provisionControlInstallation(host.infraDir);
    const installation = openControlInstallation({
      infraDir: host.infraDir,
      role: "ops-agent",
      serviceIds: host.loaded.map((s) => s.manifest.id),
    });
    const journal = await openOpsJobJournal(services.agentStatePaths(host.infraDir).journal);
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
    const operation = {
      kind: "service.start",
      serviceId: "motis",
      expectedConfigurationRevisionId: services.currentConfigurationGeneration(host.infraDir)!,
    } as const;
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

  it("requires core selection and keeps dependency lifecycle host-only while permitting verified core logs", async () => {
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
        reason: "disabled",
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

async function installedCommunity() {
  const host = await fixture({ actualComposeConfig: true });
  host.setRows([]);
  const publication = await host.repositories.publish(
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
    repository: publication.repository,
    transactionId: publication.transactionId,
    outcome: "commit",
  });
  expect(await host.select(["community-live"])).toMatchObject({ outcome: "committed" });
  const remove = {
    kind: "serviceRepository.remove",
    repository: publication.repository,
    extensionId: "test-extension",
  } as const;
  const start = {
    kind: "service.start",
    serviceId: "community-live",
    expectedConfigurationRevisionId: services.currentConfigurationGeneration(host.infraDir)!,
  } as const;
  const checkout = join(services.agentStatePaths(host.infraDir).community, publication.repository);
  const record = join(
    services.agentStatePaths(host.infraDir).community,
    `.repository-${publication.repository}.json`,
  );
  const create = () => {
    const file = realpathSync(host.stack.composePath);
    host.setRows([
      {
        ...host.row,
        Id: "c".repeat(64),
        State: "running",
        ConfigImage: `example/community-live:1@sha256:${"b".repeat(64)}`,
        Labels: {
          ...host.row.Labels,
          "com.docker.compose.service": "community-live",
          "com.docker.compose.project.working_dir": dirname(file),
          "com.docker.compose.project.config_files": file,
        },
      },
    ]);
  };
  return { host, start, remove, checkout, record, create };
}
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
describe("assembled lifecycle/removal exclusion", () => {
  it("fences selected dependencies created by another service's Compose Start", async () => {
    const { host, remove, checkout, create } = await installedCommunity();
    await host.select(["motis", "community-live"]);
    writeFileSync(
      host.stack.composeReleasePath,
      "services:\n  motis:\n    depends_on:\n      community-live:\n        condition: service_started\n",
    );
    const start = {
      kind: "service.start",
      serviceId: "motis",
      expectedConfigurationRevisionId: services.currentConfigurationGeneration(host.infraDir)!,
    } as const;
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    host.setCreatingProcess(async () => {
      entered.resolve();
      await finish.promise;
      create();
    });
    const starting = dispatchOpsOperation(host.runtime, start, await host.context(start));
    await entered.promise;
    const removing = dispatchOpsOperation(host.runtime, remove, await host.context(remove)).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await drain();
      expect(existsSync(checkout), "Compose can also create the selected dependency").toBe(true);
      finish.resolve();
      await starting;
      expect("error" in (await removing)).toBe(true);
    } finally {
      finish.resolve();
      await starting.catch(() => undefined);
      await removing;
    }
  });

  it("retains authority throughout a community Start process and renewed removal inventory", async () => {
    const { host, start, remove, checkout, record, create } = await installedCommunity();
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    host.setCreatingProcess(async () => {
      entered.resolve();
      await finish.promise;
      create();
    });
    const starting = dispatchOpsOperation(host.runtime, start, await host.context(start));
    await entered.promise;
    let removed = false;
    const removing = dispatchOpsOperation(host.runtime, remove, await host.context(remove))
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        removed = true;
      });
    try {
      await drain();
      expect(
        existsSync(checkout),
        "checkout cannot disappear while Start's real process is pending",
      ).toBe(true);
      expect(existsSync(record)).toBe(true);
      expect(removed).toBe(false);
      finish.resolve();
      await starting;
      const outcome = await removing;
      expect(
        "error" in outcome &&
          outcome.error instanceof Error &&
          outcome.error.message.includes("require cleanup"),
      ).toBe(true);
      const stop = { kind: "service.stop", serviceId: "community-live" } as const;
      await dispatchOpsOperation(host.runtime, stop, await host.context(stop));
      const logs = { kind: "service.logs", serviceId: "community-live", tail: 20 } as const;
      await expect(
        dispatchOpsOperation(host.runtime, logs, await host.context(logs)),
      ).resolves.toMatchObject({ lines: ["retained log"] });
    } finally {
      finish.resolve();
      await starting.catch(() => undefined);
      await removing;
    }
  });

  it("revalidates a previously admitted Start after removal wins the same boundary", async () => {
    const { host, start, remove, checkout, create } = await installedCommunity();
    const startContext = await host.context(start),
      removeContext = await host.context(remove);
    const stackStart = {
      kind: "stack.start",
      expectedConfigurationRevisionId: services.currentConfigurationGeneration(host.infraDir)!,
    } as const;
    const stackContext = await host.context(stackStart);
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    host.setInventoryProcess(async () => {
      entered.resolve();
      await finish.promise;
    });
    let starts = 0;
    host.setCreatingProcess(async () => {
      starts++;
      create();
    });
    const removing = dispatchOpsOperation(host.runtime, remove, removeContext);
    await entered.promise;
    const starting = dispatchOpsOperation(host.runtime, start, startContext).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await drain();
      expect(starts).toBe(0);
      finish.resolve();
      await expect(removing).resolves.toMatchObject({ removed: true });
      expect(existsSync(checkout)).toBe(false);
      const outcome = await starting;
      expect("error" in outcome && outcome.error instanceof Error).toBe(true);
      await expect(dispatchOpsOperation(host.runtime, stackStart, stackContext)).rejects.toThrow();
      expect(starts).toBe(0);
    } finally {
      finish.resolve();
      await removing.catch(() => undefined);
      await starting;
    }
  });
});

it.runIf(installedCompose)(
  "executes assembled retained-generation cleanup after real Compose path qualification",
  async () => {
    const fixture = await ownedComposePathRuntime();
    roots.push(fixture.host.root);
    await fixture.host.commit("advanced");
    const stop = { kind: "service.stop", serviceId: "alpha" } as const;
    await dispatchOpsOperation(fixture.runtime, stop, await fixture.context(stop));
    const logs = { kind: "service.logs", serviceId: "alpha", tail: 20 } as const;
    await expect(
      dispatchOpsOperation(fixture.runtime, logs, await fixture.context(logs)),
    ).resolves.toMatchObject({ lines: ["public fixture log"] });
    expect(fixture.calls).toContainEqual(["stop", fixture.row.Id]);
    expect(fixture.calls).toContainEqual(["logs", "--tail=20", fixture.row.Id]);
    expect(fixture.pathChecks.every((checks) => Object.values(checks).every(Boolean))).toBe(true);
  },
);

describe("settlement and cancellation at the installed lifecycle boundary", () => {
  it("cancels a waiting removal without stealing the still-executing Start guard", async () => {
    const { host, start, remove, checkout, create } = await installedCommunity();
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    host.setCreatingProcess(async () => {
      entered.resolve();
      await finish.promise;
      create();
    });
    const starting = dispatchOpsOperation(host.runtime, start, await host.context(start));
    await entered.promise;
    const controller = new AbortController();
    const removeContext = await host.context(remove, controller.signal);
    const removing = dispatchOpsOperation(host.runtime, remove, removeContext).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await drain();
    controller.abort(new Error("synthetic waiting cancellation"));
    try {
      const result = await removing;
      expect("error" in result).toBe(true);
      expect(existsSync(checkout)).toBe(true);
      expect(host.row.State).toBe("running");
    } finally {
      finish.resolve();
      await starting;
    }
    await expect(
      dispatchOpsOperation(host.runtime, remove, await host.context(remove)),
    ).rejects.toThrow("require cleanup");
  });

  it("retains an unknown aborted process fence across production runtime reconstruction", async () => {
    const { host, start, remove, checkout } = await installedCommunity();
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    host.setCreatingProcess(async () => {
      entered.resolve();
      await finish.promise;
      throw Error("unknown external process settlement");
    });
    const controller = new AbortController(),
      ctx = await host.context(start, controller.signal);
    const starting = dispatchOpsOperation(host.runtime, start, ctx).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    controller.abort();
    finish.resolve();
    expect("error" in (await starting)).toBe(true);
    const restarted = await createProductionOpsRuntime({
      rootDir: host.root,
      stack: host.stack,
      loadAuthority: host.loadAuthority,
      communityRepositories: host.repositories,
      docker: { execFile: host.execFile, fileExists: existsSync },
    });
    await expect(
      dispatchOpsOperation(restarted, remove, await host.context(remove)),
    ).rejects.toThrow("settlement is unresolved");
    expect(existsSync(checkout)).toBe(true);
  });

  it("releases a known-contained failing process and orders multi-service Start without deadlock", async () => {
    const { host, start, remove, checkout } = await installedCommunity();
    let first = true;
    host.setCreatingProcess(async (_args, signal) => {
      if (first) {
        first = false;
        await runContainedProcess(process.execPath, ["-e", "process.exit(7)"], {
          signal,
          timeout: 5_000,
          maxBuffer: 1024,
        });
      }
    });
    await expect(
      dispatchOpsOperation(host.runtime, start, await host.context(start)),
    ).rejects.toThrow("Contained process failed");
    const global = {
      kind: "stack.start",
      expectedConfigurationRevisionId: services.currentConfigurationGeneration(host.infraDir)!,
    } as const;
    await expect(
      dispatchOpsOperation(host.runtime, global, await host.context(global)),
    ).resolves.toMatchObject({ changed: true });
    await expect(
      dispatchOpsOperation(host.runtime, remove, await host.context(remove)),
    ).resolves.toMatchObject({ removed: true });
    expect(existsSync(checkout)).toBe(false);
  });
});
