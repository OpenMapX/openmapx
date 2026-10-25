import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
}));

vi.mock("../../src/db/index.js", () => ({
  sql: { reserve: mocks.reserve },
}));

import {
  OVERTURE_LOCK_KEY,
  OVERTURE_LOCK_NAMESPACE,
  withOvertureOperationLock,
} from "../../src/jobs/overture/operation-lock.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Step = "reserve" | "try" | "unlock" | "release";

interface Session {
  id: number;
  releases: number;
}

/**
 * A bounded connection pool with one advisory lock. It models the properties
 * the fix depends on: reserved sessions take a pool slot until released, the
 * old blocking acquisition holds its session while it waits, and the
 * nonblocking attempt returns immediately.
 */
function createFakeDatabase(capacity = 4) {
  let slots = capacity;
  let used = 0;
  let nextSession = 0;
  let externalLock = false;
  let owner: Session | undefined;
  let reserveCalls = 0;
  const slotWaiters: Array<() => void> = [];
  const lockWaiters: Array<() => void> = [];
  const failures = new Map<Step, unknown[]>();
  const sessions: Session[] = [];
  const events: string[] = [];
  let unlockGate: Deferred<void> | undefined;
  let tryResult: unknown[] | undefined;

  const pump = () => {
    while (slotWaiters.length > 0 && used < slots) {
      used += 1;
      slotWaiters.shift()?.();
    }
  };
  const takeSlot = (): Promise<void> => {
    if (used < slots) {
      used += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => slotWaiters.push(resolve));
  };
  const giveSlot = () => {
    used -= 1;
    pump();
  };
  const lockFree = () => !externalLock && owner === undefined;
  const wakeLockWaiters = () => {
    for (const wake of lockWaiters.splice(0)) wake();
  };
  const nextFailure = (step: Step): unknown => failures.get(step)?.shift();

  const unsafe = async (session: Session, text: string): Promise<unknown[]> => {
    await Promise.resolve();
    const lock = `(${OVERTURE_LOCK_NAMESPACE}, ${OVERTURE_LOCK_KEY})`;
    if (text.includes(`pg_try_advisory_lock${lock}`)) {
      const failure = nextFailure("try");
      if (failure) throw failure;
      if (tryResult) {
        events.push(`${session.id}:try:invalid`);
        return tryResult;
      }
      const locked = lockFree();
      if (locked) owner = session;
      events.push(`${session.id}:try:${locked}`);
      return [{ locked }];
    }
    if (text.includes(`pg_advisory_lock${lock}`)) {
      events.push(`${session.id}:lock`);
      while (!lockFree()) await new Promise<void>((resolve) => lockWaiters.push(resolve));
      owner = session;
      return [];
    }
    if (text.includes(`pg_advisory_unlock${lock}`)) {
      events.push(`${session.id}:unlock`);
      try {
        await unlockGate?.promise;
        const failure = nextFailure("unlock");
        if (failure) throw failure;
        return [{ pg_advisory_unlock: true }];
      } finally {
        // A failed unlock models a broken connection: its locks are dropped.
        if (owner === session) owner = undefined;
        wakeLockWaiters();
      }
    }
    throw new Error(`unexpected SQL: ${text}`);
  };

  return {
    events,
    get used() {
      return used;
    },
    get reserveCalls() {
      return reserveCalls;
    },
    get lockHeld() {
      return owner !== undefined;
    },
    get unreleased() {
      return sessions.filter((session) => session.releases !== 1).length;
    },
    setExternalLock(held: boolean) {
      externalLock = held;
      if (!held) wakeLockWaiters();
    },
    failNext(step: Step, error: unknown) {
      failures.set(step, [...(failures.get(step) ?? []), error]);
    },
    holdUnlock(): Deferred<void> {
      unlockGate = deferred();
      return unlockGate;
    },
    returnFromTry(rows: unknown[]) {
      tryResult = rows;
    },
    /** A normal pooled query, like the one an operation's owner needs. */
    async query(): Promise<string> {
      await takeSlot();
      try {
        await Promise.resolve();
        return "ok";
      } finally {
        giveSlot();
      }
    },
    async reserve() {
      reserveCalls += 1;
      const failure = nextFailure("reserve");
      if (failure) throw failure;
      await takeSlot();
      const session: Session = { id: ++nextSession, releases: 0 };
      sessions.push(session);
      return {
        unsafe: (text: string) => unsafe(session, text),
        release: () => {
          session.releases += 1;
          events.push(`${session.id}:release`);
          giveSlot();
          const releaseFailure = nextFailure("release");
          if (releaseFailure) throw releaseFailure;
        },
      };
    },
    /** Frees everything so work still pending after a failed assertion ends. */
    drain() {
      slots = Number.POSITIVE_INFINITY;
      externalLock = false;
      owner = undefined;
      unlockGate?.resolve();
      pump();
      wakeLockWaiters();
    },
  };
}

