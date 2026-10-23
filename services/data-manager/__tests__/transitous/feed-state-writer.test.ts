import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drizzle query builders are lazy thenables: nothing reaches the database until
 * the builder is awaited. The mock mirrors that, so `lookups`/`updates`/`inserted`
 * count queries that were actually *executed*, not merely constructed.
 */
const mocks = vi.hoisted(() => {
  const state = {
    existing: [] as Array<{ id: string; consecutiveFailures: number }>,
    lookups: 0,
    updates: [] as Array<Record<string, unknown>>,
    inserted: [] as Array<Record<string, unknown>>,
    /** Settles every executed query; swap to reject or stay pending. */
    gate: (): Promise<void> => Promise.resolve(),
    /** When set, `db.select` throws before returning a builder. */
    selectThrows: undefined as Error | undefined,
  };

  const lazy = <T>(execute: () => T): PromiseLike<T> => ({
    // biome-ignore lint/suspicious/noThenProperty: mirrors Drizzle's lazy query builders.
    then: (onFulfilled, onRejected) => {
      const result = execute();
      return state
        .gate()
        .then(() => result)
        .then(onFulfilled, onRejected);
    },
  });

  return { state, lazy };
});

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => {
      if (mocks.state.selectThrows) throw mocks.state.selectThrows;
      return {
        from: () => ({
          where: () => ({
            limit: () =>
              mocks.lazy(() => {
                mocks.state.lookups += 1;
                return mocks.state.existing;
              }),
          }),
        }),
      };
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () =>
          mocks.lazy(() => {
            mocks.state.updates.push(values);
          }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) =>
        mocks.lazy(() => {
          mocks.state.inserted.push(values);
        }),
    }),
  },
}));

import {
  recordFetchOutcome,
  recordPromotedSource,
  recordValidateOutcome,
  resetFeedStateCircuitForTests,
} from "../../src/jobs/transitous/feed-state-writer.js";

const CIRCUIT_OPEN = "feed_state writes disabled (previous write failed)";

const state = mocks.state;

function resetState(): void {
  state.existing = [];
  state.lookups = 0;
  state.updates.length = 0;
  state.inserted.length = 0;
  state.gate = () => Promise.resolve();
  state.selectThrows = undefined;
}

function queryCount(): number {
  return state.lookups + state.updates.length + state.inserted.length;
}

