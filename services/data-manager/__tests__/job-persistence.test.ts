import { beforeEach, describe, expect, it, vi } from "vitest";

interface InsertCall {
  values: Record<string, unknown>;
}

interface UpdateCall {
  values: Record<string, unknown>;
  predicate?: unknown;
}

const insertCalls: InsertCall[] = [];
const updateCalls: UpdateCall[] = [];
let returnedRows: Array<{ id: string }> = [];
let insertError: Error | null = null;

vi.mock("../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertCalls.push({ values });
        return {
          returning: () =>
            insertError ? Promise.reject(insertError) : Promise.resolve(returnedRows),
          // biome-ignore lint/suspicious/noThenProperty: models Drizzle's thenable query builder
          then: (
            onFulfilled: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) =>
            (insertError ? Promise.reject(insertError) : Promise.resolve()).then(
              onFulfilled,
              onRejected,
            ),
        };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        const call: UpdateCall = { values };
        updateCalls.push(call);
        return {
          where: (predicate: unknown) => {
            call.predicate = predicate;
            return Promise.resolve();
          },
        };
      },
    }),
  },
}));

beforeEach(() => {
  insertCalls.length = 0;
  updateCalls.length = 0;
  returnedRows = [];
  insertError = null;
});

describe("job persistence", () => {
  it("creates a running job with the requested identity", async () => {
    const { createJobRow } = await import("../src/jobs/persistence.js");
    returnedRows = [{ id: "job-1" }];

    await expect(
      createJobRow({
        kind: "example-sync",
        triggeredBy: "cron",
        metadata: { sourceId: "example" },
      }),
    ).resolves.toBe("job-1");
    expect(insertCalls[0]?.values).toEqual({
      kind: "example-sync",
      status: "running",
      triggeredBy: "cron",
      metadata: { sourceId: "example" },
    });
  });

  it("fails when no job row is returned", async () => {
    const { createJobRow } = await import("../src/jobs/persistence.js");
    await expect(createJobRow({ kind: "example-sync" })).rejects.toThrow(
      "Failed to create data_manager.jobs row",
    );
  });

  it("finalizes a job with a completion timestamp", async () => {
    const { finalizeJobRow } = await import("../src/jobs/persistence.js");
    const before = Date.now();

    await finalizeJobRow("job-1", "partial");

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.values.status).toBe("partial");
    const finishedAt = updateCalls[0]?.values.finishedAt;
    expect(finishedAt).toBeInstanceOf(Date);
    expect((finishedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("converts timestamps and scrubs diagnostics without mutating the result", async () => {
    const { makePersistingOnStageComplete } = await import("../src/jobs/persistence.js");
    const result = {
      stage: "fetch",
      status: "error",
      startedAt: "2026-08-21T00:00:00.000Z",
      finishedAt: "2026-08-21T00:00:01.000Z",
      durationMs: 1_000,
      message: "fetch https://user:MESSAGE-PASSWORD@example.org/feed?token=MESSAGE-TOKEN failed",
      error: {
        message: "Authorization: Bearer ERROR-BEARER-TOKEN",
        stack: "at fetch (https://example.org/feed?key=STACK-TOKEN)",
      },
      artifacts: {
        stderr: "download https://user:ARTIFACT-PASSWORD@example.org/feed?key=ARTIFACT-TOKEN",
      },
    };
    const hook = makePersistingOnStageComplete("job-1", { warn: vi.fn() }, "example");

    await hook(result);

    const persisted = insertCalls[0]?.values;
    expect(persisted?.startedAt).toEqual(new Date(result.startedAt));
    expect(persisted?.finishedAt).toEqual(new Date(result.finishedAt));
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toMatch(
      /MESSAGE-PASSWORD|MESSAGE-TOKEN|ERROR-BEARER-TOKEN|STACK-TOKEN|ARTIFACT-PASSWORD|ARTIFACT-TOKEN/,
    );
    expect(serialized).toContain("example.org");
    expect(serialized).toContain("[redacted]");
    expect(result.message).toContain("MESSAGE-TOKEN");
  });

  it("normalizes absent diagnostics and swallows redacted persistence errors", async () => {
    const { makePersistingOnStageComplete } = await import("../src/jobs/persistence.js");
    const warn = vi.fn();
    const hook = makePersistingOnStageComplete("job-1", { warn }, "example");
    const result = {
      stage: "promote",
      status: "skipped",
      startedAt: "2026-08-21T00:00:00.000Z",
      finishedAt: "2026-08-21T00:00:00.000Z",
      durationMs: 0,
    };

    await hook(result);
    expect(insertCalls[0]?.values).toMatchObject({ message: null, error: null, artifacts: null });

    insertError = new Error(
      "connection https://db-user:DB-PASSWORD@db.example.org/openmapx?token=DB-TOKEN refused",
    );
    await expect(hook(result)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db.example.org"));
    expect(warn.mock.calls[0]?.[0]).not.toMatch(/DB-PASSWORD|DB-TOKEN|db-user/);
  });
});
