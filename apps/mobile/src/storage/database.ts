import * as SQLite from "expo-sqlite";

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
 * Migrations are ordered and applied inside one transaction each, keyed off
 * SQLite's own `user_version`. Adding a migration means appending to this array
 * and never editing an earlier entry.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; statements: readonly string[] }> = [
  {
    version: 1,
    statements: [
      // Feasibility probe state. Deliberately has no latitude/longitude column:
      // proving the background path works must not create a location history.
      `CREATE TABLE IF NOT EXISTS feasibility_probe (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        callback_count INTEGER NOT NULL,
        accepted_fix_count INTEGER NOT NULL,
        rejected_fix_count INTEGER NOT NULL,
        last_timestamp_ms INTEGER,
        last_accuracy_bucket TEXT,
        last_callback_gap_ms INTEGER,
        max_callback_gap_ms INTEGER,
        last_error_code TEXT,
        pending_audio_probe INTEGER NOT NULL DEFAULT 0,
        audio_result_code TEXT,
        updated_at_ms INTEGER NOT NULL
      )`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Applies every migration newer than the database's recorded version. */
export async function migrate(database: Database): Promise<void> {
  const row = await database.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  const current = row?.user_version ?? 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    await database.withExclusiveTransactionAsync(async (tx) => {
      for (const statement of migration.statements) await tx.execAsync(statement);
      // `PRAGMA` does not accept bound parameters; the value is a literal from
      // this module, never user input.
      await tx.execAsync(`PRAGMA user_version = ${migration.version}`);
    });
  }
}

let opening: Promise<Database> | null = null;

export function getDatabase(): Promise<Database> {
  opening ??= (async () => {
    const database = (await SQLite.openDatabaseAsync(DATABASE_NAME)) as unknown as Database;
    await database.execAsync("PRAGMA journal_mode = WAL");
    await database.execAsync("PRAGMA foreign_keys = ON");
    await migrate(database);
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
