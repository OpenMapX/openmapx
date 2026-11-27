import { classifyProviderFailure, ProviderTimeoutError } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntegrationDb, integrationDbAccess } from "../integration-db";
import type { IntegrationScope } from "../integration-scope";

const SET_TIMEOUTS =
  "select set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $1, true)";
const SET_SEARCH_PATH = "select set_config('search_path', $1, true)";

/** A postgres.js-shaped client whose statement settles as `settle` decides. */
function client(settle: () => Promise<unknown>) {
  const cancel = vi.fn();
  const unsafe = vi.fn(() => Object.assign(settle(), { cancel }));
  return { client: { unsafe } as never, unsafe, cancel };
}

/**
 * Both postgres.js-shaped pools. Every statement is recorded with the pool it
 * ran on and settles as `settle` decides; `begin` runs its callback and
 * records whether postgres.js would commit or roll back.
 */
function fakePools(settle: (query: string) => Promise<unknown> = async () => []) {
  const statements: Array<{ pool: string; query: string; params?: unknown[] }> = [];
  const outcomes: string[] = [];
  const cancel = vi.fn();
  const connection = (pool: string) => ({
    unsafe: vi.fn((query: string, params?: unknown[]) => {
      statements.push(params ? { pool, query, params } : { pool, query });
      return Object.assign(settle(query), { cancel });
    }),
  });
  const pool = (name: string) => ({
    ...connection(name),
    begin: vi.fn(async (fn: (sql: unknown) => Promise<unknown>) => {
      try {
        const result = await fn(connection(name));
        outcomes.push("commit");
        return result;
      } catch (error) {
        outcomes.push("rollback");
        throw error;
      }
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
      { pool: "transactions", query: SET_SEARCH_PATH, params: ['"ext_demo", public'] },
      { pool: "transactions", query: "insert into t values ($1)", params: [1] },
      { pool: "requests", query: SET_SEARCH_PATH, params: ['"ext_demo", public'] },
      { pool: "requests", query: "select count(*) from t" },
    ]);
    expect(outcomes).toEqual(["commit", "commit"]);
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

  it("does nothing once the integration was unloaded", async () => {
    const { pools, statements } = fakePools();
    const warn = vi.fn();
    const scope: IntegrationScope = { integrationId: "demo", isBuiltIn: false, revoked: true };
    const db = createIntegrationDb(pools, {
      schema: "ext_demo",
      revocation: { scope, log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } },
    });

    const calls = [
      db.execute("select 1"),
      db.execute("select 2"),
      db.transaction((tx) => tx.execute("select 3")),
    ].map(settledState);
    await flush();

    expect(calls.map((call) => call.settled)).toEqual([false, false, false]);
    expect(statements).toEqual([]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Integration demo was unloaded; ignoring db.execute",
      "Integration demo was unloaded; ignoring db.transaction",
    ]);
  });

  it("rolls back a transaction whose callback goes on after the integration was unloaded", async () => {
    const { pools, statements, outcomes } = fakePools();
    const warn = vi.fn();
    const scope: IntegrationScope = { integrationId: "demo", isBuiltIn: false, revoked: false };
    const db = createIntegrationDb(pools, {
      revocation: { scope, log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } },
    });
    let late: { settled: boolean } | undefined;

    const transaction = settledState(
      db.transaction(async (tx) => {
        await tx.execute("insert into t values (1)");
        scope.revoked = true;
        const statement = tx.execute("insert into t values (2)");
        late = settledState(statement);
        await statement;
      }),
    );
    await flush();

    expect(outcomes).toEqual(["rollback"]);
    expect(transaction.settled).toBe(false);
    expect(late).toEqual({ settled: false });
    expect(statements.map(({ query }) => query)).toEqual([
      SET_TIMEOUTS,
      "insert into t values (1)",
    ]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Integration demo was unloaded; ignoring db.transaction.execute",
    ]);
  });
});
