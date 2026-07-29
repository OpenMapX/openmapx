import { describe, expect, it, vi } from "vitest";
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
      enabled: true,
      manifest: { id, name: id, container: { image: `ghcr.io/openmapx/${id}`, tag: "latest" } },
    }),
  }),
}));
vi.mock("../../utils/docker-compose", () => ({ dockerComposeAction: composeAction }));

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
      events.push(`checkpoint:${String(result.phase)}:${progress}`);
    }),
  };
}

describe("system maintenance", () => {
  it("recognizes only the durable API restart completion checkpoint", () => {
    expect(isAppApiRestartCheckpoint({ phase: "awaiting-app-api-restart" })).toBe(true);
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
    events.length = 0;
    await handleSystemUpdateJob(context({ operation: "apply", createBackup: true }));

    expect(events[0]).toMatch(/^log:Creating safety backup/);
    expect(events).toContain("render");
    expect(events).toContain("hardlinks");
    const dataManager = events.indexOf("compose:recreate:data-manager:no-deps");
    const appWeb = events.indexOf("compose:recreate:app-web:no-deps");
    const checkpoint = events.indexOf("checkpoint:awaiting-app-api-restart:95");
    const appApi = events.indexOf("compose:recreate:app-api:no-deps");
    expect(dataManager).toBeGreaterThan(-1);
    expect(appWeb).toBeGreaterThan(dataManager);
    expect(checkpoint).toBeGreaterThan(appWeb);
    expect(appApi).toBeGreaterThan(checkpoint);
  });

  it("skips the pre-update backup when the operator opts out", async () => {
    events.length = 0;
    await handleSystemUpdateJob(context({ operation: "apply", createBackup: false }));

    expect(events).toContain("log:Safety backup skipped by operator.");
    expect(events.some((event) => event.startsWith("cli:backup create"))).toBe(false);
  });

  it("maps deep diagnostics to the CLI check command", async () => {
    events.length = 0;
    await handleSystemDiagnosticsJob(context({}));
    expect(events).toContain("cli:check");
  });
});
