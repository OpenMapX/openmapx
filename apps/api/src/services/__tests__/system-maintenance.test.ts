import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner";

const executeAdminOperation = vi.fn(async (_ctx: JobContext, operation: { kind: string }) => {
  if (operation.kind === "system.diagnostics") return { ok: true, checks: [] };
  if (operation.kind === "release.inspect") {
    return { currentReleaseId: "release-old", availableReleaseId: "release-123" };
  }
  return { releaseId: "release-123" };
});

vi.mock("../admin-job-ops", () => ({ executeAdminJobOperation: executeAdminOperation }));

const { handleSystemDiagnosticsJob, handleSystemUpdateJob } = await import("../system-maintenance");

function context(payload: Record<string, unknown>): JobContext {
  return {
    jobId: "job-1",
    payload,
    signal: new AbortController().signal,
    log: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    checkpoint: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("agent-owned system maintenance", () => {
  it("checks a release without API Docker or filesystem input", async () => {
    const ctx = context({ operation: "check" });
    await expect(handleSystemUpdateJob(ctx)).resolves.toEqual({
      operation: "check",
      release: "release-123",
      currentReleaseId: "release-old",
      availableReleaseId: "release-123",
    });
    expect(executeAdminOperation.mock.calls.map((call) => call.slice(1))).toEqual([
      [{ kind: "release.resolve" }, "admin-job.release.resolve"],
      [{ kind: "release.pull", releaseId: "release-123" }, "admin-job.release.pull"],
      [{ kind: "release.inspect" }, "admin-job.release.inspect"],
    ]);
  });

  it("delegates backup, release application, and app-api replacement as one durable operation", async () => {
    const ctx = context({ operation: "apply", createBackup: true });
    await expect(handleSystemUpdateJob(ctx)).resolves.toEqual({
      operation: "apply",
      release: "release-123",
      phase: "complete",
    });
    expect(executeAdminOperation).toHaveBeenLastCalledWith(
      ctx,
      {
        kind: "system.update",
        releaseId: "release-123",
        createBackup: true,
        backupId: "pre-update-job-1",
      },
      "admin-job.system.update",
    );
    expect(ctx.checkpoint).not.toHaveBeenCalled();
  });

  it("uses the kind-only diagnostic operation", async () => {
    const ctx = context({ argv: ["--verbose"] });
    await expect(handleSystemDiagnosticsJob(ctx)).resolves.toEqual({
      operation: "diagnostics",
      ok: true,
      checks: [],
    });
    expect(executeAdminOperation).toHaveBeenCalledWith(
      ctx,
      { kind: "system.diagnostics" },
      "admin-job.system.diagnostics",
    );
  });
});
