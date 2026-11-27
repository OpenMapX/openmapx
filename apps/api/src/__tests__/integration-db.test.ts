import { classifyProviderFailure, ProviderTimeoutError } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIntegrationDb,
  integrationDbAccess,
  stopIntegrationDatabase,
} from "../integration-db";
import type { IntegrationScope } from "../integration-scope";

const SET_TIMEOUTS =
  "select set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $1, true)";
const SET_SEARCH_PATH =
  "select set_config('search_path', $1, true), to_regnamespace($2) is not null as present";

/** What the search path statement returns while the integration's schema exists. */
async function schemaPresent(query: string): Promise<unknown> {
  return query === SET_SEARCH_PATH ? [{ present: true }] : [];
}

/** A postgres.js-shaped client whose statement settles as `settle` decides. */
function client(settle: () => Promise<unknown>) {
  const cancel = vi.fn();
  const unsafe = vi.fn(() => Object.assign(settle(), { cancel }));
  return { client: { unsafe } as never, unsafe, cancel };
}

/**
 * Both postgres.js-shaped pools. Every statement is recorded with the pool it
 * ran on and settles as `settle` decides; `begin` runs its callback and
 * records whether postgres.js would commit or roll back. `commit` stands for
 * the COMMIT postgres.js sends once the callback has resolved, and `cancel`
 * for a statement's cancel request.
 */
function fakePools(
  settle: (query: string) => Promise<unknown> = schemaPresent,
  options: { commit?: () => Promise<void>; cancel?: () => Promise<unknown> } = {},
) {
  const statements: Array<{ pool: string; query: string; params?: unknown[] }> = [];
  const outcomes: string[] = [];
  // Only counts calls: a mock that returned the cancel promise itself would
  // track it, and so handle a rejection the code under test must handle.
  const cancel = vi.fn();
  const sendCancel = () => {
    cancel();
    return (options.cancel ?? (async () => undefined))();
  };
  const connection = (pool: string) => ({
    unsafe: vi.fn((query: string, params?: unknown[]) => {
      statements.push(params ? { pool, query, params } : { pool, query });
      return Object.assign(settle(query), { cancel: sendCancel });
    }),
  });
  const pool = (name: string) => ({
    ...connection(name),
    begin: vi.fn(async (fn: (sql: unknown) => Promise<unknown>) => {
      let result: unknown;
      try {
        result = await fn(connection(name));
      } catch (error) {
        outcomes.push("rollback");
        throw error;
      }
      await options.commit?.();
      outcomes.push("commit");
      return result;
    }),
  });
  const requests = pool("requests");
  const transactions = pool("transactions");
  return { pools: { requests, transactions } as never, requests, statements, outcomes, cancel };
}