type FakeDatabase = ReturnType<typeof createFakeDatabase>;

// Deterministic: lets every already-resolved promise chain advance.
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

let db: FakeDatabase;

beforeEach(() => {
  vi.useFakeTimers();
  db = createFakeDatabase();
  mocks.reserve.mockReset().mockImplementation(() => db.reserve());
});

afterEach(async () => {
  // The queue is module state: let work left over from a failed assertion end
  // so it cannot stall later tests.
  db.drain();
  await vi.runAllTimersAsync();
  await flush();
  vi.useRealTimers();
});

describe("withOvertureOperationLock", () => {
  it("holds one session advisory lock around the operation", async () => {
    const operation = vi.fn(async () => "done");
    const result = withOvertureOperationLock(operation);
    await flush();
    await expect(result).resolves.toBe("done");
    expect(operation).toHaveBeenCalledOnce();
    expect(db.events).toEqual(["1:try:true", "1:unlock", "1:release"]);
    expect(db.unreleased).toBe(0);
    expect(db.lockHeld).toBe(false);
  });

  it("unlocks and releases the reserved connection when the operation fails", async () => {
    const result = withOvertureOperationLock(async () => {
      throw new Error("failed operation");
    });
    const assertion = expect(result).rejects.toThrow("failed operation");
    await flush();
    await assertion;
    expect(db.events).toEqual(["1:try:true", "1:unlock", "1:release"]);
    expect(db.unreleased).toBe(0);
  });

  it("keeps queued callers out of the pool so the owner and unrelated queries progress", async () => {
    const gate = deferred();
    const entered: string[] = [];
    let active = 0;
    let maxActive = 0;
    const run = (name: string) =>
      withOvertureOperationLock(async () => {
        entered.push(name);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (name === "a") await gate.promise;
          // Each mutation needs an ordinary pooled query, as ingest does.
          await db.query();
          return name;
        } finally {
          active -= 1;
        }
      });
    const calls = ["a", "b", "c", "d"].map(run);
    let results: string[] | undefined;
    void Promise.all(calls).then((value) => {
      results = value;
    });
    try {
      await flush();
      expect(entered).toEqual(["a"]);
      // Only the owner holds a pool slot; the three waiters reserve nothing.
      expect(db.used).toBe(1);

      let unrelatedDone = false;
      void db.query().then(() => {
        unrelatedDone = true;
      });
      await flush();
      expect(unrelatedDone).toBe(true);

      gate.resolve();
      await flush();
      expect(results).toEqual(["a", "b", "c", "d"]);
      expect(entered).toEqual(["a", "b", "c", "d"]);
      expect(maxActive).toBe(1);
      expect(db.unreleased).toBe(0);
    } finally {
      gate.resolve();
      db.drain();
      await Promise.allSettled(calls);
    }
  });

  it("releases an unsuccessful attempt before backing off and retries until acquired", async () => {
    db.setExternalLock(true);
    const operation = vi.fn(async () => "first");
    const secondOperation = vi.fn(async () => "second");
    const first = withOvertureOperationLock(operation);
    const second = withOvertureOperationLock(secondOperation);
    await flush();

    // The busy attempt gave its connection back; no one waits inside the pool.
    expect(db.events).toEqual(["1:try:false", "1:release"]);
    expect(db.used).toBe(0);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    await expect(db.query()).resolves.toBe("ok");

    // Backoff is a fixed 250 ms, and only the head caller attempts.
    await vi.advanceTimersByTimeAsync(249);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.events).toEqual(["1:try:false", "1:release", "2:try:false", "2:release"]);
    expect(db.used).toBe(0);
    expect(operation).not.toHaveBeenCalled();

    db.setExternalLock(false);
    await vi.advanceTimersByTimeAsync(249);
    expect(operation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(operation).toHaveBeenCalledOnce();
    expect(secondOperation).toHaveBeenCalledOnce();
    // Only successful sessions unlock, and each unlocks exactly its own lock.
    expect(db.events).toEqual([
      "1:try:false",
      "1:release",
      "2:try:false",
      "2:release",
      "3:try:true",
      "3:unlock",
      "3:release",
      "4:try:true",
      "4:unlock",
      "4:release",
    ]);
    expect(db.unreleased).toBe(0);
    expect(db.lockHeld).toBe(false);
  });

  describe("failures", () => {
    const failure = new Error("injected failure");
    const cases: Array<{
      name: string;
      inject: (database: FakeDatabase) => void;
      operation: () => Promise<string>;
    }> = [
      {
        name: "reservation rejects",
        inject: (database) => database.failNext("reserve", failure),
        operation: async () => "unused",
      },
      {
        name: "acquisition query rejects",
        inject: (database) => database.failNext("try", failure),
        operation: async () => "unused",
      },
      {
        name: "operation rejects",
        inject: () => undefined,
        operation: async () => {
          throw failure;
        },
      },
      {
        name: "unlock rejects",
        inject: (database) => database.failNext("unlock", failure),
        operation: async () => "unused",
      },
      {
        name: "release throws",
        inject: (database) => database.failNext("release", failure),
        operation: async () => "unused",
      },
    ];

    it.each(cases)("does not poison the queue when $name", async ({ inject, operation }) => {
      inject(db);
      const next = vi.fn(async () => "next");
      const failed = withOvertureOperationLock(operation);
      const failedAssertion = expect(failed).rejects.toBe(failure);
      const queued = withOvertureOperationLock(next);
      await flush();
      await failedAssertion;
      await expect(queued).resolves.toBe("next");
      expect(next).toHaveBeenCalledOnce();
      expect(db.unreleased).toBe(0);
      expect(db.lockHeld).toBe(false);
    });

    it.each([
      {
        name: "unlock over operation",
        unlock: true,
        release: false,
        expected: "unlock",
      },
      {
        name: "release over unlock",
        unlock: true,
        release: true,
        expected: "release",
      },
      {
        name: "release over operation",
        unlock: false,
        release: true,
        expected: "release",
      },
    ])("reports the cleanup error with precedence: $name", async (scenario) => {
      const operationError = new Error("operation");
      const unlockError = new Error("unlock");
      const releaseError = new Error("release");
      if (scenario.unlock) db.failNext("unlock", unlockError);
      if (scenario.release) db.failNext("release", releaseError);
      const result = withOvertureOperationLock(async () => {
        throw operationError;
      });
      const assertion = expect(result).rejects.toBe(
        scenario.expected === "unlock" ? unlockError : releaseError,
      );
      await flush();
      await assertion;
      expect(db.events).toEqual(["1:try:true", "1:unlock", "1:release"]);
    });

    it("keeps the next caller waiting while cleanup is pending", async () => {
      const gate = db.holdUnlock();
      const unlockError = new Error("unlock failed");
      db.failNext("unlock", unlockError);
      const next = vi.fn(async () => "next");
      const first = withOvertureOperationLock(async () => "first");
      const firstAssertion = expect(first).rejects.toBe(unlockError);
      const second = withOvertureOperationLock(next);
      await flush();

      expect(db.events).toEqual(["1:try:true", "1:unlock"]);
      expect(mocks.reserve).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();

      gate.resolve();
      await flush();
      await firstAssertion;
      await expect(second).resolves.toBe("next");
      expect(db.events).toEqual([
        "1:try:true",
        "1:unlock",
        "1:release",
        "2:try:true",
        "2:unlock",
        "2:release",
      ]);
    });

    it.each([
      { name: "no rows", rows: [] },
      { name: "a non-boolean value", rows: [{ locked: "t" }] },
    ])("never runs the callback on an invalid acquisition result: $name", async ({ rows }) => {
      db.returnFromTry(rows);
      const operation = vi.fn(async () => "unused");
      const result = withOvertureOperationLock(operation);
      const assertion = expect(result).rejects.toThrow(/advisory lock/);
      await flush();
      await assertion;
      expect(operation).not.toHaveBeenCalled();
      expect(db.events).toEqual(["1:try:invalid", "1:release"]);
      expect(db.unreleased).toBe(0);
    });
  });
});
