import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { expect, it, vi } from "vitest";
import { releaseProvenance } from "../../../packages/core/src/services/__fixtures__/release-provenance";
import { testExecution } from "./__fixtures__/execution";
import { createDefaultReleaseEffects } from "./administrative-runtime";
import { startOpsAgentServer } from "./bootstrap";

it.each(["SIGTERM", "SIGINT"] as const)(
  "production bootstrap drains an accepted request on %s",
  async (signal) => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-shutdown-")),
      loader = createRequire(import.meta.url).resolve("tsx/esm"),
      child = fork(new URL("./__fixtures__/shutdown.ts", import.meta.url), [root], {
        execArgv: ["--import", loader],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
    const ready = Promise.withResolvers<number>(),
      working = Promise.withResolvers<void>(),
      stopping = Promise.withResolvers<void>();
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("message", (message) => {
      const value = message as { event: string; port?: number };
      if (value.event === "ready") ready.resolve(value.port!);
      if (value.event === "working") working.resolve();
      if (value.event === "stopping") stopping.resolve();
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          resolve({ code, signal });
        });
      },
    );
    const failed = exit.then((result) => {
      throw Error(`Fixture exited ${JSON.stringify(result)}: ${stderr}`);
    });
    let request: Promise<unknown> | undefined;
    try {
      const port = await Promise.race([ready.promise, failed]),
        now = Date.now();
      request = fetch(`http://127.0.0.1:${port}/v1/operations`, {
        method: "POST",
        headers: {
          authorization: "Bearer shutdown-fixture-token",
          "content-type": "application/json",
          "x-ops-protocol-version": "1",
        },
        body: JSON.stringify({
          version: 1,
          requestId: "ops1_shutdown0000000000",
          operationKey: "opk1_shutdown0000000000",
          issuedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 15000).toISOString(),
          operation: { kind: "docker.status" },
        }),
      })
        .then(async (response) => ({
          status: response.status,
          connection: response.headers.get("connection"),
          body: await response.json(),
        }))
        .catch((error: unknown) => error);
      await Promise.race([
        working.promise,
        failed,
        request.then((result) => {
          throw Error(`Dispatch not reached: ${JSON.stringify(result)}`);
        }),
      ]);
      child.kill(signal);
      await Promise.race([stopping.promise, failed]);
      child.send("release");
      expect(await request).toMatchObject({ status: 200, connection: "close" });
      expect(await exit, stderr).toEqual({ code: 0, signal: null });
      expect(readFileSync(join(root, "completed"), "utf8")).toBe("drained");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
      await request;
      rmSync(root, { recursive: true, force: true });
    }
  },
  // Allow the production 30-second shutdown deadline to produce an exit
  // result before the test harness terminates the fixture.
  60000,
);

it.each(["legacy", "expired"])(
  "fix1 production bootstrap retains health and observation with %s release recovery",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-bootstrap-"));
    const directory = services.releaseStatePaths(join(root, "infra/docker")).store;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const manifest = {
      schemaVersion: 1,
      release: "release-bootstrap",
      images: Object.fromEntries(
        [
          "api",
          "web",
          "data-manager",
          "ops-agent",
          "privacy-backup",
          "transitous-runner",
          "transitous-tools",
        ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"a".repeat(64)}`]),
      ),
      privacyReleaseValidation: {
        version: 1,
        sourceBuildFingerprint: "a".repeat(64),
        validatedAt: "2026-09-05T12:00:00.000Z",
        checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
      },
      ...releaseProvenance(),
    };
    writeFileSync(join(directory, "release-bootstrap.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
    writeFileSync(
      join(directory, "transaction.json"),
      JSON.stringify({
        version: 1,
        phase: "overlay_written",
        releaseId: manifest.release,
        digest: createHash("sha256")
          .update(
            services.canonicalReleaseManifest(
              services.parseReleaseManifest(JSON.stringify(manifest)),
            ),
          )
          .digest("hex"),
        serviceIds: ["app-api"],
        previousOverlay: null,
        previousState: null,
        ...(mode === "expired"
          ? { execution: { ...testExecution(), deadlineAt: Date.now() - 1 } }
          : {}),
      }),
      { mode: 0o600 },
    );
    const overlay = services.releaseStatePaths(join(root, "infra/docker")).overlay;
    writeFileSync(overlay, "operator-state\n");
    const run = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => ({ reachable: true, version: "test" }));
    const token = Buffer.alloc(32, 1).toString("base64url");
    const retained = {
      role: "api" as const,
      operation: {
        kind: "service.pull" as const,
        serviceId: "redis",
        expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
      },
      operationId: "job1_0123456789abcdef",
      operationKey: "opk1_0123456789abcdef",
      fingerprint: (await import("@openmapx/core/ops")).opsOperationFingerprint({
        kind: "service.pull",
        serviceId: "redis",
        expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
      }),
      resourceId: "redis",
      state: "succeeded" as const,
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      terminalAt: new Date().toISOString(),
      result: { completed: true },
    };
    const ready = vi.fn();
    let app: Awaited<ReturnType<typeof startOpsAgentServer>> | undefined;
    try {
      app = await startOpsAgentServer(
        {
          tokens: { api: token, "data-manager": Buffer.alloc(32, 2).toString("base64url") },
          resourcePolicy: { allowGlobal: () => true, allowService: () => true },
          journal: { records: () => [retained], replace: async () => undefined },
          dispatch,
        },
        createDefaultReleaseEffects(root, run),
        { host: "127.0.0.1", port: 0 },
        ready,
      );
      const address = app.server.address();
      if (!address || typeof address === "string") throw Error("listener missing");
      const health = await (await fetch(`http://127.0.0.1:${address.port}/health`)).json();
      expect(health).toMatchObject({
        ok: true,
        releaseRecovery: { ready: false, reason: "recovery_required" },
      });
      const headers = { authorization: `Bearer ${token}`, "x-ops-protocol-version": "2" };
      expect(
        (await app.inject({ method: "GET", url: "/v1/operations/job1_0123456789abcdef", headers }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/operation-keys/opk1_0123456789abcdef",
            headers: { ...headers, "x-ops-operation-fingerprint": retained.fingerprint },
          })
        ).statusCode,
      ).toBe(200);
      const now = Date.now();
      const envelope = (operation: unknown, requestId: string) => ({
        version: 2,
        requestId,
        operationKey: "opk1_bootstrapnew0000",
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 15000).toISOString(),
        operation,
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/operations",
            headers,
            payload: envelope(
              { kind: "service.restart", serviceId: "redis" },
              "ops1_0123456789abcdef",
            ),
          })
        ).json().error.class,
      ).toBe("recovery_required");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/operations",
            headers,
            payload: envelope({ kind: "docker.status" }, "ops1_abcdef0123456789"),
          })
        ).statusCode,
      ).toBe(200);
      expect(ready).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(readFileSync(overlay, "utf8")).toBe("operator-state\n");
    } finally {
      await app?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