/** Let any queued microtasks (and thus any admitted queries) run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  resetState();
  resetFeedStateCircuitForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recordValidateOutcome", () => {
  it("scrubs validation failures before durable feed-state persistence", async () => {
    const message =
      "fetch https://feed-user:FEED-PASSWORD@example.org/archive?token=FEED-TOKEN failed";

    await recordValidateOutcome({ region: "de", name: "demo", ok: false, message });

    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]?.validationMessage).toBe("fetch https://example.org/archive failed");
    expect(JSON.stringify(state.inserted)).not.toMatch(/FEED-PASSWORD|FEED-TOKEN|feed-user/);
    expect(message).toContain("FEED-TOKEN");
  });

  it("starts a failure counter at 1 for a feed without a row", async () => {
    await recordValidateOutcome({ region: "de", name: "demo", ok: false, message: "bad" });

    expect(state.updates).toEqual([]);
    expect(state.inserted).toEqual([
      {
        region: "de",
        name: "demo",
        validationStatus: "error",
        validationMessage: "bad",
        status: "failed",
        consecutiveFailures: 1,
      },
    ]);
  });

  it("increments the stored failure count and scrubs the message on an existing row", async () => {
    state.existing = [{ id: "row-1", consecutiveFailures: 2 }];

    await recordValidateOutcome({
      region: "de",
      name: "demo",
      ok: false,
      message: "fetch https://u:SECRET-PW@example.org/a failed",
    });

    expect(state.inserted).toEqual([]);
    expect(state.updates).toEqual([
      {
        validationStatus: "error",
        validationMessage: "fetch https://example.org/a failed",
        status: "failed",
        consecutiveFailures: 3,
      },
    ]);
  });

  it("resets the failure counter on a successful validation", async () => {
    state.existing = [{ id: "row-1", consecutiveFailures: 4 }];

    await recordValidateOutcome({ region: "de", name: "demo", ok: true });

    expect(state.updates).toEqual([
      {
        validationStatus: "ok",
        validationMessage: null,
        consecutiveFailures: 0,
        status: "active",
      },
    ]);
  });
});

describe("closed-circuit persistence", () => {
  it("inserts a new row for a successful fetch", async () => {
    await recordFetchOutcome({ region: "de", name: "demo", ok: true, hash: "abc" });

    expect(state.updates).toEqual([]);
    expect(state.inserted).toEqual([
      {
        region: "de",
        name: "demo",
        lastFetchedAt: expect.any(Date),
        hash: "abc",
        status: "active",
      },
    ]);
  });

  it("updates the existing row for a failed fetch without touching lastFetchedAt", async () => {
    state.existing = [{ id: "row-1", consecutiveFailures: 0 }];

    await recordFetchOutcome({ region: "de", name: "demo", ok: false });

    expect(state.inserted).toEqual([]);
    expect(state.updates).toEqual([{ status: "failed" }]);
  });

  it("normalizes region and name when recording a promoted source", async () => {
    await recordPromotedSource({ region: "DE", name: "Demo" });

    expect(state.inserted).toEqual([
      {
        region: "de",
        name: "demo",
        lastImportedAt: expect.any(Date),
        status: "active",
      },
    ]);
  });
});

const branches: Array<[string, () => Promise<void>]> = [
  ["fetch success", () => recordFetchOutcome({ region: "de", name: "demo", ok: true, hash: "h" })],
  ["fetch failure", () => recordFetchOutcome({ region: "de", name: "demo", ok: false })],
  ["validation success", () => recordValidateOutcome({ region: "de", name: "demo", ok: true })],
  [
    "validation failure",
    () => recordValidateOutcome({ region: "de", name: "demo", ok: false, message: "bad" }),
  ],
  ["promotion", () => recordPromotedSource({ region: "de", name: "demo" })],
];

describe("circuit breaker admission", () => {
  async function openCircuit(): Promise<void> {
    state.gate = () => Promise.reject(new Error("connection refused"));
    await expect(recordFetchOutcome({ region: "de", name: "opener", ok: true })).rejects.toThrow(
      "connection refused",
    );
    // The failed attempt did execute its lookup; later calls must add nothing.
    expect(queryCount()).toBe(1);
    resetState();
  }

  it.each(branches)("%s starts no query once the circuit is open", async (_label, call) => {
    await openCircuit();

    await expect(call()).rejects.toThrow(CIRCUIT_OPEN);
    await settle();

    expect(queryCount()).toBe(0);
  });

  it("starts no queries for a bounded burst of later calls", async () => {
    await openCircuit();

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => branches[i % branches.length]?.[1]()),
    );
    await settle();

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(results.every((r) => r.status === "rejected" && r.reason.message === CIRCUIT_OPEN)).toBe(
      true,
    );
    expect(queryCount()).toBe(0);
  });

  it("admits work again after the test reset", async () => {
    await openCircuit();

    resetFeedStateCircuitForTests();
    await recordFetchOutcome({ region: "de", name: "demo", ok: true });

    expect(state.inserted).toHaveLength(1);
  });

  it("opens the circuit when query setup throws synchronously", async () => {
    state.selectThrows = new Error("pool exhausted");
    await expect(recordFetchOutcome({ region: "de", name: "demo", ok: true })).rejects.toThrow(
      "pool exhausted",
    );

    state.selectThrows = undefined;
    await expect(recordFetchOutcome({ region: "de", name: "demo", ok: true })).rejects.toThrow(
      CIRCUIT_OPEN,
    );
    await settle();

    expect(queryCount()).toBe(0);
  });

  it("times out after 800ms, admits nothing later, and absorbs the late rejection", async () => {
    vi.useFakeTimers();
    let rejectFirst: (reason: Error) => void = () => {};
    state.gate = () =>
      new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      });

    // Handler attached before timers advance so the rejection is never unhandled.
    const first = recordFetchOutcome({ region: "de", name: "demo", ok: true }).then(
      () => undefined,
      (err: Error) => err,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(state.lookups).toBe(1);

    await vi.advanceTimersByTimeAsync(799);
    expect(state.lookups).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await first)?.message).toBe("feed_state write timed out after 800ms");

    const later = await Promise.allSettled(branches.map(([, call]) => call()));
    await vi.advanceTimersByTimeAsync(0);
    expect(later.every((r) => r.status === "rejected" && r.reason.message === CIRCUIT_OPEN)).toBe(
      true,
    );
    expect(state.lookups).toBe(1);
    expect(state.updates).toEqual([]);
    expect(state.inserted).toEqual([]);

    // The timed-out operation is not cancelled; its eventual failure must stay handled.
    rejectFirst(new Error("late connection failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(queryCount()).toBe(1);
  });
});
