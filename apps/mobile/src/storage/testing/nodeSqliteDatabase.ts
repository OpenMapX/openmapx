import { DatabaseSync } from "node:sqlite";
import type { Database } from "../database";

/**
 * A `Database` backed by Node's built-in SQLite, used only by tests.
 *
 * `expo-sqlite` ships no Node implementation, so the alternative would be a
 * hand-written mock — which cannot enforce a `CHECK` constraint, roll back a
 * failed transaction, or reject a duplicate primary key. Those are precisely the
 * behaviours the storage tests exist to prove, so the tests run against a real
 * SQLite engine instead.
 *
 * The adapter is deliberately thin and synchronous underneath: it mirrors the
 * port's promise-based shape without adding scheduling of its own, so test
 * ordering stays deterministic.
 */
class NodeSqliteDatabase implements Database {
  constructor(
    private readonly db: DatabaseSync,
    /** Nested transactions are not opened; an inner block joins the outer one. */
    private readonly inTransaction = false,
  ) {}

  async execAsync(source: string): Promise<void> {
    this.db.exec(source);
  }

  async runAsync(
    source: string,
    params: readonly unknown[] = [],
  ): Promise<{ changes: number; lastInsertRowId: number }> {
    const result = this.db.prepare(source).run(...(params as never[]));
    return {
      changes: Number(result.changes),
      lastInsertRowId: Number(result.lastInsertRowid),
    };
  }

  async getFirstAsync<T>(source: string, params: readonly unknown[] = []): Promise<T | null> {
    return (this.db.prepare(source).get(...(params as never[])) as T | undefined) ?? null;
  }

  async getAllAsync<T>(source: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.db.prepare(source).all(...(params as never[])) as T[];
  }

  async withExclusiveTransactionAsync(task: (tx: Database) => Promise<void>): Promise<void> {
    if (this.inTransaction) {
      await task(this);
      return;
    }
    this.db.exec("BEGIN EXCLUSIVE");
    try {
      await task(new NodeSqliteDatabase(this.db, true));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async closeAsync(): Promise<void> {
    this.db.close();
  }
}

/** Opens a private in-memory database for a single test. */
export function openTestDatabase(): Database {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return new NodeSqliteDatabase(db);
}
