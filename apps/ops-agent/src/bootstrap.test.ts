import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { expect, it, vi } from "vitest";
import { testExecution } from "./__fixtures__/execution";
import { createDefaultReleaseEffects } from "./administrative-runtime";
import { startOpsAgentServer } from "./bootstrap";

it.each(["legacy", "expired"])(
  "fix1 production bootstrap retains health and observation with %s release recovery",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-bootstrap-"));
    const directory = join(root, "infra/docker/.ops-agent-releases");
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
    const overlay = join(root, "infra/docker/docker-compose.release.yml");
    writeFileSync(overlay, "operator-state\n");
    const run = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => ({ reachable: true, version: "test" }));
    const token = Buffer.alloc(32, 1).toString("base64url");
    const retained = {
      role: "api" as const,
      operation: { kind: "service.pull" as const, serviceId: "redis" },
      operationId: "job1_0123456789abcdef",
      operationKey: "opk1_0123456789abcdef",
      fingerprint: (await import("@openmapx/core/ops")).opsOperationFingerprint({
        kind: "service.pull",
        serviceId: "redis",
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
