import { afterEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const rows: Array<{ id: string; result: unknown }> = [];
  const updates: Array<Record<string, unknown>> = [];
  const emptyResult = () => Promise.resolve([]);
  const selectResult = () =>
    Object.assign(Promise.resolve([...rows]), {
      orderBy: () => ({ limit: emptyResult }),
    });
  return {
    rows,
    updates,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(selectResult) })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updates.push(values);
          return {
            where: vi.fn(() => Object.assign(emptyResult(), { returning: emptyResult })),
          };
        }),
      })),
    },
  };
});

vi.mock("../../db", () => ({ db: dbMock.db }));

const { jobRunner } = await import("../job-runner");

const restartCheckpoint = {
  phase: "awaiting-app-api-restart",
  helperContainerId: "d".repeat(64),
  previousContainerId: "a".repeat(64),
  expectedImageId: `sha256:${"c".repeat(64)}`,
  outcomeFile: "/repo/infra/docker/.maintenance/app-api-update-1.status",
};

const replacementRuntime = {
  containerId: "e".repeat(64),
  imageId: restartCheckpoint.expectedImageId,
  updateJobId: "update-1",
};
const appliedOutcome = vi.fn(async () => "applied" as const);
const cleanupOutcome = vi.fn(async () => undefined);

afterEach(() => {
  dbMock.rows.length = 0;
  dbMock.updates.length = 0;
  vi.clearAllMocks();
});

describe("job runner restart initialization", () => {
  it("finalizes a checkpointed update after successful migrations", async () => {
    dbMock.rows.push({ id: "update-1", result: restartCheckpoint });

    await jobRunner.initialize({
      completeRestartedUpdates: true,
      currentAppApiRuntime: replacementRuntime,
      resolveReplacementOutcome: appliedOutcome,
      cleanupReplacementOutcome: cleanupOutcome,
    });

    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "success",
        progress: 100,
        result: { phase: "complete", completedAfterRestart: true },
      }),
    );
  });

  it("fails a checkpointed update when startup migrations failed", async () => {
    dbMock.rows.push({ id: "update-1", result: restartCheckpoint });

    await jobRunner.initialize({
      completeRestartedUpdates: false,
      currentAppApiRuntime: replacementRuntime,
      resolveReplacementOutcome: appliedOutcome,
    });

    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error: "Update replaced app-api, but database migrations did not complete",
      }),
    );
    expect(dbMock.updates).not.toContainEqual(expect.objectContaining({ status: "success" }));
  });

  it("fails a checkpointed update when the replacement image does not match", async () => {
    dbMock.rows.push({ id: "update-1", result: restartCheckpoint });

    await jobRunner.initialize({
      completeRestartedUpdates: true,
      currentAppApiRuntime: { ...replacementRuntime, imageId: `sha256:${"f".repeat(64)}` },
      resolveReplacementOutcome: appliedOutcome,
    });

    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error: "Update restarted app-api with an unexpected container identity or image",
      }),
    );
    expect(dbMock.updates).not.toContainEqual(expect.objectContaining({ status: "success" }));
  });

  it("records a failed update when the helper restored the previous image", async () => {
    dbMock.rows.push({ id: "update-1", result: restartCheckpoint });

    await jobRunner.initialize({
      completeRestartedUpdates: true,
      currentAppApiRuntime: {
        ...replacementRuntime,
        imageId: `sha256:${"b".repeat(64)}`,
      },
      resolveReplacementOutcome: async () => "rolled-back",
    });

    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error: "Update failed; the previous app-api image was restored",
      }),
    );
    expect(dbMock.updates).not.toContainEqual(expect.objectContaining({ status: "success" }));
  });

  it("does not accept the former phase-only checkpoint", async () => {
    dbMock.rows.push({ id: "update-1", result: { phase: "awaiting-app-api-restart" } });

    await jobRunner.initialize({
      completeRestartedUpdates: true,
      currentAppApiRuntime: replacementRuntime,
      resolveReplacementOutcome: appliedOutcome,
    });

    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error: "Job interrupted by api restart — re-run if still needed",
      }),
    );
    expect(dbMock.updates).not.toContainEqual(expect.objectContaining({ status: "success" }));
  });
});
