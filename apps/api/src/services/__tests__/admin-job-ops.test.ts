import type { OpsOperation } from "@openmapx/core/ops";
import { describe, expect, it, vi } from "vitest";
import { cancelAdminJobOperations, executeAdminJobOperation } from "../admin-job-ops";
import type { JobContext } from "../job-runner";

function context(): JobContext {
  return {
    jobId: "1d2b29cd-23de-4b19-8c32-86c196833b79",
    payload: {},
    signal: new AbortController().signal,
    log: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    checkpoint: vi.fn().mockResolvedValue(undefined),
  };
}

describe("administrative job operations broker", () => {
  it("submits an exact typed operation under a deterministic durable key", async () => {
    const ctx = context();
    const operation = { kind: "backup.create", backupId: "nightly" } as const;
    const execute = vi.fn().mockResolvedValue({
      execution: "sync",
      kind: operation.kind,
      value: { backupId: "nightly" },
    });

    await expect(
      executeAdminJobOperation(ctx, operation, "admin-job.backup.create", {
        client: { execute } as never,
      }),
    ).resolves.toEqual({ backupId: "nightly" });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toEqual(operation);
    expect(execute.mock.calls[0]?.[1]).toEqual({
      operationKey: expect.stringMatching(/^opk1_[A-Za-z0-9_-]+$/),
      signal: ctx.signal,
    });
  });

  it("mirrors bounded durable agent events without cancelling a running operation", async () => {
    const ctx = context();
    const operation: Extract<OpsOperation, { kind: "backup.delete" }> = {
      kind: "backup.delete",
      backupId: "nightly",
    };
    const operationKey = "opk1_abcdefghijklmnop";
    const operationId = "job1_abcdefghijklmnop";
    const cancel = vi.fn();
    const client = {
      execute: vi.fn().mockResolvedValue({
        execution: "async",
        kind: operation.kind,
        operationId,
        operationKey,
        state: "queued",
      }),
      lookup: vi.fn(),
      status: vi.fn().mockResolvedValue({
        version: 1,
        kind: operation.kind,
        operationId,
        operationKey,
        resourceId: "nightly",
        state: "succeeded",
        submittedAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:01.000Z",
        result: { backupId: "nightly" },
      }),
      events: vi.fn().mockResolvedValue({
        version: 1,
        operationId,
        nextCursor: 1,
        terminal: true,
        truncated: false,
        events: [{ cursor: 1, type: "log", stream: "stdout", message: "done" }],
      }),
      cancel,
    };

    await expect(
      executeAdminJobOperation(ctx, operation, "admin-job.backup.delete", {
        client: client as never,
        operationKey,
        pollIntervalMs: 1,
      }),
    ).resolves.toEqual({ backupId: "nightly" });

    expect(ctx.log).toHaveBeenCalledWith("done", "stdout", `ops:${operationId}:1`, 1);
    expect(client.events).toHaveBeenCalledWith(operationId, {
      after: 0,
      limit: 100,
      signal: ctx.signal,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(ctx.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        opsProjection: expect.objectContaining({
          version: 1,
          eventTotal: 1,
          byteTotal: 4,
          operations: expect.objectContaining({
            [operationKey]: expect.objectContaining({
              operationId,
              cursor: 1,
              terminal: true,
            }),
          }),
        }),
      }),
    );
  });

  it("reconstructs admission and resumes after the persisted cursor without duplicate logs", async () => {
    const operation = { kind: "backup.delete", backupId: "nightly" } as const;
    const operationKey = "opk1_abcdefghijklmnop";
    const operationId = "job1_abcdefghijklmnop";
    const ctx = context();
    ctx.checkpointResult = {
      opsProjection: {
        version: 1,
        eventTotal: 1,
        byteTotal: 4,
        truncated: false,
        operations: {
          [operationKey]: {
            kind: operation.kind,
            operationKey,
            operationId,
            cursor: 1,
            events: 1,
            bytes: 4,
            truncated: false,
            terminal: false,
          },
        },
      },
    };
    const execute = vi.fn();
    const events = vi.fn().mockResolvedValue({
      version: 1,
      operationId,
      nextCursor: 2,
      terminal: true,
      truncated: false,
      events: [{ cursor: 2, type: "log", stream: "stdout", message: "next" }],
    });
    const client = {
      execute,
      lookup: vi.fn().mockResolvedValue({
        version: 1,
        operationId,
        operationKey,
        kind: operation.kind,
        resourceId: "nightly",
        state: "running",
        submittedAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:01.000Z",
      }),
      status: vi.fn().mockResolvedValue({
        version: 1,
        operationId,
        operationKey,
        kind: operation.kind,
        resourceId: "nightly",
        state: "succeeded",
        submittedAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:02.000Z",
        result: { backupId: "nightly" },
      }),
      events,
      cancel: vi.fn(),
    };
    await executeAdminJobOperation(ctx, operation, "admin-job.backup.delete", {
      client: client as never,
      operationKey,
      pollIntervalMs: 1,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledWith(operationId, {
      after: 1,
      limit: 100,
      signal: ctx.signal,
    });
    expect(ctx.log).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith("next", "stdout", `ops:${operationId}:2`, 2);
  });

  it("requests exact agent cancellation and treats response loss as pending until terminal", async () => {
    const operationId = "job1_abcdefghijklmnop";
    const projection = {
      opsProjection: {
        version: 1,
        eventTotal: 0,
        byteTotal: 0,
        truncated: false,
        operations: {
          opk1_abcdefghijklmnop: {
            kind: "backup.create",
            operationKey: "opk1_abcdefghijklmnop",
            operationId,
            cursor: 0,
            events: 0,
            bytes: 0,
            truncated: false,
            terminal: false,
          },
        },
      },
    };
    const client = {
      cancel: vi.fn().mockRejectedValue(new Error("response lost")),
      status: vi
        .fn()
        .mockResolvedValueOnce({
          state: "termination_pending",
          kind: "backup.create",
          operationId,
          operationKey: "opk1_abcdefghijklmnop",
        })
        .mockResolvedValueOnce({
          state: "failed",
          kind: "backup.create",
          operationId,
          operationKey: "opk1_abcdefghijklmnop",
          errorClass: "runtime",
        }),
    };
    await expect(
      cancelAdminJobOperations(projection, client as never, {
        pollIntervalMs: 1,
        sleep: async () => undefined,
      }),
    ).resolves.toBe("canceled");
    expect(client.cancel).toHaveBeenCalledWith(operationId, {
      signal: expect.any(AbortSignal),
    });
    expect(client.status).toHaveBeenCalledTimes(2);
  });

  it("reports containment when one operation is canceled alongside a succeeded sibling", async () => {
    const succeededId = "job1_abcdefghijklmnop";
    const canceledId = "job1_bbbbbbbbbbbbbbbb";
    const projection = {
      opsProjection: {
        version: 1,
        eventTotal: 0,
        byteTotal: 0,
        truncated: false,
        operations: {
          opk1_abcdefghijklmnop: {
            kind: "backup.create",
            operationKey: "opk1_abcdefghijklmnop",
            operationId: succeededId,
            cursor: 0,
            events: 0,
            bytes: 0,
            truncated: false,
            terminal: false,
          },
          opk1_bbbbbbbbbbbbbbbb: {
            kind: "backup.create",
            operationKey: "opk1_bbbbbbbbbbbbbbbb",
            operationId: canceledId,
            cursor: 0,
            events: 0,
            bytes: 0,
            truncated: false,
            terminal: false,
          },
        },
      },
    };
    const client = {
      cancel: vi.fn(async (operationId: string) =>
        operationId === succeededId
          ? {
              state: "succeeded",
              kind: "backup.create",
              operationId: succeededId,
              operationKey: "opk1_abcdefghijklmnop",
              result: {},
            }
          : {
              state: "failed",
              kind: "backup.create",
              operationId: canceledId,
              operationKey: "opk1_bbbbbbbbbbbbbbbb",
              errorClass: "runtime",
              terminationRequestedAt: "2026-08-25T00:00:00.000Z",
            },
      ),
      status: vi.fn(),
    };

    // A succeeded sibling must not mask the operation this request contained:
    // reporting "completed" would restore the job to running.
    await expect(
      cancelAdminJobOperations(projection, client as never, {
        pollIntervalMs: 1,
        sleep: async () => undefined,
      }),
    ).resolves.toBe("canceled");
  });

  it("does not claim a cancellation for a failure that predates the request", async () => {
    const operationId = "job1_abcdefghijklmnop";
    const projection = {
      opsProjection: {
        version: 1,
        eventTotal: 0,
        byteTotal: 0,
        truncated: false,
        operations: {
          opk1_abcdefghijklmnop: {
            kind: "backup.create",
            operationKey: "opk1_abcdefghijklmnop",
            operationId,
            cursor: 0,
            events: 0,
            bytes: 0,
            truncated: false,
            terminal: false,
          },
        },
      },
    };
    // The agent returns an already-terminal job unchanged, so there is no
    // `termination_pending` transition and no durable marker.
    const client = {
      cancel: vi.fn().mockResolvedValue({
        state: "failed",
        kind: "backup.create",
        operationId,
        operationKey: "opk1_abcdefghijklmnop",
        errorClass: "runtime",
      }),
      status: vi.fn(),
    };

    await expect(
      cancelAdminJobOperations(projection, client as never, {
        pollIntervalMs: 1,
        sleep: async () => undefined,
      }),
    ).resolves.toBe("already_terminal");
  });
});
