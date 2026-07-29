import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner";
import { isAppApiRestartCheckpoint } from "../system-update-state";

const events: string[] = [];
const runCli = vi.fn(async (_ctx: JobContext, args: string[]) => {
  events.push(`cli:${args.join(" ")}`);
});
const render = vi.fn(async () => events.push("render"));
const hardlinks = vi.fn(async () => {
  events.push("hardlinks");
  return { applied: true, linked: 0, skipped: 0, pruned: 0, entries: 0 };
});
const composeAction = vi.fn(async (id: string, action: string, options?: { noDeps?: boolean }) => {
  events.push(`compose:${action}:${id}:${options?.noDeps === true ? "no-deps" : "deps"}`);
  return { exitCode: 0, stdout: "", stderr: "" };
});
const replacement = {
  helperContainerId: "d".repeat(64),
  previousContainerId: "a".repeat(64),
  expectedImageId: `sha256:${"c".repeat(64)}`,
  outcomeFile: "/repo/infra/docker/.maintenance/app-api-job-1.status",
};
const prepareReplacement = vi.fn(async () => {
  events.push("replacement:prepare");
  return replacement;
});
const discardReplacement = vi.fn(async () => {
  events.push("replacement:discard");
});
const startReplacement = vi.fn(async () => {
  events.push("replacement:start");
  throw new Error("replacement helper returned");
});
const disabledServices = new Set<string>();

vi.mock("@openmapx/core/server", () => ({
  repoPaths: () => ({ composeOutPath: "/repo/infra/docker/docker-compose.generated.yml" }),
}));
vi.mock("../admin-cli", () => ({ runOpenmapxCliJobCommand: runCli }));
vi.mock("../admin-ops", () => ({
  renderAndPersistCompose: render,
  applyHardlinksFromPlan: hardlinks,
}));
vi.mock("../service-registry", () => ({
  getServiceRegistry: () => ({
    get: (id: string) => ({
      enabled: !disabledServices.has(id),
      manifest: { id, name: id, container: { image: `ghcr.io/openmapx/${id}`, tag: "latest" } },
    }),
  }),
}));
vi.mock("../../utils/docker-compose", () => ({ dockerComposeAction: composeAction }));
vi.mock("../app-api-replacement", () => ({
  prepareAppApiReplacement: prepareReplacement,
  discardAppApiReplacement: discardReplacement,
  startAppApiReplacement: startReplacement,
}));

const { _systemMaintenanceTestHelpers, handleSystemDiagnosticsJob, handleSystemUpdateJob } =
  await import("../system-maintenance");

function context(payload: Record<string, unknown>): JobContext {
  return {
    jobId: "job-1",
    payload,
    signal: new AbortController().signal,
    log: vi.fn(async (line: string) => {
      events.push(`log:${line}`);
    }),
    setProgress: vi.fn(async (progress: number) => {
      events.push(`progress:${progress}`);
    }),
    checkpoint: vi.fn(async (result: Record<string, unknown>, progress?: number) => {
      events.push(
        `checkpoint:${String(result.phase)}:${String(result.helperContainerId)}:${progress}`,
      );
    }),
  };
}

beforeEach(() => {
  events.length = 0;
  disabledServices.clear();
  vi.clearAllMocks();
});

describe("system maintenance", () => {
  it("recognizes only the durable API restart completion checkpoint", () => {
    expect(isAppApiRestartCheckpoint({ phase: "awaiting-app-api-restart" })).toBe(false);
    expect(isAppApiRestartCheckpoint({ phase: "awaiting-app-api-restart", ...replacement })).toBe(
      true,
    );
    expect(isAppApiRestartCheckpoint({ phase: "complete" })).toBe(false);
    expect(isAppApiRestartCheckpoint(null)).toBe(false);
  });

  it("parses both array and newline Compose JSON output", () => {
    expect(_systemMaintenanceTestHelpers.parseComposePs('[{"Service":"app-api"}]')).toHaveLength(1);
    expect(
      _systemMaintenanceTestHelpers.parseComposePs('{"Service":"app-api"}\n{"Service":"app-web"}'),
    ).toHaveLength(2);
  });

  it("updates dependencies before app-api and checkpoints the intentional restart", async () => {
    await expect(
      handleSystemUpdateJob(context({ operation: "apply", createBackup: true })),
    ).rejects.toThrow("replacement helper returned");

    expect(events[0]).toMatch(/^log:Creating safety backup/);
    expect(events).toContain("render");
    expect(events).toContain("hardlinks");
    const dataManager = events.indexOf("compose:recreate:data-manager:no-deps");
    const appWeb = events.indexOf("compose:recreate:app-web:no-deps");
    const prepare = events.indexOf("replacement:prepare");
    const checkpoint = events.indexOf(
      `checkpoint:awaiting-app-api-restart:${replacement.helperContainerId}:95`,
    );
    const start = events.indexOf("replacement:start");
    expect(dataManager).toBeGreaterThan(-1);
    expect(appWeb).toBeGreaterThan(dataManager);
    expect(prepare).toBeGreaterThan(appWeb);
    expect(checkpoint).toBeGreaterThan(prepare);
    expect(start).toBeGreaterThan(checkpoint);
    expect(events).not.toContain("compose:recreate:app-api:no-deps");
  });

  it("skips the pre-update backup when the operator opts out", async () => {
    await expect(
      handleSystemUpdateJob(context({ operation: "apply", createBackup: false })),
    ).rejects.toThrow("replacement helper returned");

    expect(events).toContain("log:Safety backup skipped by operator.");
    expect(events.some((event) => event.startsWith("cli:backup create"))).toBe(false);
  });

  it("removes the prepared helper when checkpoint persistence fails", async () => {
    const ctx = context({ operation: "apply", createBackup: false });
    ctx.checkpoint = vi.fn(async () => {
      events.push("checkpoint:failed");
      throw new Error("database unavailable");
    });

    await expect(handleSystemUpdateJob(ctx)).rejects.toThrow("database unavailable");
    expect(events.indexOf("replacement:prepare")).toBeGreaterThan(-1);
    expect(events.indexOf("replacement:discard")).toBeGreaterThan(
      events.indexOf("checkpoint:failed"),
    );
    expect(events).not.toContain("replacement:start");
  });

  it("finishes without a helper when app-api is disabled", async () => {
    disabledServices.add("app-api");

    await expect(
      handleSystemUpdateJob(context({ operation: "apply", createBackup: false })),
    ).resolves.toEqual({ operation: "apply", phase: "complete", appApiRestarted: false });
    expect(prepareReplacement).not.toHaveBeenCalled();
    expect(startReplacement).not.toHaveBeenCalled();
  });

  it("maps deep diagnostics to the CLI check command", async () => {
    await handleSystemDiagnosticsJob(context({}));
    expect(events).toContain("cli:check");
  });
});
