import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultReleaseEffects } from "./administrative-runtime";
import { buildOpsAgentServer } from "./server";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ids = ["data-manager", "app-web", "transitous-runner", "app-api"] as const;
const imageId = `sha256:${"a".repeat(64)}`;
function fixture(mode = "matching", crash = false) {
  const root = mkdtempSync(join(tmpdir(), "openmapx-release-coverage-"));
  roots.push(root);
  const directory = services.releaseStatePaths(join(root, "infra/docker")).store;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifest = services.parseReleaseManifest(
    JSON.stringify({
      schemaVersion: 1,
      release: "test-release",
      images: Object.fromEntries(
        services.RELEASE_IMAGE_NAMES.map((name) => [name, `ghcr.io/openmapx/${name}@${imageId}`]),
      ),
      privacyReleaseValidation: {
        version: 1,
        sourceBuildFingerprint: "a".repeat(64),
        validatedAt: "2026-09-12T12:00:00.000Z",
        checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
      },
    }),
  );
  writeFileSync(join(directory, "test-release.json"), services.canonicalReleaseManifest(manifest), {
    mode: 0o600,
  });
  mkdirSync(join(root, "infra/docker", services.CURRENT_CONFIGURATION), { recursive: true });
  writeFileSync(
    join(root, "infra/docker", services.CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
    "services: {}\n",
  );
  const calls: string[][] = [];
  const context = { signal: new AbortController().signal, emitLog: vi.fn() };
  const docker = vi.fn(async (args: readonly string[]) => {
    if (mode === "unreachable") throw new Error("daemon unavailable");
    if (args.includes("ps")) return mode === "missing" ? "" : "b".repeat(64);
    const notDownloaded = mode === "digest-only" || mode === "old-agent-not-downloaded";
    if (args.includes("{{json .RepoDigests}}")) {
      if (mode === "digest-only") return JSON.stringify([manifest.images["ops-agent"]]);
      if (mode === "old-agent-not-downloaded")
        return JSON.stringify([`ghcr.io/openmapx/ops-agent@sha256:${"d".repeat(64)}`]);
      throw new Error("No such image");
    }
    if (args.includes("{{.Id}}")) {
      if (notDownloaded) throw new Error("No such image");
      return imageId;
    }
    if (args.includes("{{.Image}}"))
      return mode === "old-agent" || notDownloaded ? `sha256:${"c".repeat(64)}` : imageId;
    if (args.some((arg) => arg.includes(".Config.Env")))
      return mode === "missing-helper"
        ? ""
        : mode === "old-helper"
          ? "OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE=ghcr.io/openmapx/privacy-backup:latest\n"
          : `OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE=${manifest.images["privacy-backup"]}\n`;
    throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
  });
  const cli = async (args: readonly string[]) => {
    calls.push([...args]);
  };
  const effects = createDefaultReleaseEffects(root, cli, {
    runDocker: docker,
    verifyAppliedRelease: async () => true,
    ...(crash
      ? {
          afterReleasePhase: (phase: string) => {
            if (phase === "overlay_written") throw new Error("crash");
          },
        }
      : {}),
  });
  return { root, directory, context, effects, calls, docker, cli };
}

describe("complete administrative release coverage", () => {
  it.each([
    "old-agent",
    "old-agent-not-downloaded",
    "old-helper",
    "missing-helper",
    "missing",
    "unreachable",
  ])("refuses %s before mutating release selection", async (mode) => {
    const f = fixture(mode);
    await expect(f.effects.apply("test-release", [...ids], f.context)).rejects.toThrow(/host/i);
    expect(f.calls).toEqual([]);
    expect(existsSync(join(f.directory, "transaction.json"))).toBe(false);
    expect(existsSync(services.releaseStatePaths(join(f.root, "infra/docker")).overlay)).toBe(
      false,
    );
    expect(f.context.emitLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining(
        "services update app-api app-web data-manager ops-agent transitous-runner",
      ),
    );
  });
  it("reports a safe host-update code through the agent protocol", async () => {
    const f = fixture("old-agent");
    const now = new Date();
    const token = Buffer.alloc(32, 1).toString("base64url");
    const app = buildOpsAgentServer({
      tokens: { api: token, "data-manager": Buffer.alloc(32, 2).toString("base64url") },
      resourcePolicy: { allowRelease: () => true },
      dispatch: async () => {
        await f.effects.apply("test-release", [...ids], f.context);
      },
    });
    try {
      const admitted = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          version: 1,
          requestId: "ops1_hostUpdateRequest",
          operationKey: "opk1_hostUpdateRequest",
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 20_000).toISOString(),
          operation: { kind: "release.apply", releaseId: "test-release" },
        },
      });
      expect(admitted.statusCode).toBe(202);
      const id = admitted.json().result.operationId;
      await expect
        .poll(async () => {
          const response = await app.inject({
            method: "GET",
            url: `/v1/operations/${id}`,
            headers: { authorization: `Bearer ${token}` },
          });
          return response.json().result;
        })
        .toMatchObject({ state: "failed", errorClass: "host_update_required" });
      expect(f.calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("applies all four managed services when the agent and collector already match", async () => {
    const f = fixture();
    await f.effects.apply("test-release", [...ids], f.context);
    expect(f.calls).toEqual([["services", "update", "--no-deps", ...ids]]);
    expect(JSON.parse(readFileSync(join(f.directory, "current.json"), "utf8")).releaseId).toBe(
      "test-release",
    );
  });
  it("verifies the running agent by its repository digest before the release is downloaded", async () => {
    const f = fixture("digest-only");
    await f.effects.apply("test-release", [...ids], f.context);
    expect(f.calls).toEqual([["services", "update", "--no-deps", ...ids]]);
    expect(f.docker.mock.calls.some(([args]) => args[0] === "pull")).toBe(false);
  });
  it.each(["old-agent", "old-helper"])(
    "refuses forward recovery after %s changed",
    async (mode) => {
      const f = fixture("matching", true);
      await expect(f.effects.apply("test-release", [...ids], f.context)).rejects.toThrow("crash");
      const overlayPath = services.releaseStatePaths(join(f.root, "infra/docker")).overlay;
      const before = readFileSync(overlayPath, "utf8");
      const changed = fixture(mode);
      const recovery = createDefaultReleaseEffects(f.root, f.cli, {
        runDocker: changed.docker,
        verifyAppliedRelease: async () => true,
      });
      await expect(recovery.initialize?.()).rejects.toThrow(/host/i);
      expect(f.calls).toEqual([]);
      expect(readFileSync(overlayPath, "utf8")).toBe(before);
      expect(existsSync(join(f.directory, "current.json"))).toBe(false);
      expect(existsSync(join(f.directory, "transaction.json"))).toBe(true);
    },
  );
  it("recovers a transaction containing transitous-runner", async () => {
    const f = fixture("matching", true);
    await expect(f.effects.apply("test-release", [...ids], f.context)).rejects.toThrow("crash");
    const recovery = createDefaultReleaseEffects(f.root, f.cli, {
      runDocker: f.docker,
      verifyAppliedRelease: async () => true,
    });
    await recovery.initialize?.();
    expect(f.calls).toEqual([["services", "update", "--no-deps", ...ids]]);
    expect(existsSync(join(f.directory, "transaction.json"))).toBe(false);
  });
});