function settledState(promise: Promise<unknown>) {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

async function flush() {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("integration ctx.db", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a statement the server timed out as a provider timeout", async () => {
    const canceled = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    const { client: db } = client(() => Promise.reject(canceled));

    const failure = createIntegrationDb({ requests: db, transactions: db }).execute(
      "select pg_sleep(6)",
    );

    await expect(failure).rejects.toBeInstanceOf(ProviderTimeoutError);
    await expect(failure).rejects.toMatchObject({ cause: canceled });
    expect(classifyProviderFailure(await failure.catch((error) => error))).toBe("timeout");
  });

  it("keeps the caller's cancellation and other database errors as they are", async () => {
    const canceled = Object.assign(new Error("canceling statement due to user request"), {
      code: "57014",
    });
    const controller = new AbortController();
    let reject!: (error: unknown) => void;
    const { client: db, cancel } = client(
      () =>
        new Promise((_resolve, rejectStatement) => {
          reject = rejectStatement;
        }),
    );
    const pending = createIntegrationDb({ requests: db, transactions: db }).execute(
      "select 1",
      [],
      { signal: controller.signal },
    );
    controller.abort();
    expect(cancel).toHaveBeenCalledOnce();
    reject(canceled);
    await expect(pending).rejects.toBe(canceled);

    const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const { client: broken } = client(() => Promise.reject(missing));
    await expect(
      createIntegrationDb({ requests: broken, transactions: broken }).execute("select 1"),
    ).rejects.toBe(missing);
  });

  it("clamps the declared timeout", async () => {
    for (const [requested, expected] of [
      [50, "1000"],
      [10_000_000, "900000"],
      [undefined, "30000"],
    ] as const) {
      const { pools, statements } = fakePools();
      await createIntegrationDb(pools).transaction(
        async () => "done",
        requested === undefined ? undefined : { timeoutMs: requested },
      );
      expect(statements[0]).toEqual({
        pool: "transactions",
        query: SET_TIMEOUTS,
        params: [expected],
      });
    }
  });

  it("sets no schema for an integration that only requires postgis", async () => {
    expect(integrationDbAccess({ id: "demo", requires: [{ service: "postgis" }] })).toEqual({});
    expect(integrationDbAccess({ id: "demo", database: { migrations: true } })).toEqual({
      schema: "ext_demo",
    });
    expect(integrationDbAccess({ id: "demo" })).toBeUndefined();

    const { pools, requests, statements } = fakePools();
    const db = createIntegrationDb(pools);
    expect(db.schema).toBeUndefined();
    await db.transaction((tx) => tx.execute("select 1"));
    await db.execute("select 2");

    expect(requests.begin).not.toHaveBeenCalled();
    expect(statements).toEqual([
      { pool: "transactions", query: SET_TIMEOUTS, params: ["30000"] },
      { pool: "transactions", query: "select 1" },
      { pool: "requests", query: "select 2" },
    ]);
  });

  it("resolves unqualified names in the schema of an integration that owns one", async () => {
    const { pools, statements, outcomes } = fakePools();
    const db = createIntegrationDb(pools, { schema: "ext_demo" });
    expect(db.schema).toBe("ext_demo");

    await db.transaction((tx) => tx.execute("insert into t values ($1)", [1]));
    await db.execute("select count(*) from t");

    expect(statements).toEqual([
      { pool: "transactions", query: SET_TIMEOUTS, params: ["30000"] },
      {
        pool: "transactions",
        query: SET_SEARCH_PATH,
        params: ['"ext_demo", extensions', "ext_demo"],
      },
      { pool: "transactions", query: "insert into t values ($1)", params: [1] },
      {
        pool: "requests",
        query: SET_SEARCH_PATH,
        params: ['"ext_demo", extensions', "ext_demo"],
      },
      { pool: "requests", query: "select count(*) from t" },
    ]);
    expect(outcomes).toEqual(["commit", "commit"]);
  });

  it("runs nothing when the integration's schema is missing", async () => {
    const { pools, statements, outcomes } = fakePools(async () => [{ present: false }]);
    const db = createIntegrationDb(pools, { schema: "ext_demo" });
    const callback = vi.fn(async () => "ran");

    await expect(db.execute("create table t (id int)")).rejects.toThrow(
      "Schema ext_demo does not exist",
    );
    await expect(db.transaction(callback)).rejects.toThrow("Schema ext_demo does not exist");

    expect(callback).not.toHaveBeenCalled();
    expect(statements.map(({ query }) => query)).not.toContain("create table t (id int)");
    expect(outcomes).toEqual(["rollback", "rollback"]);
  });

  it("refuses every call of an integration whose data was removed, and a new client works", async () => {
    const { pools, statements } = fakePools();
    const db = createIntegrationDb(pools, { schema: "ext_gone", integrationId: "gone" });
    const neighbour = createIntegrationDb(pools, { schema: "ext_kept", integrationId: "kept" });
    let inside!: (query: string) => Promise<unknown>;
    let release!: () => void;
    const running = db.transaction(async (tx) => {
      inside = (query) => tx.execute(query);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return tx.execute("insert into t values (1)");
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    stopIntegrationDatabase("gone");
    const before = statements.length;
    const refused = "The data of integration gone was removed";
    await expect(db.execute("select 1")).rejects.toThrow(refused);
    await expect(db.transaction(async () => "ran")).rejects.toThrow(refused);
    await expect(inside("select 2")).rejects.toThrow(refused);
    release();
    await expect(running).rejects.toThrow(refused);
    expect(statements.length).toBe(before);

    await expect(neighbour.execute("select 3")).resolves.toEqual([]);
    const reinstalled = createIntegrationDb(pools, { schema: "ext_gone", integrationId: "gone" });
    await expect(reinstalled.execute("select 4")).resolves.toEqual([]);
    await expect(db.execute("select 5")).rejects.toThrow(refused);
  });

  it("rolls back when the callback rejects", async () => {
    const { pools, outcomes } = fakePools();
    const failure = new Error("stop");

    await expect(
      createIntegrationDb(pools).transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(outcomes).toEqual(["rollback"]);
  });

  it("ends a transaction that outlives its timeout with the host's timeout error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { pools, outcomes, cancel } = fakePools((query) =>
      query.startsWith("select pg_sleep") ? new Promise(() => {}) : Promise.resolve([]),
    );

    const pending = createIntegrationDb(pools).transaction(
      (tx) => tx.execute("select pg_sleep(3)"),
      { timeoutMs: 1_000 },
    );
    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(999);
    expect(outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toBeInstanceOf(ProviderTimeoutError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(outcomes).toEqual(["rollback"]);
  });

  it("warns once and still runs a call made after the integration was unloaded", async () => {
    const { pools, statements } = fakePools(async (query) => [{ query }]);
    const warn = vi.fn();
    const scope: IntegrationScope = { integrationId: "demo", isBuiltIn: false, revoked: true };
    const db = createIntegrationDb(pools, {
      revocation: { scope, log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } },
    });

    expect(
      await Promise.all([
        db.execute("select 1"),
        db.execute("select 2"),
        db.transaction((tx) => tx.execute("select 3")),
      ]),
    ).toEqual([[{ query: "select 1" }], [{ query: "select 2" }], [{ query: "select 3" }]]);

    expect(statements.map(({ query }) => query)).toEqual([
      "select 1",
      "select 2",
      SET_TIMEOUTS,
      "select 3",
    ]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Integration demo was unloaded; still running db.execute",
      "Integration demo was unloaded; still running db.transaction",
      "Integration demo was unloaded; still running db.transaction.execute",
    ]);
  });

  it("commits a transaction whose callback goes on after the integration was unloaded", async () => {
    const { pools, statements, outcomes } = fakePools();
    const warn = vi.fn();
    const scope: IntegrationScope = { integrationId: "demo", isBuiltIn: false, revoked: false };
    const db = createIntegrationDb(pools, {
      revocation: { scope, log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } },
    });

    await expect(
      db.transaction(async (tx) => {
        await tx.execute("insert into t values (1)");
        scope.revoked = true;
        await tx.execute("insert into t values (2)");
        return "done";
      }),
    ).resolves.toBe("done");

    expect(outcomes).toEqual(["commit"]);
    expect(statements.map(({ query }) => query)).toEqual([
      SET_TIMEOUTS,
      "insert into t values (1)",
      "insert into t values (2)",
    ]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Integration demo was unloaded; still running db.transaction.execute",
    ]);
  });

  it("leaves no unhandled rejection when a cancel request fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let cancels = 0;
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    // Under strict unhandled-rejection handling Node reports one as uncaught.
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onRejection);
    try {
      const { pools, cancel } = fakePools(
        (query) =>
          query.startsWith("select pg_sleep") ? new Promise(() => {}) : Promise.resolve([]),
        { cancel: () => Promise.reject(new Error(`connect ECONNREFUSED (${++cancels})`)) },
      );
      const db = createIntegrationDb(pools);

      const timedOut = db
        .transaction((tx) => tx.execute("select pg_sleep(3)"), { timeoutMs: 1_000 })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await timedOut).toBeInstanceOf(ProviderTimeoutError);
      expect(cancel).toHaveBeenCalledOnce();
      await flush();
      expect(rejections).toEqual([]);

      const controller = new AbortController();
      const aborted = db
        .execute("select pg_sleep(3)", [], { signal: controller.signal })
        .catch((error: unknown) => error);
      controller.abort();
      settledState(aborted);
      expect(cancel).toHaveBeenCalledTimes(2);
      await flush();

      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onRejection);
    }
  });

  it("lets the COMMIT decide once the callback has resolved", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let finishCommit!: (failure?: Error) => void;
    const { pools } = fakePools(async () => [], {
      commit: () =>
        new Promise<void>((resolve, reject) => {
          finishCommit = (failure) => (failure ? reject(failure) : resolve());
        }),
    });
    const db = createIntegrationDb(pools);

    const committed = db.transaction(async () => "kept", { timeoutMs: 1_000 });
    const state = settledState(committed);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.settled).toBe(false);
    finishCommit();
    await expect(committed).resolves.toBe("kept");

    const conflict = Object.assign(new Error("deferred constraint violated"), { code: "23505" });
    const failed = db.transaction(async () => "lost", { timeoutMs: 1_000 });
    const failedOutcome = failed.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    finishCommit(conflict);
    expect(await failedOutcome).toBe(conflict);
  });

  it("runs one transaction of an integration at a time, in order, and does not queue execute", async () => {
    const { pools, statements } = fakePools();
    const transactions = (pools as unknown as { transactions: { begin: ReturnType<typeof vi.fn> } })
      .transactions;
    const db = createIntegrationDb(pools);
    const entered: string[] = [];
    let openFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      openFirst = resolve;
    });

    const first = db.transaction(async (tx) => {
      entered.push("first");
      await tx.execute("select 'first'");
      await firstGate;
      return "first";
    });
    const second = db.transaction(async (tx) => {
      entered.push("second");
      await tx.execute("select 'second'");
      return "second";
    });
    const third = db.transaction(async () => {
      entered.push("third");
      return "third";
    });
    await flush();

    expect(entered).toEqual(["first"]);
    expect(transactions.begin).toHaveBeenCalledTimes(1);
    await expect(db.execute("select 'outside'")).resolves.toEqual([]);
    expect(statements.at(-1)).toEqual({ pool: "requests", query: "select 'outside'" });

    openFirst();
    expect(await Promise.all([first, second, third])).toEqual(["first", "second", "third"]);
    expect(entered).toEqual(["first", "second", "third"]);
    expect(transactions.begin).toHaveBeenCalledTimes(3);
  });

  it("refuses a transaction started inside a transaction of the same integration", async () => {
    const { pools, outcomes } = fakePools();
    const db = createIntegrationDb(pools);
    let openLater!: () => void;
    const laterGate = new Promise<void>((resolve) => {
      openLater = resolve;
    });
    let later: Promise<string> | undefined;

    const outer = db.transaction(async (tx) => {
      await expect(db.transaction(async () => "inner")).rejects.toThrow(
        "Nested transactions are not supported; use the transaction passed to the callback",
      );
      // Work the callback schedules for after its transaction is not nested.
      later = laterGate.then(() => db.transaction(async () => "later"));
      await tx.execute("select 1");
      return "outer";
    });

    await expect(outer).resolves.toBe("outer");
    openLater();
    await expect(later).resolves.toBe("later");
    expect(outcomes).toEqual(["commit", "commit"]);
  });

  it("says so when the deadline passes while waiting for a database connection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const leases: Array<(sql: unknown) => Promise<unknown>> = [];
    const connection = {
      unsafe: vi.fn(() => Object.assign(Promise.resolve([]), { cancel: vi.fn() })),
    };
    const pools = {
      requests: { unsafe: vi.fn(), begin: vi.fn() },
      transactions: {
        // Every connection is taken: the callback runs only when a test hands one out.
        begin: vi.fn(
          (fn: (sql: unknown) => Promise<unknown>) =>
            new Promise((resolve, reject) => {
              leases.push((sql) => fn(sql).then(resolve, reject));
            }),
        ),
      },
    };
    const db = createIntegrationDb(pools as never);
    const callback = vi.fn(async () => "ran");

    const waiting = db.transaction(callback, { timeoutMs: 1_000 }).catch((error: unknown) => error);
    const queued = db.transaction(callback, { timeoutMs: 1_000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);

    for (const outcome of [await waiting, await queued]) {
      expect(outcome).toBeInstanceOf(ProviderTimeoutError);
      expect((outcome as Error).message).toMatch(/waiting for a database connection/);
    }
    // A connection that frees up after the deadline runs nothing, and the
    // queued call, already settled, never asks for one.
    await leases[0]?.(connection);
    await flush();
    expect(callback).not.toHaveBeenCalled();
    expect(connection.unsafe).not.toHaveBeenCalled();
    expect(pools.transactions.begin).toHaveBeenCalledTimes(1);
  });
});
