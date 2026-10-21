import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// A precise transactional row boundary: execute the actual adapter, inspect its
// SQL ownership predicate, and model commit/rollback rather than live PostgreSQL.
const dialect = new PgDialect();
export function integrationConfigDbFixture() {
  type Row = {
    id: string;
    integrationId: string;
    config: Record<string, unknown>;
    version: string;
  };
  let rows: Row[] = [];
  let nextVersion = 1;
  let failCommit = false;
  let failWrite = false;
  let writes = 0;
  let beforeTransaction: (() => Promise<void>) | undefined;
  const predicates: string[] = [];
  function port() {
    let candidate: (typeof rows)[number] | undefined;
    let changes: Partial<(typeof rows)[number]> = {};
    let op = "select";
    let selectedIds: unknown[] | undefined;
    const chain = {
      select() {
        op = "select";
        return chain;
      },
      from() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      for() {
        return Promise.resolve(selected());
      },
      limit() {
        return chain;
      },
      where(condition: SQL) {
        if (op === "select") selectedIds = dialect.sqlToQuery(condition).params;
        if (op !== "select") {
          const query = dialect.sqlToQuery(condition);
          predicates.push(query.sql);
          candidate = rows.find((row) => row.id === query.params[0]);
          if (query.params.length > 1 && candidate?.version !== query.params[1])
            candidate = undefined;
        }
        return chain;
      },
      update() {
        op = "update";
        return chain;
      },
      delete() {
        op = "delete";
        return chain;
      },
      insert() {
        op = "insert";
        return chain;
      },
      set(value: typeof changes) {
        changes = value;
        return chain;
      },
      values(value: typeof changes) {
        changes = value;
        return chain;
      },
      onConflictDoNothing() {
        return chain;
      },
      async returning() {
        if (failWrite) throw Error("write failed");
        writes++;
        if (op === "insert") {
          if (rows.some((r) => r.integrationId === changes.integrationId)) return [];
          const row = { ...changes, version: String(nextVersion++) } as (typeof rows)[number];
          rows.push(row);
          return [structuredClone(row)];
        }
        if (!candidate) return [];
        const id = candidate.id;
        if (op === "delete") rows = rows.filter((r) => r !== candidate);
        else Object.assign(candidate, changes, { version: String(nextVersion++) });
        return [op === "delete" ? { id } : structuredClone(candidate)];
      },
      // biome-ignore lint/suspicious/noThenProperty: Drizzle's query builders are thenable.
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(selected()).then(resolve);
      },
    };
    function selected() {
      return structuredClone(
        rows.filter((row) => !selectedIds || selectedIds.includes(row.integrationId)),
      );
    }
    return chain;
  }
  const db = {
    select: () => port().select(),
    async transaction(fn: (tx: ReturnType<typeof port>) => Promise<unknown>) {
      const wait = beforeTransaction;
      beforeTransaction = undefined;
      await wait?.();
      const before = structuredClone(rows);
      try {
        const value = await fn(port());
        if (failCommit) throw Error("commit failed");
        return value;
      } catch (error) {
        rows = before;
        throw error;
      }
    },
  };
  return {
    db,
    predicates,
    get rows() {
      return rows;
    },
    get writes() {
      return writes;
    },
    set failWrite(value: boolean) {
      failWrite = value;
    },
    set failCommit(value: boolean) {
      failCommit = value;
    },
    set beforeTransaction(value: (() => Promise<void>) | undefined) {
      beforeTransaction = value;
    },
    reset(value: Row[] = []) {
      rows = structuredClone(value);
      nextVersion = 1;
      failCommit = false;
      failWrite = false;
      writes = 0;
      predicates.length = 0;
      beforeTransaction = undefined;
    },
  };
}
