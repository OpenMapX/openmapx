import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LegacyOperationObservation,
  reconcileInterruptedLegacyJobs,
  startInterruptedLegacyJobReconciler,
} from "./reconcile";

const key = (suffix: string) => `opk1_${suffix.padEnd(24, "x")}`;
const attempted = (suffix: string) => ({ operationKey: key(suffix), state: "attempted" });
const row = (id: string, operations: unknown[]) => ({ id, ownership_version: 0, operations });

/** A tagged-template stand-in that answers the job query and records updates. */
function fakeDatabase(options: {
  rows: () => Promise<unknown[]> | unknown[];
  update?: (id: string) => Promise<unknown[]> | unknown[];
}) {
  const calls = { selects: 0, updates: [] as string[] };
  const database = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join("?").includes("SELECT")) {
      calls.selects++;
      return options.rows();
    }
    const id = String(values[0]);
    calls.updates.push(id);
    return options.update ? options.update(id) : [{ id }];
  }) as unknown as postgres.Sql;
  return { database, calls };
}

describe("reconcileInterruptedLegacyJobs", () => {
  it("holds a row whose operation cannot be observed and keeps settling the others", async () => {
    const { database, calls } = fakeDatabase({
      rows: () => [
        row("unreachable", [attempted("down")]),
        row("empty", []),
        row("terminal", [attempted("done")]),
        row("malformed", [{ state: "attempted" }]),
      ],
    });
    const observe = vi.fn(async (operationKey: string): Promise<LegacyOperationObservation> => {
      if (operationKey === key("down")) throw Error("Synthetic agent outage");
      return "terminal";
    });

    const result = await reconcileInterruptedLegacyJobs({ database, observe });

    expect(result).toEqual({ resolved: ["empty", "terminal"], held: ["unreachable", "malformed"] });
    expect(calls.updates).toEqual(["empty", "terminal"]);
  });

  it("reports a failure to settle one row and still settles the next", async () => {
    const { database } = fakeDatabase({
      rows: () => [row("first", []), row("second", [])],
      update: async (id) => {
        if (id === "first") throw Error("Synthetic database fault");
        return [{ id }];
      },
    });
    const onError = vi.fn();

    const result = await reconcileInterruptedLegacyJobs({
      database,
      observe: async () => "terminal",
      onError,
    });

    expect(result).toEqual({ resolved: ["second"], held: ["first"] });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Synthetic database fault" }),
      "first",
    );
  });

  it("holds a row whose terminal update lost a race with another writer", async () => {
    const { database } = fakeDatabase({ rows: () => [row("raced", [])], update: () => [] });
    await expect(
      reconcileInterruptedLegacyJobs({ database, observe: async () => "terminal" }),
    ).resolves.toEqual({ resolved: [], held: ["raced"] });
  });
});

describe("startInterruptedLegacyJobReconciler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never overlaps passes and waits the full interval after one finishes", async () => {
    let finish: (value: LegacyOperationObservation) => void = () => {};
    const { database, calls } = fakeDatabase({ rows: () => [row("slow", [attempted("slow")])] });
    const observe = vi.fn(
      (_key: string, _retained: unknown, { signal }: { signal?: AbortSignal }) =>
        new Promise<LegacyOperationObservation>((resolve, reject) => {
          finish = resolve;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const reconciler = startInterruptedLegacyJobReconciler({ database, observe });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    void reconciler.runOnce();
    expect(calls.selects).toBe(1);
    expect(observe).toHaveBeenCalledTimes(1);

    finish("active");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls.selects).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.selects).toBe(2);
    await reconciler.stop();
  });

  it("stops the timer, aborts a pending observation and waits for the running pass", async () => {
    let seen: AbortSignal | undefined;
    const { database, calls } = fakeDatabase({ rows: () => [row("slow", [attempted("slow")])] });
    const reconciler = startInterruptedLegacyJobReconciler({
      database,
      observe: (_key, _retained, { signal }) =>
        new Promise<LegacyOperationObservation>((_resolve, reject) => {
          seen = signal;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen?.aborted).toBe(false);

    await reconciler.stop();

    expect(seen?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls.selects).toBe(1);
    await reconciler.runOnce();
    expect(calls.selects).toBe(1);
  });

  it("reports a pass that could not read the jobs and tries again on the next interval", async () => {
    let healthy = false;
    const { database, calls } = fakeDatabase({
      rows: () => {
        if (!healthy) throw Error("Synthetic database outage");
        return [row("later", [])];
      },
    });
    const onError = vi.fn();
    const onResult = vi.fn();
    const reconciler = startInterruptedLegacyJobReconciler({
      database,
      observe: async () => "terminal",
      onError,
      onResult,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();

    healthy = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.selects).toBe(2);
    expect(onResult).toHaveBeenCalledWith({ resolved: ["later"], held: [] });
    await reconciler.stop();
  });
});
