import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdministrativeRuntime, createDefaultReleaseEffects } from "./administrative-runtime";
import { type AgentHandoffRecord, readAgentHandoff, writeAgentHandoff } from "./agent-handoff";
import { createUnavailableRuntime, dispatchOpsOperation } from "./runtime";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const release = "release-2";
const pin = (name: string) => `ghcr.io/openmapx/${name}@sha256:${"4".repeat(64)}`;
const manifestText = JSON.stringify({
  schemaVersion: 1,
  release,
  images: Object.fromEntries(
    [
      "api",
      "web",
      "data-manager",
      "ops-agent",
      "privacy-backup",
      "transitous-runner",
      "transitous-tools",
    ].map((name) => [name, pin(name)]),
  ),
  privacyReleaseValidation: {
    version: 1,
    sourceBuildFingerprint: "a".repeat(64),
    validatedAt: "2026-09-05T12:00:00.000Z",
    checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
  },
});
const digest = createHash("sha256").update(manifestText).digest("hex");
const agentContainer = "c".repeat(64);
const newAgentImage = `sha256:${"5".repeat(64)}`;
const oldAgentImage = `sha256:${"9".repeat(64)}`;

function fixture(options: { agent: "old" | "current"; helperStarts?: boolean }) {
  const rootDir = mkdtempSync(join(tmpdir(), "openmapx-agent-update-"));
  roots.push(rootDir);
  mkdirSync(join(rootDir, "infra", "docker", "state", "ops-agent"), {
    recursive: true,
    mode: 0o700,
  });
  const calls: string[][] = [];
  const docker = vi.fn(async (args: readonly string[]) => {
    calls.push([...args]);
    const joined = args.join(" ");
    if (args[0] === "pull") return `Digest: sha256:${"1".repeat(64)}`;
    if (args[0] === "create") return "a".repeat(64);
    if (args[0] === "cp") {
      writeFileSync(args.at(-1) as string, manifestText, { mode: 0o600 });
      return "";
    }
    if (args[0] === "run") {
      if (options.helperStarts === false) throw new Error("docker run failed");
      return "f".repeat(64);
    }
    if (joined.includes("ps -q ops-agent")) return `${agentContainer}\n`;
    if (args[0] === "container") {
      const format = args[3];
      if (format === "{{.Image}}") return options.agent === "old" ? oldAgentImage : newAgentImage;
      if (format?.includes(".Config.Env") && format.includes("{{if eq"))
        return `OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE=${options.agent === "old" ? "old" : pin("privacy-backup")}\n`;
      if (format === "{{.Config.User}}") return "1000:1000";
      if (format === "{{json .HostConfig.GroupAdd}}") return '["999"]';
      if (format?.startsWith("{{range .Config.Env}}{{println")) return "OPENMAPX_ROOT_DIR\n";
      if (format === "{{json .Mounts}}")
        return JSON.stringify([
          { Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" },
          { Source: rootDir, Destination: rootDir },
        ]);
    }
    if (args[0] === "image" && joined.includes("{{.Id}}")) {
      return joined.endsWith(pin("ops-agent")) ? newAgentImage : `sha256:${"2".repeat(64)}`;
    }
    if (joined.includes("RepoDigests")) return "[]";
    return "";
  });
  const cli = vi.fn(async (_args: readonly string[]) => {});
  const effects = createDefaultReleaseEffects(rootDir, cli, {
    runDocker: docker,
    verifyAppliedRelease: async () => true,
  });
  const context = { signal: new AbortController().signal, emitLog: vi.fn() };
  return { rootDir, docker, calls, cli, effects, context };
}

async function resolved(options: Parameters<typeof fixture>[0]) {
  const f = fixture(options);
  await expect(f.effects.resolve(f.context)).resolves.toBe(release);
  return f;
}

const request = (
  overrides: Partial<{ handoffId: string; otherActiveOperations: number }> = {},
) => ({
  releaseId: release,
  expectedDigest: digest,
  handoffId: "handoff-1",
  otherActiveOperations: 0,
  ...overrides,
});

describe("operations agent update", () => {
  it("replaces an outdated agent through a helper started from its own image", async () => {
    const f = await resolved({ agent: "old" });
    writeFileSync(
      join(f.rootDir, "infra", "docker", "docker-compose.release.yml"),
      "old-overlay\n",
    );

    await expect(f.effects.updateAgent?.(request(), f.context)).resolves.toEqual({
      handoffId: "handoff-1",
      replaced: true,
    });
    expect(readAgentHandoff(f.rootDir)).toMatchObject({
      handoffId: "handoff-1",
      releaseId: release,
      digest,
      phase: "launched",
      previousOverlay: "old-overlay\n",
    });
    const run = f.calls.find((args) => args[0] === "run");
    expect(run).toEqual(
      expect.arrayContaining([
        "openmapx.ops-agent.handoff=handoff-1",
        `type=bind,source=${f.rootDir},target=${f.rootDir}`,
        oldAgentImage,
      ]),
    );
    // Nothing in the stack changes before the helper takes over.
    expect(f.cli).not.toHaveBeenCalled();
    expect(
      readFileSync(join(f.rootDir, "infra", "docker", "docker-compose.release.yml"), "utf8"),
    ).toBe("old-overlay\n");
  });

  it("leaves an agent that already runs the release alone", async () => {
    const f = await resolved({ agent: "current" });
    await expect(f.effects.updateAgent?.(request(), f.context)).resolves.toEqual({
      handoffId: "handoff-1",
      replaced: false,
    });
    expect(f.calls.some((args) => args[0] === "run")).toBe(false);
    expect(readAgentHandoff(f.rootDir)).toBeNull();
  });

  it("refuses while other operations would end with the agent", async () => {
    const f = await resolved({ agent: "old" });
    await expect(
      f.effects.updateAgent?.(request({ otherActiveOperations: 1 }), f.context),
    ).rejects.toMatchObject({ name: "OpsAgentBusyError" });
    expect(readAgentHandoff(f.rootDir)).toBeNull();
  });

  it("refuses an unchecked or changed candidate", async () => {
    const f = await resolved({ agent: "old" });
    await expect(
      f.effects.updateAgent?.({ ...request(), expectedDigest: "0".repeat(64) }, f.context),
    ).rejects.toThrow("Checked release");
    expect(readAgentHandoff(f.rootDir)).toBeNull();
  });

  it("answers a resumed job from its existing handoff", async () => {
    const f = await resolved({ agent: "old" });
    await f.effects.updateAgent?.(request(), f.context);
    const runs = f.calls.filter((args) => args[0] === "run").length;
    await expect(f.effects.updateAgent?.(request(), f.context)).resolves.toEqual({
      handoffId: "handoff-1",
      replaced: true,
    });
    expect(f.calls.filter((args) => args[0] === "run")).toHaveLength(runs);
  });

  it("refuses a second handoff while one is in progress", async () => {
    const f = await resolved({ agent: "old" });
    await f.effects.updateAgent?.(request(), f.context);
    // A running helper owns the first handoff.
    f.docker.mockImplementation(async (args: readonly string[]) =>
      args[0] === "ps"
        ? "helper\n"
        : args.join(" ").includes("ps -q ops-agent")
          ? agentContainer
          : oldAgentImage,
    );
    await expect(
      f.effects.updateAgent?.(request({ handoffId: "handoff-2" }), f.context),
    ).rejects.toThrow();
    expect(readAgentHandoff(f.rootDir)?.handoffId).toBe("handoff-1");
  });

  it("records a failed handoff when the helper cannot start", async () => {
    const f = await resolved({ agent: "old", helperStarts: false });
    await expect(f.effects.updateAgent?.(request(), f.context)).rejects.toThrow(
      "docker run failed",
    );
    expect(readAgentHandoff(f.rootDir)).toMatchObject({ phase: "failed" });
  });

  it("settles a handoff imported from an earlier release once its helper has exited", async () => {
    const f = await resolved({ agent: "current" });
    // The earlier release's helper records its outcome where that release kept
    // its state; this agent took over the record when it started.
    writeAgentHandoff(f.rootDir, {
      version: 1,
      handoffId: "handoff-1",
      releaseId: release,
      digest,
      phase: "recreated",
      previousOverlay: null,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      importedFromLegacy: true,
    });
    const settled = vi.fn(async () => {});
    const effects = createDefaultReleaseEffects(f.rootDir, f.cli, {
      runDocker: f.docker,
      verifyAppliedRelease: async () => true,
      afterHandoffSettled: settled,
    });
    await expect(effects.inspectAgentHandoff?.("handoff-1")).resolves.toEqual({
      handoffId: "handoff-1",
      phase: "applied",
    });
    expect(settled).toHaveBeenCalledOnce();
    expect(readAgentHandoff(f.rootDir)).toMatchObject({ phase: "applied" });
  });

  it("leaves an imported handoff alone while its helper still runs", async () => {
    const f = await resolved({ agent: "current" });
    const record: AgentHandoffRecord = {
      version: 1,
      handoffId: "handoff-1",
      releaseId: release,
      digest,
      phase: "recreated",
      previousOverlay: null,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      importedFromLegacy: true,
    };
    writeAgentHandoff(f.rootDir, record);
    const helperRunning = vi.fn(async (args: readonly string[]) =>
      args.join(" ").includes("label=") ? `${"e".repeat(64)}\n` : f.docker(args),
    );
    const effects = createDefaultReleaseEffects(f.rootDir, f.cli, {
      runDocker: helperRunning,
      verifyAppliedRelease: async () => true,
    });
    await expect(effects.inspectAgentHandoff?.("handoff-1")).resolves.toEqual({
      handoffId: "handoff-1",
      phase: "recreated",
    });
  });

  it("reports the phase of the requested handoff only", async () => {
    const f = await resolved({ agent: "old" });
    await expect(f.effects.inspectAgentHandoff?.("handoff-1")).resolves.toEqual({
      handoffId: "handoff-1",
      phase: "none",
    });
    await f.effects.updateAgent?.(request(), f.context);
    await expect(f.effects.inspectAgentHandoff?.("handoff-1")).resolves.toEqual({
      handoffId: "handoff-1",
      phase: "launched",
    });
    await expect(f.effects.inspectAgentHandoff?.("other")).resolves.toMatchObject({
      phase: "none",
    });
  });

  it("passes the agent's count of other running operations to the update", async () => {
    const updateAgent = vi.fn(async () => ({ handoffId: "handoff-1", replaced: false }));
    const runtime = createUnavailableRuntime();
    createAdministrativeRuntime(runtime, {
      rootDir: mkdtempSync(join(tmpdir(), "openmapx-agent-update-")),
      releaseEffects: {
        resolve: async () => release,
        pull: async () => undefined,
        inspect: async () => ({ configuredSelector: "main" }),
        inspectSystem: async () => ({
          dockerReachable: true,
          composeReady: true,
          maintenanceReady: true,
          release: { configuredSelector: "main" },
          services: [],
        }),
        apply: async () => undefined,
        updateAgent,
      },
    });
    await dispatchOpsOperation(
      runtime,
      { kind: "agent.update", releaseId: release, expectedDigest: digest, handoffId: "handoff-1" },
      {
        signal: new AbortController().signal,
        emitLog: () => {},
        otherActiveOperations: () => 2,
        claim: {
          fingerprint: "f",
          operation: {
            kind: "agent.update",
            releaseId: release,
            expectedDigest: digest,
            handoffId: "handoff-1",
          },
          source: "registry",
          capability: { revisionId: "registry-v1", values: {} },
        },
      },
    );
    expect(updateAgent).toHaveBeenCalledWith(
      expect.objectContaining({ otherActiveOperations: 2, handoffId: "handoff-1" }),
      expect.anything(),
    );
  });
});

describe("release application after an agent handoff", () => {
  function handoff(phase: AgentHandoffRecord["phase"]): AgentHandoffRecord {
    return {
      version: 1,
      handoffId: "handoff-1",
      releaseId: release,
      digest,
      phase,
      previousOverlay: "pre-handoff-overlay\n",
      createdAt: "2026-10-21T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
    };
  }
  const services = ["data-manager", "app-web", "transitous-runner", "app-api"] as const;

  it("refuses while the agent replacement is still in progress", async () => {
    const f = await resolved({ agent: "current" });
    writeAgentHandoff(f.rootDir, handoff("recreated"));
    f.docker.mockImplementation(async (args: readonly string[]) =>
      args[0] === "ps" ? "helper\n" : "",
    );
    await expect(f.effects.apply(release, [...services], f.context)).rejects.toThrow(
      "still in progress",
    );
    expect(f.cli).not.toHaveBeenCalled();
  });

  it("rolls the application services back to the overlay from before the handoff", async () => {
    const f = await resolved({ agent: "current" });
    const overlay = join(f.rootDir, "infra", "docker", "docker-compose.release.yml");
    writeFileSync(overlay, "release-2-overlay-written-by-the-helper\n");
    writeAgentHandoff(f.rootDir, handoff("applied"));
    f.cli.mockImplementationOnce(async () => {
      throw new Error("services update failed");
    });

    await expect(f.effects.apply(release, [...services], f.context)).rejects.toThrow(
      "services update failed",
    );
    expect(readFileSync(overlay, "utf8")).toBe("pre-handoff-overlay\n");
    expect(readAgentHandoff(f.rootDir)?.consumed).toBe(true);
  });

  it("takes an imported handoff's rollback target from the agent's own release state", async () => {
    const f = await resolved({ agent: "current" });
    const overlay = join(f.rootDir, "infra", "docker", "docker-compose.release.yml");
    // An earlier apply recorded the release the application services run.
    await f.effects.apply(release, [...services], f.context);
    writeFileSync(overlay, "overlay-written-by-the-earlier-release-helper\n");
    // Whatever the old location held, the imported record's overlay is never used.
    writeAgentHandoff(f.rootDir, {
      ...handoff("applied"),
      previousOverlay: "services:\n  app-api:\n    image: attacker.invalid/app-api\n",
      importedFromLegacy: true,
    });
    f.cli.mockImplementationOnce(async () => {
      throw new Error("services update failed");
    });

    await expect(f.effects.apply(release, [...services], f.context)).rejects.toThrow(
      "services update failed",
    );
    const restored = readFileSync(overlay, "utf8");
    expect(restored).not.toContain("attacker.invalid");
    expect(restored.startsWith("x-openmapx-release:")).toBe(true);
    expect(restored).toContain(`"release":"${release}"`);
  });

  it("never restores an overlay from an imported handoff that did not keep this agent", async () => {
    const f = await resolved({ agent: "old" });
    const overlay = join(f.rootDir, "infra", "docker", "docker-compose.release.yml");
    writeFileSync(overlay, "current-overlay\n");
    writeAgentHandoff(f.rootDir, {
      ...handoff("recreated"),
      previousOverlay: "services:\n  app-api:\n    image: attacker.invalid/app-api\n",
      importedFromLegacy: true,
    });
    await expect(f.effects.inspectAgentHandoff?.("handoff-1")).resolves.toMatchObject({
      phase: "rolled_back",
    });
    expect(readFileSync(overlay, "utf8")).toBe("current-overlay\n");
  });

  it("uses the current overlay again once the handoff was consumed", async () => {
    const f = await resolved({ agent: "current" });
    const overlay = join(f.rootDir, "infra", "docker", "docker-compose.release.yml");
    writeFileSync(overlay, "current-overlay\n");
    writeAgentHandoff(f.rootDir, { ...handoff("applied"), consumed: true });
    f.cli.mockImplementationOnce(async () => {
      throw new Error("services update failed");
    });

    await expect(f.effects.apply(release, [...services], f.context)).rejects.toThrow();
    expect(readFileSync(overlay, "utf8")).toBe("current-overlay\n");
  });

  it("applies the release once the new agent runs it", async () => {
    const f = await resolved({ agent: "current" });
    writeAgentHandoff(f.rootDir, handoff("applied"));
    await f.effects.apply(release, [...services], f.context);
    expect(f.cli).toHaveBeenCalledWith(["services", "update", "--no-deps", ...services], f.context);
    expect(
      existsSync(join(f.rootDir, "infra", "docker", ".ops-agent-releases", "current.json")),
    ).toBe(true);
  });
});
