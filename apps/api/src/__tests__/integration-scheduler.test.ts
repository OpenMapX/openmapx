import type { Logger, ScheduleOptions } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIntegrationScheduler,
  type IntegrationScheduler,
  type TaskRunStore,
} from "../integration-scheduler";
import { currentIntegrationScope, type IntegrationScope } from "../integration-scope";

interface Row {
  id: string;
  integrationId: string;
  taskName: string;
  status: "running" | "succeeded" | "failed";
  error: string | null;
}

/** An in-memory run table with the one-running-row-per-task index of the real one. */
function memoryRuns() {
  const table: Row[] = [];
  let next = 0;
  const store: TaskRunStore & {
    rows(taskName: string): Row[];
    table: Row[];
  } = {
    table,
    rows: (taskName) => table.filter((row) => row.taskName === taskName),
    async start(integrationId, taskName) {
      if (
        table.some(
          (row) =>
            row.integrationId === integrationId &&
            row.taskName === taskName &&
            row.status === "running",
        )
      )
        return null;
      next += 1;
      const id = `run-${next}`;
      table.push({ id, integrationId, taskName, status: "running", error: null });
      return id;
    },
    async finish(runId, status, error) {
      const row = table.find((candidate) => candidate.id === runId);
      if (row?.status !== "running") return;
      row.status = status;
      row.error = error ?? null;
    },
    async failInterrupted() {
      let count = 0;
      for (const row of table) {
        if (row.status !== "running") continue;
        row.status = "failed";
        row.error = "interrupted by restart";
        count += 1;
      }
      return count;
    },
  };
  return store;
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } satisfies Logger;
}

function newScope(integrationId = "demo"): IntegrationScope {
  return { integrationId, isBuiltIn: false, revoked: false };
}

