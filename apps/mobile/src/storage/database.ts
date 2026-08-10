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

let opening: Promise<Database> | null = null;

export function getDatabase(): Promise<Database> {
  opening ??= (async () => {
    const database = (await SQLite.openDatabaseAsync(DATABASE_NAME)) as unknown as Database;
    await database.execAsync("PRAGMA journal_mode = WAL");
    await database.execAsync("PRAGMA foreign_keys = ON");
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
