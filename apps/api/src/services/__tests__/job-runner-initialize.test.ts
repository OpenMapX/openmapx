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

afterEach(() => {
  dbMock.rows.length = 0;
  dbMock.updates.length = 0;
  vi.clearAllMocks();
});

describe("job runner restart initialization", () => {
  it("finalizes a checkpointed update after successful migrations", async () => {
    dbMock.rows.push({ id: "update-1", result: { phase: "awaiting-app-api-restart" } });

    await jobRunner.initialize({ completeRestartedUpdates: true });

    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "success",
        progress: 100,
        result: { phase: "complete", completedAfterRestart: true },
      }),
    );
  });

  it("fails a checkpointed update when startup migrations failed", async () => {
    dbMock.rows.push({ id: "update-1", result: { phase: "awaiting-app-api-restart" } });

    await jobRunner.initialize({ completeRestartedUpdates: false });

    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error: "Update replaced app-api, but database migrations did not complete",
      }),
    );
    expect(dbMock.updates).not.toContainEqual(expect.objectContaining({ status: "success" }));
  });
});