/** A promise the test settles. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let runs: ReturnType<typeof memoryRuns>;
let log: ReturnType<typeof makeLog>;
let scheduler: IntegrationScheduler;
let scope: IntegrationScope;

function stage(
  name: string,
  options: ScheduleOptions,
  handler: (run: { signal: AbortSignal }) => Promise<void> = async () => {},
  stagingScope: IntegrationScope = scope,
) {
  scheduler.stage(stagingScope.integrationId, stagingScope, name, options, handler);
}

beforeEach(() => {
  runs = memoryRuns();
  log = makeLog();
  scheduler = createIntegrationScheduler({ runs, log });
  scope = newScope();
});

afterEach(() => {
  scheduler.stop();
  vi.useRealTimers();
});

describe("integration scheduler", () => {
  it.each([
    [{ deadlineMs: 5_000 }, /cron or everyMs/],
    [{ cron: "* * * * *", everyMs: 60_000, deadlineMs: 5_000 }, /cron or everyMs/],
    [{ everyMs: 1_000, deadlineMs: 5_000 }, /everyMs/],
    [{ everyMs: 2 ** 31, deadlineMs: 5_000 }, /everyMs/],
    [{ cron: "not cron", deadlineMs: 5_000 }, /cron/],
    [{ cron: "* * * * * *", deadlineMs: 5_000 }, /cron/],
    [{ everyMs: 60_000, deadlineMs: 10 }, /deadlineMs/],
    [{ everyMs: 60_000, deadlineMs: 21_600_001 }, /deadlineMs/],
  ] as Array<[ScheduleOptions, RegExp]>)("refuses %j", (options, message) => {
    expect(() => stage("t", options)).toThrow(message);
  });

  it.each(["", "Upper", "-leading", "a_b", "x".repeat(65)])("refuses the name %j", (name) => {
    expect(() => stage(name, { everyMs: 60_000, deadlineMs: 5_000 })).toThrow(/name/);
  });

  it.each(["@daily", "*/5 * * * *", "0 3 * * MON#2"])("accepts the cron expression %j", (cron) => {
    expect(() => stage("t", { cron, deadlineMs: 5_000 })).not.toThrow();
  });

  it("refuses a name the integration already scheduled", () => {
    stage("t", { everyMs: 60_000, deadlineMs: 5_000 });
    expect(() => stage("t", { cron: "0 * * * *", deadlineMs: 5_000 })).toThrow(/already scheduled/);
  });

  it("does not start a second run while the first is unsettled, and records the deadline", async () => {
    vi.useFakeTimers();
    let stuckSignal: AbortSignal | undefined;
    const fine = vi.fn(async () => {});
    stage("stuck", { everyMs: 60_000, deadlineMs: 5_000 }, ({ signal }) => {
      stuckSignal = signal;
      return new Promise(() => {});
    });
    stage("fine", { everyMs: 60_000, deadlineMs: 5_000 }, fine);
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 + 5_000);
    expect(stuckSignal?.aborted).toBe(true);
    expect(runs.rows("stuck")).toEqual([
      expect.objectContaining({ status: "failed", error: "deadline exceeded" }),
    ]);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(runs.rows("stuck")).toHaveLength(1);
    expect(fine).toHaveBeenCalledTimes(4);
    expect(runs.rows("fine").map((row) => row.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  it("runs a cron task at its next match in UTC", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:30.000Z") });
    const handler = vi.fn(async () => {});
    stage("nightly", { cron: "5 0 * * *", deadlineMs: 5_000 }, handler);
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("skips a tick while another process holds the task's running row", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async () => {});
    await runs.start("demo", "t");
    stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, handler);
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).not.toHaveBeenCalled();
    expect(runs.rows("t")).toHaveLength(1);
  });

  it("aborts the run's signal when the integration is retired", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const handler = vi.fn(({ signal: runSignal }: { signal: AbortSignal }) => {
      signal = runSignal;
      return new Promise<void>(() => {});
    });
    stage("t", { everyMs: 60_000, deadlineMs: 30_000 }, handler);
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal?.aborted).toBe(false);
    scheduler.retire("demo");
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("skips the new generation's tick while a retired run is still running", async () => {
    vi.useFakeTimers();
    const old = deferred();
    const oldHandler = vi.fn(() => old.promise);
    const newHandler = vi.fn(async () => {});
    stage("t", { everyMs: 60_000, deadlineMs: 600_000 }, oldHandler);
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(oldHandler).toHaveBeenCalledTimes(1);

    const nextScope = newScope();
    stage("t", { everyMs: 60_000, deadlineMs: 600_000 }, newHandler, nextScope);
    scheduler.retire("demo");
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(newHandler).not.toHaveBeenCalled();
    expect(runs.rows("t")).toEqual([expect.objectContaining({ status: "running" })]);

    old.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs.rows("t")).toEqual([expect.objectContaining({ status: "succeeded" })]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(newHandler).toHaveBeenCalledTimes(1);
  });

  it("keeps a retired run's deadline", async () => {
    vi.useFakeTimers();
    stage("t", { everyMs: 60_000, deadlineMs: 10_000 }, () => new Promise(() => {}));
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);
    scheduler.retire("demo");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs.rows("t")).toEqual([
      expect.objectContaining({ status: "failed", error: "deadline exceeded" }),
    ]);
  });

  it("drops the staged tasks of an integration whose load failed", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async () => {});
    stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, handler);
    scheduler.discard("demo");
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(handler).not.toHaveBeenCalled();
    // A later generation may register the name again.
    expect(() => stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, handler)).not.toThrow();
  });

  it("starts only the staged tasks of the integrations it activates", async () => {
    vi.useFakeTimers();
    const demo = vi.fn(async () => {});
    const other = vi.fn(async () => {});
    stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, demo);
    stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, other, newScope("other"));
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(demo).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it("records a rejection as failed and keeps the process alive", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      stage("rejects", { everyMs: 60_000, deadlineMs: 5_000 }, async () => {
        throw new Error("x".repeat(3_000));
      });
      stage("throws", { everyMs: 60_000, deadlineMs: 5_000 }, () => {
        throw new Error("at once");
      });
      stage("late", { everyMs: 60_000, deadlineMs: 1_000 }, () => {
        return new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("late")), 5_000),
        );
      });
      scheduler.activate(["demo"]);
      await vi.advanceTimersByTimeAsync(60_000 + 5_000);
      const [rejected] = runs.rows("rejects");
      expect(rejected?.status).toBe("failed");
      expect(rejected?.error).toBe("x".repeat(2_000));
      expect(runs.rows("throws")).toEqual([
        expect.objectContaining({ status: "failed", error: "at once" }),
      ]);
      expect(runs.rows("late")).toEqual([
        expect.objectContaining({ status: "failed", error: "deadline exceeded" }),
      ]);
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("logs and skips a tick whose run cannot be recorded", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async () => {});
    runs.start = async () => {
      throw new Error("database unavailable");
    };
    stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, handler);
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("runs the handler inside the integration's scope", async () => {
    vi.useFakeTimers();
    const seen: Array<IntegrationScope | undefined> = [];
    stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, async () => {
      seen.push(currentIntegrationScope());
    });
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toEqual([scope]);
  });

  it("returns from stop without waiting for a handler", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const handler = vi.fn(({ signal: runSignal }: { signal: AbortSignal }) => {
      signal = runSignal;
      return new Promise<void>(() => {});
    });
    stage("t", { everyMs: 60_000, deadlineMs: 30_000 }, handler);
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scheduler.stop()).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("marks the runs a previous process left running as failed", async () => {
    await runs.start("demo", "t");
    expect(await scheduler.recoverInterrupted()).toBe(1);
    expect(runs.rows("t")).toEqual([
      expect.objectContaining({ status: "failed", error: "interrupted by restart" }),
    ]);
  });
});
