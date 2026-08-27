import type {
  OpsEventBatch,
  OpsJobStatusFor,
  OpsOperationKind,
  OpsSubmitResult,
} from "@openmapx/core/ops";
import { describe, expect, it, vi } from "vitest";
import {
  type ApiOpsClient,
  ApiOpsError,
  createApiOpsClient,
  createDurableOpsKey,
  executeAndWait,
  followOpsEvents,
  waitForOpsResult,
} from "../ops-client.js";

function fakeClient(overrides: Partial<Record<keyof ApiOpsClient, unknown>> = {}): ApiOpsClient {
  return {
    execute: vi.fn(),
    status: vi.fn(),
    events: vi.fn(),
    cancel: vi.fn(),
    lookup: vi.fn(),
    ...overrides,
  } as ApiOpsClient;
}

describe("API ops client construction", () => {
  it("requires the private agent URL and token-file path without accepting a raw token", () => {
    expect(() => createApiOpsClient({})).toThrow("Ops agent configuration is unavailable");
    expect(() =>
      createApiOpsClient({
        OPS_AGENT_URL: "http://ops-agent:4300",
        OPS_AGENT_TOKEN: "secret-must-not-be-supported",
      }),
    ).toThrow("Ops agent configuration is unavailable");

    expect(
      createApiOpsClient({
        OPS_AGENT_URL: "http://ops-agent:4300",
        OPS_AGENT_TOKEN_FILE: "/run/secrets/ops-agent-api-token",
      }),
    ).toBeDefined();
  });

  it("derives stable, domain-separated operation keys from durable identities", () => {
    const first = createDurableOpsKey("admin-job.service.start", "job-123");
    expect(first).toBe(createDurableOpsKey("admin-job.service.start", "job-123"));
    expect(first).not.toBe(createDurableOpsKey("admin-job.service.stop", "job-123"));
    expect(first).not.toBe(createDurableOpsKey("admin-job.service.start", "job-456"));
    expect(first).toMatch(/^opk1_[A-Za-z0-9_-]{43}$/);
  });
});

