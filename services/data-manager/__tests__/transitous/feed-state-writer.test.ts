import { is, SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drizzle query builders are lazy thenables: nothing reaches the database until
 * the builder is awaited. The mock mirrors that, so `upserts` counts statements
 * that were actually *executed*, not merely constructed.
 */
const mocks = vi.hoisted(() => {
  const state = {
    upserts: [] as Array<{
      values: Record<string, unknown>;
      target: unknown;
      set: Record<string, unknown>;
    }>,
    /** Settles every executed query; swap to reject or stay pending. */
    gate: (): Promise<void> => Promise.resolve(),
    /** When set, `db.insert` throws before returning a builder. */
    insertThrows: undefined as Error | undefined,
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
    insert: () => {
      if (mocks.state.insertThrows) throw mocks.state.insertThrows;
      return {
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: ({
            target,
            set,
          }: {
            target: unknown;
            set: Record<string, unknown>;
          }) =>
            mocks.lazy(() => {
              mocks.state.upserts.push({ values, target, set });
            }),
        }),
      };
    },
  },
}));

import { feedState } from "@openmapx/db-schema";
import {
  recordFetchOutcome,
  recordPromotedSource,
  recordValidateOutcome,
  resetFeedStateCircuitForTests,
} from "../../src/jobs/transitous/feed-state-writer.js";

const CIRCUIT_OPEN = "feed_state writes disabled (previous write failed)";

const state = mocks.state;

function resetState(): void {
  state.upserts.length = 0;
  state.gate = () => Promise.resolve();
  state.insertThrows = undefined;
}

function queryCount(): number {
  return state.upserts.length;
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

    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]?.values.validationMessage).toBe(
      "fetch https://example.org/archive failed",
    );
    expect(state.upserts[0]?.set.validationMessage).toBe(
      "fetch https://example.org/archive failed",
    );
    expect(JSON.stringify(state.upserts.map((u) => u.values))).not.toMatch(
      /FEED-PASSWORD|FEED-TOKEN|feed-user/,
    );
    expect(message).toContain("FEED-TOKEN");
  });

  it("starts a new row at 1 and increments an existing row's counter in the database", async () => {
    await recordValidateOutcome({ region: "de", name: "demo", ok: false, message: "bad" });

    const upsert = state.upserts[0];
    expect(upsert?.target).toEqual([feedState.region, feedState.name]);
    expect(upsert?.values).toEqual({
      region: "de",
      name: "demo",
      validationStatus: "error",
      validationMessage: "bad",
      status: "failed",
      consecutiveFailures: 1,
    });
    expect(upsert?.set).toMatchObject({
      validationStatus: "error",
      validationMessage: "bad",
      status: "failed",
    });
    expect(is(upsert?.set.consecutiveFailures, SQL)).toBe(true);
  });

  it("resets the failure counter on a successful validation", async () => {
    await recordValidateOutcome({ region: "de", name: "demo", ok: true });

    expect(state.upserts[0]?.set).toEqual({
      validationStatus: "ok",
      validationMessage: null,
      consecutiveFailures: 0,
      status: "active",
    });
  });
});

describe("closed-circuit persistence", () => {
  it("upserts the fetch result for a successful fetch", async () => {
    await recordFetchOutcome({ region: "de", name: "demo", ok: true, hash: "abc" });

    expect(state.upserts[0]?.values).toEqual({
      region: "de",
      name: "demo",
      lastFetchedAt: expect.any(Date),
      hash: "abc",
      status: "active",
    });
  });

  it("records a failed fetch without touching lastFetchedAt", async () => {
    await recordFetchOutcome({ region: "de", name: "demo", ok: false });

    expect(state.upserts[0]?.set).toEqual({ status: "failed" });
  });

  it("normalizes region and name when recording a promoted source", async () => {
    await recordPromotedSource({ region: "DE", name: "Demo" });

    expect(state.upserts[0]?.values).toEqual({
      region: "de",
      name: "demo",
      lastImportedAt: expect.any(Date),
      status: "active",
    });
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
    // The failed attempt did execute its statement; later calls must add nothing.
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

    expect(state.upserts).toHaveLength(1);
  });

  it("opens the circuit when query setup throws synchronously", async () => {
    state.insertThrows = new Error("pool exhausted");
    await expect(recordFetchOutcome({ region: "de", name: "demo", ok: true })).rejects.toThrow(
      "pool exhausted",
    );

    state.insertThrows = undefined;
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
    expect(queryCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(799);
    expect(queryCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await first)?.message).toBe("feed_state write timed out after 800ms");

    const later = await Promise.allSettled(branches.map(([, call]) => call()));
    await vi.advanceTimersByTimeAsync(0);
    expect(later.every((r) => r.status === "rejected" && r.reason.message === CIRCUIT_OPEN)).toBe(
      true,
    );
    expect(queryCount()).toBe(1);

    // The timed-out operation is not cancelled; its eventual failure must stay handled.
    rejectFirst(new Error("late connection failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(queryCount()).toBe(1);
  });
});
