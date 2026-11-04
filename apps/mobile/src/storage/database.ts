import * as SQLite from "expo-sqlite";
import { migrateSessionSchema } from "./migrations";

/**
 * The one on-device database.
 *
 * A single lazily-opened connection is shared by the foreground app and the
 * headless background task, because both run in the same JavaScript context.
 * Opening is memoised on a promise so two concurrent callers — a location
 * callback arriving while the UI is still starting up — cannot race into two
 * connections and two migration runs.
 */

export const DATABASE_NAME = "openmapx-navigation.db";

/**
 * The narrow slice of SQLite this app actually uses.
 *
 * Depending on a structural port rather than `SQLite.SQLiteDatabase` keeps the
 * storage layer honest about its surface, and lets the test suite substitute a
 * real SQLite engine — `expo-sqlite` has no Node implementation, so testing
 * against the Expo type directly would mean mocking away the very constraints
 * and transaction semantics these tests exist to verify.
 */
export interface Database {
  execAsync(source: string): Promise<void>;
  runAsync(
    source: string,
    params?: readonly unknown[],
  ): Promise<{ changes: number; lastInsertRowId: number }>;
  getFirstAsync<T>(source: string, params?: readonly unknown[]): Promise<T | null>;
  getAllAsync<T>(source: string, params?: readonly unknown[]): Promise<T[]>;
  withExclusiveTransactionAsync(task: (tx: Database) => Promise<void>): Promise<void>;
  closeAsync(): Promise<void>;
}

/**
 * Runs every write on `database` one at a time.
 *
 * `expo-sqlite` executes `withExclusiveTransactionAsync` on a connection of its
 * own, and a second writer that finds the file locked fails at once with
 * "database is locked" rather than waiting. Writes start from independent
 * places (a location batch, a fire-and-forget diagnostic, a page command), so
 * without a queue two of them regularly overlap and one is lost. Everything in
 * this process shares one JavaScript context, so one queue covers all of them.
 * Reads stay concurrent; WAL lets them proceed beside a writer.
 *
 * A transaction body must use the `tx` it is given, never the outer handle,
 * or it would wait on itself.
 */
export function serialiseWrites(database: Database): Database {
  let tail: Promise<unknown> = Promise.resolve();
  const queued = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    execAsync: (source) => queued(() => database.execAsync(source)),
    runAsync: (source, params) => queued(() => database.runAsync(source, params)),
    getFirstAsync: (source, params) => database.getFirstAsync(source, params),
    getAllAsync: (source, params) => database.getAllAsync(source, params),
    withExclusiveTransactionAsync: (task) =>
      queued(() => database.withExclusiveTransactionAsync(task)),
    closeAsync: () => queued(() => database.closeAsync()),
  };
}

let opening: Promise<Database> | null = null;

export function getDatabase(): Promise<Database> {
  opening ??= (async () => {
    const opened = (await SQLite.openDatabaseAsync(DATABASE_NAME)) as unknown as Database;
    const database = serialiseWrites(opened);
    await database.execAsync("PRAGMA journal_mode = WAL");
    await database.execAsync("PRAGMA foreign_keys = ON");
    // A lock held by another process (or a connection this queue does not
    // see) is waited for briefly instead of failing outright.
    await database.execAsync("PRAGMA busy_timeout = 5000");
    await migrateSessionSchema(database);
    return database;
  })().catch((error) => {
    // A failed open must not poison every later attempt.
    opening = null;
    throw error;
  });
  return opening;
}

/** Test seam: drops the memoised connection so a suite can supply its own. */
export function resetDatabaseCache(): void {
  opening = null;
}
