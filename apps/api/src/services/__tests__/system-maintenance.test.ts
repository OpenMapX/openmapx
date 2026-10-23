import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner";
import { type ApiOpsClient, ApiOpsError } from "../ops-client";

let agentReplaced: boolean | Error = false;
const executeAdminOperation = vi.fn(async (_ctx: JobContext, operation: { kind: string }) => {
  if (operation.kind === "system.diagnostics") return { ok: true, checks: [] };
  if (operation.kind === "release.inspect") {
    return { currentReleaseId: "release-old", availableReleaseId: "release-123" };
  }
  if (operation.kind === "agent.update") {
    if (agentReplaced instanceof Error) throw agentReplaced;
    return { handoffId: "handoff", replaced: agentReplaced };
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

beforeEach(() => {
  vi.clearAllMocks();
  agentReplaced = false;
});

/** A fake agent answering handoff inspections in order; Errors model a restarting agent. */
function handoffClient(answers: Array<string | Error>) {
  let index = 0;
  const execute = vi.fn(async () => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer instanceof Error) throw answer;
    return {
      execution: "sync" as const,
      value: {
        handoffId: "handoff",
        phase: answer,
        ...(answer === "rolled_back" ? { reason: "The new agent stopped" } : {}),
      },
    };
  });
  let clock = 0;
  return {
    execute,
    dependencies: {
      client: { execute } as unknown as ApiOpsClient,
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    },
  };
}

const applyPayload = {
  operation: "apply",
  createBackup: true,
  releaseId: "release-checked",
  expectedDigest: "a".repeat(64),
};

describe("agent-owned system maintenance", () => {
  it("checks a release from its manifest without downloading images", async () => {
    const ctx = context({ operation: "check" });
    await expect(handleSystemUpdateJob(ctx)).resolves.toEqual({
      operation: "check",
      release: "release-123",
      currentReleaseId: "release-old",
      availableReleaseId: "release-123",
    });
    expect(executeAdminOperation.mock.calls.map((call) => call.slice(1))).toEqual([
      [{ kind: "release.resolve" }, "admin-job.release.resolve"],
      [{ kind: "release.inspect" }, "admin-job.release.inspect"],
    ]);
  });

  it("downloads the checked release before delegating backup and application", async () => {
    const ctx = context({
      operation: "apply",
      createBackup: true,
      releaseId: "release-checked",
      expectedDigest: "a".repeat(64),
    });
    await expect(handleSystemUpdateJob(ctx)).resolves.toEqual({
      operation: "apply",
      release: "release-123",
      phase: "complete",
    });
    expect(executeAdminOperation.mock.calls.map((call) => call[1].kind)).toEqual([
      "release.pull",
      "agent.update",
      "system.update",
    ]);
    expect(executeAdminOperation).toHaveBeenNthCalledWith(
      1,
      ctx,
      { kind: "release.pull", releaseId: "release-checked" },
      "admin-job.release.pull",
    );
    expect(executeAdminOperation).toHaveBeenLastCalledWith(
      ctx,
      {
        kind: "system.update",
        releaseId: "release-checked",
        expectedDigest: "a".repeat(64),
        createBackup: true,
        backupId: "pre-update-job-1",
      },
      "admin-job.system.update",
    );
    expect(ctx.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        _completion: expect.objectContaining({ operationKey: expect.stringMatching(/^opk1_/) }),
      }),
    );
    expect(
      executeAdminOperation.mock.calls.some((call) => call[1].kind === "release.resolve"),
    ).toBe(false);
  });

  it("replaces an outdated agent and waits for it before updating the application", async () => {
    agentReplaced = true;
    const agent = handoffClient([new Error("connection refused"), "recreated", "applied"]);
    const ctx = context(applyPayload);
    await expect(handleSystemUpdateJob(ctx, agent.dependencies)).resolves.toMatchObject({
      phase: "complete",
    });
    expect(agent.execute).toHaveBeenCalledTimes(3);
    expect(executeAdminOperation.mock.calls.map((call) => call[1].kind)).toEqual([
      "release.pull",
      "agent.update",
      "system.update",
    ]);
    const update = executeAdminOperation.mock.calls[1]?.[1] as { handoffId?: string };
    expect(agent.execute).toHaveBeenCalledWith(
      { kind: "agent.handoff.inspect", handoffId: update.handoffId },
      expect.anything(),
    );
  });

  it("stops before the application when the agent replacement was rolled back", async () => {
    agentReplaced = true;
    const agent = handoffClient(["overlay_written", "rolled_back"]);
    const ctx = context(applyPayload);
    await expect(handleSystemUpdateJob(ctx, agent.dependencies)).rejects.toThrow(
      "previous agent was restored: The new agent stopped",
    );
    expect(ctx.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "host_update_required" }),
    );
    expect(executeAdminOperation.mock.calls.some((call) => call[1].kind === "system.update")).toBe(
      false,
    );
  });

  it("follows the handoff when the old agent stopped before returning its result", async () => {
    agentReplaced = new ApiOpsError("runtime");
    const agent = handoffClient([new Error("connection refused"), "applied"]);
    await expect(
      handleSystemUpdateJob(context(applyPayload), agent.dependencies),
    ).resolves.toMatchObject({ phase: "complete" });
  });

  it("fails a lost update result when the agent never recorded the handoff", async () => {
    agentReplaced = new ApiOpsError("runtime");
    const agent = handoffClient(["none"]);
    await expect(handleSystemUpdateJob(context(applyPayload), agent.dependencies)).rejects.toThrow(
      "Operations request failed",
    );
    expect(executeAdminOperation.mock.calls.some((call) => call[1].kind === "system.update")).toBe(
      false,
    );
  });

  it("explains that the agent is busy with other operations", async () => {
    agentReplaced = new ApiOpsError("busy");
    const agent = handoffClient(["applied"]);
    await expect(handleSystemUpdateJob(context(applyPayload), agent.dependencies)).rejects.toThrow(
      "Other operations are running on the operations agent",
    );
    expect(agent.execute).not.toHaveBeenCalled();
  });

  it("does not guess about agent update errors that prove it did not run", async () => {
    agentReplaced = new ApiOpsError("validation");
    const agent = handoffClient(["applied"]);
    await expect(
      handleSystemUpdateJob(context(applyPayload), agent.dependencies),
    ).rejects.toThrow();
    expect(agent.execute).not.toHaveBeenCalled();
  });

  it("gives up when the agent replacement never finishes", async () => {
    agentReplaced = true;
    const agent = handoffClient(["recreated"]);
    await expect(handleSystemUpdateJob(context(applyPayload), agent.dependencies)).rejects.toThrow(
      "did not finish in time",
    );
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
