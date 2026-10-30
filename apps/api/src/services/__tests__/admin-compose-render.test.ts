import { beforeEach, expect, it, vi } from "vitest";
import { AdminJobFailure, JobObservationPending } from "../admin-job-failure";
import type { JobContext } from "../job-runner";

const calls = vi.hoisted(() => ({
  publish: vi.fn(),
  links: vi.fn(),
  resume: vi.fn(),
  retained: vi.fn(),
}));
vi.mock("../retained-maintenance-authorization", () => ({ assertRetainedMaintenanceJob: vi.fn() }));
vi.mock("../service-preparation", () => ({
  publishServiceGeneration: calls.publish,
  applyGenerationHardlinks: calls.links,
}));
vi.mock("../admin-job-ops", () => ({ hasRetainedAdminJobOperation: calls.retained }));
vi.mock("../prospective-configuration", () => ({
  resumeRetainedConfigurationCandidate: calls.resume,
}));
vi.mock("../administrative-configuration-writer", () => ({
  withAdministrativeConfigurationJob: (_ctx: unknown, run: () => unknown) => run(),
  withAdministrativeConfigurationWriter: (_ctx: unknown, run: () => unknown) => run(),
}));
const { handleComposeRenderJob } = await import("../admin-compose-render");
const revision = `cfg1_${"a".repeat(43)}`,
  previous = `cfg1_${"b".repeat(43)}`;
function context() {
  const ctx = {
    jobId: "render-unit",
    jobType: "compose.render",
    payload: {
      expectedCurrentRevisionId: previous,
      coordinatorMode: "require-running",
      confirmed: true,
    },
    signal: new AbortController().signal,
    checkpointResult: {} as Record<string, unknown>,
    checkpoint: vi.fn(async (value: Record<string, unknown>) => {
      ctx.checkpointResult = value;
    }),
  };
  return ctx as unknown as JobContext;
}
beforeEach(() => {
  vi.clearAllMocks();
  calls.retained.mockReturnValue(false);
  calls.publish.mockResolvedValue({ revisionId: revision });
  calls.links.mockResolvedValue({
    applied: true,
    entries: 0,
    linked: 0,
    skipped: 0,
    pruned: 0,
    via: "none",
  });
});
it("binds the preview revision and admitted mode to generation and hardlinks", async () => {
  const ctx = context(),
    result = await handleComposeRenderJob(ctx);
  expect(calls.publish).toHaveBeenCalledWith(ctx, "compose-render", {
    coordinatorMode: "require-running",
    expectedCurrentRevisionId: previous,
  });
  expect(calls.links).toHaveBeenCalledWith(
    expect.objectContaining({ revisionId: revision, coordinatorMode: "require-running" }),
  );
  expect(result).toMatchObject({
    configuration: {
      outcome: "committed",
      revisionId: revision,
      followUp: "complete",
      restartRequired: true,
    },
  });
});
it("retains committed evidence when linking fails and never switches to ensure-running", async () => {
  calls.links.mockRejectedValue(new Error("Coordinator stopped"));
  const ctx = context();
  let failure: unknown;
  try {
    await handleComposeRenderJob(ctx);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AdminJobFailure);
  expect(failure).toMatchObject({
    result: { configuration: { outcome: "committed", revisionId: revision, followUp: "failed" } },
  });
  expect(calls.publish).toHaveBeenCalledTimes(1);
  expect(calls.links).toHaveBeenCalledTimes(1);
});
it("preserves an unresolved original hardlink operation for observation", async () => {
  const pending = new JobObservationPending("transport");
  calls.links.mockRejectedValue(pending);
  const ctx = context();
  await expect(handleComposeRenderJob(ctx)).rejects.toBe(pending);
  expect(ctx.checkpointResult).toMatchObject({
    configuration: { outcome: "committed", followUp: "not_started" },
  });
});
it("refuses a stale generation before hardlinks", async () => {
  calls.publish.mockRejectedValue(new Error("Revision conflict"));
  await expect(handleComposeRenderJob(context())).rejects.toThrow("Revision conflict");
  expect(calls.links).not.toHaveBeenCalled();
});
it("resumes the exact retained candidate instead of resealing a replacement", async () => {
  calls.resume.mockResolvedValue({
    configuration: {
      outcome: "committed",
      revisionId: revision,
      followUp: "complete",
      cleanupFailed: false,
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
      enabledServiceIds: [],
    },
  });
  const ctx = context();
  ctx.execution = { owner: "same-owner", version: 2 };
  ctx.checkpointResult = { _configurationCandidate: { operationKey: "original" } };
  await handleComposeRenderJob(ctx);
  expect(calls.resume).toHaveBeenCalledTimes(1);
  expect(calls.publish).not.toHaveBeenCalled();
  expect(calls.links).toHaveBeenCalledWith(expect.objectContaining({ revisionId: revision }));
});
it("refuses an altered coordinator mode before publication", async () => {
  const ctx = context();
  ctx.payload.coordinatorMode = "ensure-running";
  await expect(handleComposeRenderJob(ctx)).rejects.toThrow();
  expect(calls.publish).not.toHaveBeenCalled();
});
