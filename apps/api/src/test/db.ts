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
 * Build a queue-driven `db` mock. Each `db.<op>()` call shifts the next queued
 * result for that op (defaulting to `[]`) and returns a thenable chain that
 * resolves to it. Assert on `dbMock.db.select.mock.calls` etc.
 */
export function createDbMock(): DbMock {
  const queues: Record<Op, unknown[]> = { select: [], insert: [], update: [], delete: [] };
  const make = (op: Op) => vi.fn(() => makeQueryChain(queues[op].shift() ?? []));
  const db: DbMock["db"] = {
    select: make("select"),
    insert: make("insert"),
    update: make("update"),
    delete: make("delete"),
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
