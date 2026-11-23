import { randomUUID } from "node:crypto";
import { vi } from "vitest";

/**
 * Drizzle query-builder stub. Drizzle builders are *thenable* — `await db
 * .select().from(t).where(...)` resolves the query — and every intermediate
 * method returns the builder. This mirrors that: each chain method returns the
 * same object, and awaiting it resolves to `resolveWith`.
 *
 * Promotes the `makeSelectChain` stub that route tests (admin, saved-export,
 * legal-config, …) each re-implemented inline.
 */
export function makeQueryChain(resolveWith: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = [
    "from",
    "where",
    "limit",
    "offset",
    "orderBy",
    "groupBy",
    "having",
    "set",
    "values",
    "returning",
    "onConflictDoNothing",
    "onConflictDoUpdate",
    "leftJoin",
    "innerJoin",
    "rightJoin",
    "for",
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; the stub must mirror that.
  chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(resolveWith).then(onFulfilled, onRejected);
  return chain;
}

type Op = "select" | "insert" | "update" | "delete";

export interface DbMock {
  /** Drop-in for the `db` export — pass to `vi.mock("../../db/index.js", …)`. */
  db: {
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    /** `db.transaction(fn)` runs `fn` with the same mock as the `tx` arg. */
    transaction: ReturnType<typeof vi.fn>;
  };
  /** Queue the rows the next `db.select()…` await resolves to (FIFO). */
  queueSelect(rows: unknown): void;
  queueInsert(rows: unknown): void;
  queueUpdate(rows: unknown): void;
  queueDelete(rows: unknown): void;
}

/**
 * Serializes every argument passed to `.where()` on one query chain, so a test
 * can assert which column and value a query is constrained on. With a schema
 * mock that maps columns to distinctive strings (`saved_list.user_id`), the
 * column name appears verbatim, which is what makes an ownership filter
 * observable. `callIndex` picks the chain; negative values count from the end.
 */
export function whereArgs(dbMock: DbMock, op: Op, callIndex = -1): string {
  const results = dbMock.db[op].mock.results;
  const chain = results.at(callIndex)?.value as { where: { mock: { calls: unknown[][] } } };
  return JSON.stringify(chain.where.mock.calls, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/**
 * The arguments passed to `.orderBy()` on one query chain, in order. With a
 * schema mock that maps columns to distinctive strings this shows the exact
 * sort keys, including any tiebreaker. `callIndex` picks the chain; negative
 * values count from the end.
 */
export function orderByArgs(dbMock: DbMock, op: Op, callIndex = -1): unknown[] {
  const results = dbMock.db[op].mock.results;
  const chain = results.at(callIndex)?.value as { orderBy: { mock: { calls: unknown[][] } } };
  return chain.orderBy.mock.calls.flat();
}

/**
 * An insert chain. A queued result wins; otherwise an insert with `RETURNING`
 * resolves to its rows with a database-assigned `id`, as PostgreSQL's column
 * default would give them, and one without resolves to `[]`.
 */
function makeInsertChain(queued: { rows: unknown } | undefined): Record<string, unknown> {
  let rows: Record<string, unknown>[] = [];
  let returning = false;
  const chain = makeQueryChain([]);
  chain.values = vi.fn((values: Record<string, unknown> | Record<string, unknown>[]) => {
    rows = Array.isArray(values) ? values : [values];
    return chain;
  });
  chain.returning = vi.fn(() => {
    returning = true;
    return chain;
  });
  // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; the stub must mirror that.
  chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(
      queued ? queued.rows : returning ? rows.map((row) => ({ id: randomUUID(), ...row })) : [],
    ).then(onFulfilled, onRejected);
  return chain;
}

/**
 * Build a queue-driven `db` mock. Each `db.<op>()` call shifts the next queued
 * result for that op (defaulting to `[]`, or for an insert with `RETURNING`
 * to its rows with an assigned `id`) and returns a thenable chain that
 * resolves to it. Assert on `dbMock.db.select.mock.calls` etc.
 */
export function createDbMock(): DbMock {
  const queues: Record<Op, unknown[]> = { select: [], insert: [], update: [], delete: [] };
  const make = (op: Op) => vi.fn(() => makeQueryChain(queues[op].shift() ?? []));
  const db: DbMock["db"] = {
    select: make("select"),
    insert: vi.fn(() =>
      makeInsertChain(queues.insert.length ? { rows: queues.insert.shift() } : undefined),
    ),
    update: make("update"),
    delete: make("delete"),
    execute: vi.fn(async () => []),
    transaction: vi.fn(async (fn: (tx: DbMock["db"]) => unknown) => fn(db)),
  };
  return {
    db,
    queueSelect: (rows) => queues.select.push(rows),
    queueInsert: (rows) => queues.insert.push(rows),
    queueUpdate: (rows) => queues.update.push(rows),
    queueDelete: (rows) => queues.delete.push(rows),
  };
}
