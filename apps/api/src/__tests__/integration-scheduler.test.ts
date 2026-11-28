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
    [{ everyMs: 59_999, deadlineMs: 5_000 }, /everyMs/],
    [{ everyMs: 2 ** 31, deadlineMs: 5_000 }, /everyMs/],
    [{ cron: "not cron", deadlineMs: 5_000 }, /cron/],
    [{ cron: "* * * * * *", deadlineMs: 5_000 }, /cron/],
    [{ cron: "0 0 31 2 *", deadlineMs: 5_000 }, /never matches/],
    [{ everyMs: 60_000, deadlineMs: 10 }, /deadlineMs/],
    [{ everyMs: 60_000, deadlineMs: 999 }, /deadlineMs/],
    [{ everyMs: 60_000, deadlineMs: 21_600_001 }, /deadlineMs/],
  ] as Array<[ScheduleOptions, RegExp]>)("refuses %j", (options, message) => {
    expect(() => stage("t", options)).toThrow(message);
  });

  it.each([
    { everyMs: 60_000, deadlineMs: 1_000 },
    { everyMs: 2_147_483_647, deadlineMs: 21_600_000 },
  ] as ScheduleOptions[])("accepts the boundary values %j", (options) => {
    expect(() => stage("t", options)).not.toThrow();
  });

  it.each([undefined, "handler", { run: () => {} }])("refuses the handler %j", (handler) => {
    expect(() =>
      scheduler.stage("demo", scope, "t", { everyMs: 60_000, deadlineMs: 5_000 }, handler as never),
    ).toThrow("Scheduled task t: the handler must be a function");
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

  it("runs a cron task at its matches in UTC, whatever the process's time zone", async () => {
    // New York, where 01:30 local is 06:30Z before and 05:30Z after the
    // change to daylight saving time at 02:00 local on 2026-03-08.
    const timeZone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      vi.useFakeTimers({ now: new Date("2026-03-08T00:00:00.000Z") });
      const handler = vi.fn(async () => {});
      stage("nightly", { cron: "30 1 * * *", deadlineMs: 5_000 }, handler);
      scheduler.activate(["demo"]);
      await vi.advanceTimersByTimeAsync(90 * 60_000 - 1);
      expect(handler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 - 1);
      expect(handler).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(new Date().toISOString()).toBe("2026-03-09T01:30:00.000Z");
    } finally {
      if (timeZone === undefined) delete process.env.TZ;
      else process.env.TZ = timeZone;
    }
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
    expect(log.warn).toHaveBeenCalledWith(
      "Scheduled task demo:t skipped this run: a run this process did not start is recorded as running",
      { integrationId: "demo", task: "t" },
    );
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("logs a value that cannot be read as an error by its description, not as itself", async () => {
    vi.useFakeTimers();
    stage("rejects", { everyMs: 60_000, deadlineMs: 5_000 }, () =>
      Promise.reject(Object.create(null)),
    );
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.warn).toHaveBeenCalledWith(
      "Scheduled task demo:rejects failed",
      expect.objectContaining({ err: "a value that cannot be shown" }),
    );
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

  class ThrowingMessage extends Error {
    override get message(): string {
      throw new Error("getter");
    }
  }

  /** A proxy over a frozen object whose every trap throws. */
  function hostileProxy(): unknown {
    const fail = () => {
      throw new Error("trap");
    };
    return new Proxy(Object.freeze({}), {
      get: fail,
      has: fail,
      ownKeys: fail,
      getPrototypeOf: fail,
      getOwnPropertyDescriptor: fail,
    });
  }

  it.each([
    ["an object without a prototype", () => Object.create(null), "a value that cannot be shown"],
    [
      "an Error whose message getter throws",
      () => new ThrowingMessage(),
      "a value that cannot be shown",
    ],
    ["a symbol", () => Symbol("odd"), "Symbol(odd)"],
    ["undefined", () => undefined, "undefined"],
    ["a proxy that throws on every access", hostileProxy, "a value that cannot be shown"],
  ])(
    "records a rejection or throw with %s as failed, and nothing reaches the process",
    async (_label, value, error) => {
      vi.useFakeTimers();
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      // Reads the logged error as a structured logger's serializer would.
      const read = (_message: string, fields?: Record<string, unknown>) => {
        const err = fields?.err;
        if (err instanceof Error) void err.message;
        else void `${err}`;
      };
      log.warn.mockImplementation(read);
      log.error.mockImplementation(read);
      try {
        stage("rejects", { everyMs: 60_000, deadlineMs: 5_000 }, () => Promise.reject(value()));
        stage("throws", { everyMs: 60_000, deadlineMs: 5_000 }, () => {
          throw value();
        });
        scheduler.activate(["demo"]);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(runs.rows("rejects")).toEqual([
          expect.objectContaining({ status: "failed", error }),
        ]);
        expect(runs.rows("throws")).toEqual([expect.objectContaining({ status: "failed", error })]);
        vi.useRealTimers();
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    },
  );

  describe("when the outcome of a run cannot be written", () => {
    /** Lets `finish` fail while `failing()` says so. */
    function failFinish(failing: () => boolean) {
      const finish = runs.finish.bind(runs);
      const attempts = vi.fn(async (...args: Parameters<TaskRunStore["finish"]>) => {
        if (failing()) throw new Error("database unavailable");
        return finish(...args);
      });
      runs.finish = attempts;
      return attempts;
    }

    it("retries a write that failed once", async () => {
      vi.useFakeTimers();
      let failures = 1;
      failFinish(() => failures-- > 0);
      const handler = vi.fn(async () => {});
      stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, handler);
      scheduler.activate(["demo"]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs.rows("t")).toEqual([expect.objectContaining({ status: "running" })]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(runs.rows("t")).toEqual([expect.objectContaining({ status: "succeeded" })]);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(runs.rows("t").map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
    });

    it("keeps an outcome it could not write and writes it before the task's next run", async () => {
      vi.useFakeTimers();
      let down = true;
      const attempts = failFinish(() => down);
      const handler = vi.fn(async () => {});
      stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, handler);
      scheduler.activate(["demo"]);
      await vi.advanceTimersByTimeAsync(60_000 + 30_000);
      expect(attempts).toHaveBeenCalledTimes(4);
      expect(runs.rows("t")).toEqual([expect.objectContaining({ status: "running" })]);
      expect(log.warn).toHaveBeenCalledWith(
        "Could not record the run of scheduled task demo:t; trying again before its next run",
        expect.objectContaining({ integrationId: "demo", task: "t" }),
      );

      down = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(runs.rows("t").map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
    });

    it("skips ticks with a warning until the outcome is written, then runs again", async () => {
      vi.useFakeTimers();
      let down = true;
      failFinish(() => down);
      const handler = vi.fn(async () => {});
      stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, handler);
      scheduler.activate(["demo"]);
      await vi.advanceTimersByTimeAsync(3 * 60_000);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(runs.rows("t")).toHaveLength(1);
      expect(log.warn).toHaveBeenCalledWith(
        "Scheduled task demo:t skipped this run: the outcome of its previous run could not be recorded",
        expect.objectContaining({ integrationId: "demo", task: "t" }),
      );

      down = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(runs.rows("t").map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
    });

    it("writes a deadline it could not record before the next generation's run", async () => {
      vi.useFakeTimers();
      let down = true;
      failFinish(() => down);
      const newHandler = vi.fn(async () => {});
      stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, () => new Promise(() => {}));
      scheduler.activate(["demo"]);
      await vi.advanceTimersByTimeAsync(60_000 + 5_000 + 30_000);
      expect(runs.rows("t")).toEqual([expect.objectContaining({ status: "running" })]);

      stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, newHandler, newScope());
      scheduler.retire("demo");
      scheduler.activate(["demo"]);
      down = false;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(newHandler).toHaveBeenCalledTimes(1);
      expect(runs.rows("t")).toEqual([
        expect.objectContaining({ status: "failed", error: "deadline exceeded" }),
        expect.objectContaining({ status: "succeeded" }),
      ]);
    });

    it("clears its retry timers at stop", async () => {
      vi.useFakeTimers();
      failFinish(() => true);
      stage("t", { everyMs: 60_000, deadlineMs: 5_000 });
      scheduler.activate(["demo"]);
      await vi.advanceTimersByTimeAsync(60_000);
      scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
    });
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

  it("lets the new generation's task run once a retired run reaches its deadline", async () => {
    vi.useFakeTimers();
    const newHandler = vi.fn(async () => {});
    stage("t", { everyMs: 60_000, deadlineMs: 10_000 }, () => new Promise(() => {}));
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);

    stage("t", { everyMs: 60_000, deadlineMs: 10_000 }, newHandler, newScope());
    scheduler.retire("demo");
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs.rows("t")).toEqual([
      expect.objectContaining({ status: "failed", error: "deadline exceeded" }),
    ]);
    await vi.advanceTimersByTimeAsync(50_000);

    expect(newHandler).toHaveBeenCalledTimes(1);
    expect(runs.rows("t").map((row) => row.status)).toEqual(["failed", "succeeded"]);
  });

  it("aborts a retired run at stop and clears its deadline", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    stage("t", { everyMs: 60_000, deadlineMs: 30_000 }, ({ signal: runSignal }) => {
      signal = runSignal;
      return new Promise(() => {});
    });
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);
    scheduler.retire("demo");

    scheduler.stop();

    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    // Left to the next start's recovery.
    expect(runs.rows("t")).toEqual([expect.objectContaining({ status: "running" })]);
  });

  /** Holds `runs.start` until the returned function is called. */
  function holdStart() {
    const start = runs.start.bind(runs);
    const gate = deferred();
    const held = vi.fn(async (integrationId: string, taskName: string) => {
      await gate.promise;
      return start(integrationId, taskName);
    });
    runs.start = held;
    return { held, release: gate.resolve };
  }

  it("does not let ticks pile up behind a slow start of a run", async () => {
    vi.useFakeTimers();
    const { held } = holdStart();
    stage("t", { everyMs: 60_000, deadlineMs: 5_000 });
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(held).toHaveBeenCalledTimes(1);
  });

  it("records a run whose start a reload overtook as replaced, without running it", async () => {
    vi.useFakeTimers();
    const { release } = holdStart();
    const handler = vi.fn(async () => {});
    stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, handler);
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);

    scheduler.retire("demo");
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).not.toHaveBeenCalled();
    expect(runs.rows("t")).toEqual([
      expect.objectContaining({
        status: "failed",
        error: "replaced by a reload before it started",
      }),
    ]);
  });

  it("starts no run whose start finishes after stop", async () => {
    vi.useFakeTimers();
    const { release } = holdStart();
    const handler = vi.fn(async () => {});
    stage("t", { everyMs: 60_000, deadlineMs: 5_000 }, handler);
    scheduler.activate(["demo"]);
    await vi.advanceTimersByTimeAsync(60_000);

    scheduler.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).not.toHaveBeenCalled();
    expect(runs.rows("t")).toEqual([expect.objectContaining({ status: "running" })]);
  });

  it("records a rejection that comes after the integration was retired", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const run = deferred();
      stage("t", { everyMs: 60_000, deadlineMs: 30_000 }, () => run.promise);
      scheduler.activate(["demo"]);
      await vi.advanceTimersByTimeAsync(60_000);
      scheduler.retire("demo");
      run.reject(new Error("failed while stopping"));
      await vi.advanceTimersByTimeAsync(0);

      expect(runs.rows("t")).toEqual([
        expect.objectContaining({ status: "failed", error: "failed while stopping" }),
      ]);
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("marks the runs a previous process left running as failed", async () => {
    await runs.start("demo", "t");
    expect(await scheduler.recoverInterrupted()).toBe(1);
    expect(runs.rows("t")).toEqual([
      expect.objectContaining({ status: "failed", error: "interrupted by restart" }),
    ]);
  });
});
