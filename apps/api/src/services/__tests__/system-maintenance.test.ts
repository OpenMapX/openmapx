import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner";

const executeAdminOperation = vi.fn(async (_ctx: JobContext, operation: { kind: string }) => {
  if (operation.kind === "system.diagnostics") return { ok: true, checks: [] };
  if (operation.kind === "release.inspect")
    return { currentReleaseId: "release-old", availableReleaseId: "release-123" };
  return { releaseId: "release-123" };
});
const guardedRelease = vi.fn(async (_ctx: JobContext) => ({ phase: "complete" }));
vi.mock("../admin-job-ops", () => ({ executeAdminJobOperation: executeAdminOperation }));
vi.mock("../system-release-application", () => ({ runGuardedSystemRelease: guardedRelease }));
const { handleSystemDiagnosticsJob, handleSystemUpdateJob } = await import("../system-maintenance");
const { JobObservationPending } = await import("../admin-job-failure");
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
const applyPayload = {
  operation: "apply",
  createBackup: true,
  releaseId: "release-checked",
  expectedDigest: "a".repeat(64),
};
describe("guarded system maintenance routing", () => {
  it("checks only the release manifest and inspection", async () => {
    await expect(handleSystemUpdateJob(context({ operation: "check" }))).resolves.toEqual({
      operation: "check",
      release: "release-123",
      currentReleaseId: "release-old",
      availableReleaseId: "release-123",
    });
    expect(executeAdminOperation.mock.calls.map((call) => call[1].kind)).toEqual([
      "release.resolve",
      "release.inspect",
    ]);
    expect(guardedRelease).not.toHaveBeenCalled();
  });
  it("delegates a checked update to the fixed configuration producer", async () => {
    const ctx = context({ ...applyPayload, workflow: "guarded-release" });
    await expect(handleSystemUpdateJob(ctx)).resolves.toEqual({ phase: "complete" });
    expect(guardedRelease).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(executeAdminOperation).not.toHaveBeenCalled();
  });
  it("keeps historical unmarked updates observation-only", async () => {
    await expect(handleSystemUpdateJob(context(applyPayload))).rejects.toBeInstanceOf(
      JobObservationPending,
    );
    expect(guardedRelease).not.toHaveBeenCalled();
    expect(executeAdminOperation).not.toHaveBeenCalled();
  });
  it.each([
    { ...applyPayload, expectedDigest: "bad" },
    { ...applyPayload, releaseId: undefined },
  ])("refuses an unchecked release", async (payload) => {
    await expect(
      handleSystemUpdateJob(context({ ...payload, workflow: "guarded-release" })),
    ).rejects.toThrow("Check a release");
    expect(guardedRelease).not.toHaveBeenCalled();
  });
  it("does not fall back to legacy updates after a guarded failure", async () => {
    guardedRelease.mockRejectedValueOnce(new JobObservationPending("recovery_required"));
    await expect(
      handleSystemUpdateJob(context({ ...applyPayload, workflow: "guarded-release" })),
    ).rejects.toBeInstanceOf(JobObservationPending);
    expect(executeAdminOperation).not.toHaveBeenCalled();
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