describe("bounded async ops helpers", () => {
  it("recovers a disconnected admission by key lookup without creating a fresh follow", async () => {
    const controller = new AbortController();
    controller.abort();
    const operationKey = "opk1_lookupDisconnected000";
    const execute = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const lookup = vi.fn().mockResolvedValue({
      version: 1,
      operationId: "job1_lookupDisconnected000",
      operationKey,
      kind: "service.logs.follow",
      resourceId: "redis",
      state: "running",
      submittedAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-23T10:00:01.000Z",
    });
    const { submitOpsOperationWithRecovery } = await import("../ops-client.js");
    await expect(
      submitOpsOperationWithRecovery(
        fakeClient({ execute, lookup }),
        { kind: "service.logs.follow", serviceId: "redis", tail: 20, maxDurationSeconds: 900 },
        operationKey,
        { signal: controller.signal, admissionAlreadyAttempted: true },
      ),
    ).resolves.toMatchObject({ execution: "async", operationId: "job1_lookupDisconnected000" });
    expect(execute).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalled();
  });

  it("does not create a follow when disconnected lookup proves no admission before its bound", async () => {
    const execute = vi.fn();
    const lookup = vi.fn().mockRejectedValue(new ApiOpsError("not_found"));
    const { submitOpsOperationWithRecovery } = await import("../ops-client.js");
    await expect(
      submitOpsOperationWithRecovery(
        fakeClient({ execute, lookup }),
        { kind: "service.logs.follow", serviceId: "redis", tail: 20, maxDurationSeconds: 900 },
        "opk1_noOriginalAdmission000",
        {
          admissionAlreadyAttempted: true,
          recoveryTimeoutMs: 5,
        },
      ),
    ).rejects.toMatchObject({ errorClass: "timeout" });
    expect(execute).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalled();
  });
  it("recovers an admitted-but-response-lost operation with the exact same key", async () => {
    const operationKey = "opk1_ambiguousAdmission00";
    const admission = {
      execution: "async" as const,
      operationId: "job1_ambiguousAdmission00",
      operationKey,
      kind: "service.pull" as const,
      state: "running" as const,
    };
    const execute = vi.fn().mockRejectedValueOnce(new ApiOpsError("runtime"));
    const status = vi.fn().mockResolvedValue({
      version: 1,
      operationId: admission.operationId,
      operationKey,
      kind: admission.kind,
      resourceId: "redis",
      state: "succeeded",
      submittedAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-23T10:00:01.000Z",
      result: { changed: true },
    });
    const lookup = vi.fn().mockResolvedValue({
      version: 1,
      operationId: admission.operationId,
      operationKey,
      kind: admission.kind,
      resourceId: "redis",
      state: "running",
      submittedAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-23T10:00:00.500Z",
    });
    await expect(
      executeAndWait(
        fakeClient({ execute, status, lookup }),
        { kind: "service.pull", serviceId: "redis" },
        operationKey,
      ),
    ).resolves.toEqual({ changed: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      { kind: "service.pull", serviceId: "redis" },
      expect.objectContaining({ operationKey }),
    );
    expect(lookup).toHaveBeenCalledWith(
      { kind: "service.pull", serviceId: "redis" },
      operationKey,
      expect.anything(),
    );
  });

  it("retries bounded transient status failures but not authorization failures", async () => {
    const admission = {
      execution: "async" as const,
      operationId: "job1_transientStatus000",
      operationKey: "opk1_transientStatus000",
      kind: "service.pull" as const,
      state: "running" as const,
    };
    const success = {
      version: 1 as const,
      operationId: admission.operationId,
      operationKey: admission.operationKey,
      kind: admission.kind,
      resourceId: "redis",
      state: "succeeded" as const,
      submittedAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-23T10:00:01.000Z",
      result: { changed: true },
    };
    const transient = vi
      .fn()
      .mockRejectedValueOnce(new ApiOpsError("runtime"))
      .mockResolvedValue(success);
    await expect(
      waitForOpsResult(fakeClient({ status: transient }), admission.kind, admission, {
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({ changed: true });
    expect(transient).toHaveBeenCalledTimes(2);

    const denied = vi.fn().mockRejectedValue(new ApiOpsError("authorization"));
    await expect(
      waitForOpsResult(fakeClient({ status: denied }), admission.kind, admission),
    ).rejects.toMatchObject({ errorClass: "authorization" });
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("waits for and returns the exact typed terminal result", async () => {
    const admission: OpsSubmitResult<"service.start"> = {
      execution: "async",
      operationId: "job1_abcdefghijklmnop",
      operationKey: "opk1_abcdefghijklmnop",
      kind: "service.start",
      state: "queued",
    };
    const statuses: OpsJobStatusFor<"service.start">[] = [
      {
        version: 1,
        operationId: admission.operationId,
        operationKey: admission.operationKey,
        kind: "service.start",
        resourceId: "redis",
        state: "running",
        submittedAt: "2026-08-23T10:00:00.000Z",
        updatedAt: "2026-08-23T10:00:01.000Z",
      },
      {
        version: 1,
        operationId: admission.operationId,
        operationKey: admission.operationKey,
        kind: "service.start",
        resourceId: "redis",
        state: "succeeded",
        submittedAt: "2026-08-23T10:00:00.000Z",
        updatedAt: "2026-08-23T10:00:02.000Z",
        result: { changed: true },
      },
    ];
    const client = fakeClient({
      status: vi.fn(async () => statuses.shift() as OpsJobStatusFor<OpsOperationKind>),
    });

    await expect(
      waitForOpsResult(client, "service.start", admission, {
        pollIntervalMs: 1,
        timeoutMs: 100,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({ changed: true });
    expect(client.status).toHaveBeenCalledTimes(2);
  });

  it("translates terminal failure and local timeout without leaking details", async () => {
    const admission = {
      execution: "async" as const,
      operationId: "job1_abcdefghijklmnop",
      operationKey: "opk1_abcdefghijklmnop",
      kind: "service.restart" as const,
      state: "running" as const,
    };
    const failed = fakeClient({
      status: vi.fn(async () => ({
        version: 1,
        operationId: admission.operationId,
        operationKey: admission.operationKey,
        kind: admission.kind,
        resourceId: "redis",
        state: "failed",
        errorClass: "runtime",
        submittedAt: "2026-08-23T10:00:00.000Z",
        updatedAt: "2026-08-23T10:00:01.000Z",
      })),
    });
    await expect(waitForOpsResult(failed, admission.kind, admission)).rejects.toMatchObject({
      name: "ApiOpsError",
      errorClass: "runtime",
      message: "Operations request failed",
    });

    let now = 0;
    const running = fakeClient({
      status: vi.fn(async () => ({
        version: 1,
        operationId: admission.operationId,
        operationKey: admission.operationKey,
        kind: admission.kind,
        resourceId: "redis",
        state: "running",
        submittedAt: "2026-08-23T10:00:00.000Z",
        updatedAt: "2026-08-23T10:00:01.000Z",
      })),
    });
    const timedOut = waitForOpsResult(running, admission.kind, admission, {
      timeoutMs: 10,
      pollIntervalMs: 5,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await expect(timedOut).rejects.toEqual(new ApiOpsError("timeout"));
  });

  it("rejects a status bound to a different operation key", async () => {
    const admission = {
      execution: "async" as const,
      operationId: "job1_abcdefghijklmnop",
      operationKey: "opk1_abcdefghijklmnop",
      kind: "service.start" as const,
      state: "running" as const,
    };
    const client = fakeClient({
      status: vi.fn(async () => ({
        version: 1,
        operationId: admission.operationId,
        operationKey: "opk1_ponmlkjihgfedcba",
        kind: admission.kind,
        resourceId: "redis",
        state: "succeeded",
        submittedAt: "2026-08-23T10:00:00.000Z",
        updatedAt: "2026-08-23T10:00:01.000Z",
        result: { changed: true },
      })),
    });
    await expect(waitForOpsResult(client, admission.kind, admission)).rejects.toMatchObject({
      name: "ApiOpsError",
      errorClass: "runtime",
    });
  });

  it("removes the sleep abort listener after every normal poll", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const admission = {
      execution: "async" as const,
      operationId: "job1_abcdefghijklmnop",
      operationKey: "opk1_abcdefghijklmnop",
      kind: "service.stop" as const,
      state: "queued" as const,
    };
    const status = vi
      .fn()
      .mockResolvedValueOnce({
        version: 1,
        operationId: admission.operationId,
        operationKey: admission.operationKey,
        kind: admission.kind,
        resourceId: "redis",
        state: "running",
        submittedAt: "2026-08-23T10:00:00.000Z",
        updatedAt: "2026-08-23T10:00:01.000Z",
      })
      .mockResolvedValueOnce({
        version: 1,
        operationId: admission.operationId,
        operationKey: admission.operationKey,
        kind: admission.kind,
        resourceId: "redis",
        state: "succeeded",
        submittedAt: "2026-08-23T10:00:00.000Z",
        updatedAt: "2026-08-23T10:00:02.000Z",
        result: { changed: true },
      });
    await waitForOpsResult(fakeClient({ status }), admission.kind, admission, {
      signal: controller.signal,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("streams bounded event pages and stops promptly on caller cancellation", async () => {
    const controller = new AbortController();
    const batches: OpsEventBatch[] = [
      {
        version: 1,
        operationId: "job1_abcdefghijklmnop",
        nextCursor: 2,
        terminal: false,
        truncated: false,
        events: [
          { cursor: 1, type: "state", state: "running" },
          { cursor: 2, type: "log", stream: "stdout", message: "ready" },
        ],
      },
    ];
    const events = vi.fn(async () => {
      const batch = batches.shift();
      if (!batch) throw new Error("must not fetch after cancellation");
      controller.abort();
      return batch;
    });
    const client = fakeClient({ events });
    const seen: string[] = [];

    await expect(
      followOpsEvents(client, "job1_abcdefghijklmnop", {
        signal: controller.signal,
        maxEvents: 2,
        maxBytes: 5,
        onLog: (stream, message) => {
          seen.push(`${stream}:${message}`);
        },
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual(["stdout:ready"]);
    expect(events).toHaveBeenCalledWith("job1_abcdefghijklmnop", {
      after: 0,
      limit: 2,
      signal: controller.signal,
    });
    expect(events).toHaveBeenCalledTimes(1);
    expect(client.cancel).toHaveBeenCalledWith("job1_abcdefghijklmnop", {
      signal: expect.any(AbortSignal),
    });
  });

  it("resumes from a durable cursor and preserves the total event and byte budgets", async () => {
    const progress = vi.fn();
    const events = vi.fn().mockResolvedValue({
      version: 1,
      operationId: "job1_abcdefghijklmnop",
      nextCursor: 42,
      terminal: true,
      truncated: false,
      events: [{ cursor: 42, type: "log", stream: "stderr", message: "new" }],
    });
    const result = await followOpsEvents(fakeClient({ events }), "job1_abcdefghijklmnop", {
      maxEvents: 2_000,
      maxBytes: 1024 * 1024,
      initial: { cursor: 41, events: 17, bytes: 99, truncated: false },
      onProgress: progress,
      onLog: vi.fn(),
    });
    expect(events).toHaveBeenCalledWith("job1_abcdefghijklmnop", {
      after: 41,
      limit: 100,
      signal: undefined,
    });
    expect(result).toEqual({ cursor: 42, events: 18, bytes: 102, truncated: false });
    expect(progress).toHaveBeenLastCalledWith(result);
  });

  it("durably checkpoints an already-exhausted event budget before returning truncated", async () => {
    const progress = vi.fn();
    const events = vi.fn();
    const result = await followOpsEvents(fakeClient({ events }), "job1_abcdefghijklmnop", {
      maxEvents: 2_000,
      maxBytes: 1024 * 1024,
      initial: { cursor: 10, events: 2_000, bytes: 99, truncated: false },
      onProgress: progress,
      onLog: vi.fn(),
    });

    expect(events).not.toHaveBeenCalled();
    expect(result).toEqual({ cursor: 10, events: 2_000, bytes: 99, truncated: true });
    expect(progress).toHaveBeenLastCalledWith(result);
  });

  it("checkpoints past an over-budget event so a restart cannot replay its page", async () => {
    const progress = vi.fn();
    const onLog = vi.fn();
    const events = vi.fn().mockResolvedValue({
      version: 1,
      operationId: "job1_abcdefghijklmnop",
      nextCursor: 12,
      terminal: true,
      truncated: false,
      events: [
        { cursor: 11, type: "log", stream: "stdout", message: "aaaa" },
        { cursor: 12, type: "log", stream: "stdout", message: "over-budget" },
      ],
    });
    const result = await followOpsEvents(fakeClient({ events }), "job1_abcdefghijklmnop", {
      maxEvents: 2_000,
      maxBytes: 8,
      initial: { cursor: 10, events: 0, bytes: 0, truncated: false },
      onProgress: progress,
      onLog,
    });

    // The first event fit and was emitted; the second exceeded the budget.
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ cursor: 12, events: 2, bytes: 4, truncated: true });
    expect(result.cursor).toBeGreaterThan(10);
    expect(progress).toHaveBeenLastCalledWith(result);
  });

  it("checkpoints truncation when the final page exactly reaches the event limit", async () => {
    const progress = vi.fn();
    const events = vi.fn().mockResolvedValue({
      version: 1,
      operationId: "job1_abcdefghijklmnop",
      nextCursor: 12,
      terminal: false,
      truncated: false,
      events: [{ cursor: 12, type: "log", stream: "stdout", message: "x" }],
    });
    const result = await followOpsEvents(fakeClient({ events }), "job1_abcdefghijklmnop", {
      maxEvents: 2,
      maxBytes: 1024,
      initial: { cursor: 11, events: 1, bytes: 0, truncated: false },
      onProgress: progress,
      onLog: vi.fn(),
      cancelOnExit: false,
    });

    expect(result).toEqual({ cursor: 12, events: 2, bytes: 1, truncated: true });
    expect(progress).toHaveBeenLastCalledWith(result);
  });
});
