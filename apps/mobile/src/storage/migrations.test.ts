import type { Database } from "./database";
import { LATEST_SCHEMA_VERSION, migrateSessionSchema, SESSION_MIGRATIONS } from "./migrations";
import { SESSION_TABLES } from "./sql";
import { openTestDatabase } from "./testing/nodeSqliteDatabase";

/**
 * These run against a real in-memory SQLite engine rather than a mock: a mock
 * cannot enforce a `CHECK`, reject a duplicate primary key or roll back a failed
 * transaction, and those are exactly the properties under test.
 */

async function schemaSnapshot(database: Database): Promise<string> {
  const rows = await database.getAllAsync<{ type: string; name: string; sql: string | null }>(
    "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name",
  );
  return JSON.stringify(rows);
}

describe("migrateSessionSchema", () => {
  it("declares strictly increasing versions with no gaps", () => {
    const versions = SESSION_MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions[0]).toBe(1);
    expect(versions.at(-1)).toBe(LATEST_SCHEMA_VERSION);
  });

  it("creates every session table from an empty database", async () => {
    const database = openTestDatabase();
    const applied = await migrateSessionSchema(database, 1_000);

    expect(applied).toEqual(SESSION_MIGRATIONS.map((migration) => migration.version));
    const tables = await database.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    );
    const names = tables.map((table) => table.name);
    for (const expected of SESSION_TABLES) expect(names).toContain(expected);
    await database.closeAsync();
  });

  it("records one row per applied migration", async () => {
    const database = openTestDatabase();
    await migrateSessionSchema(database, 4_242);

    const rows = await database.getAllAsync<{ version: number; applied_at_ms: number }>(
      "SELECT version, applied_at_ms FROM schema_migrations ORDER BY version",
    );
    expect(rows.map((row) => row.version)).toEqual(
      SESSION_MIGRATIONS.map((migration) => migration.version),
    );
    for (const row of rows) expect(row.applied_at_ms).toBe(4_242);
    await database.closeAsync();
  });

  it("is idempotent: a second run applies nothing and changes no schema", async () => {
    const database = openTestDatabase();
    await migrateSessionSchema(database, 1_000);
    const before = await schemaSnapshot(database);
    const beforeRows = await database.getAllAsync(
      "SELECT * FROM schema_migrations ORDER BY version",
    );

    const applied = await migrateSessionSchema(database, 9_999);

    expect(applied).toEqual([]);
    expect(await schemaSnapshot(database)).toBe(before);
    // Re-running must not restamp the original application times either.
    expect(await database.getAllAsync("SELECT * FROM schema_migrations ORDER BY version")).toEqual(
      beforeRows,
    );
    await database.closeAsync();
  });

  it("upgrades a database that predates the migration ledger", async () => {
    const database = openTestDatabase();
    // An installed build created the probe table under the older `user_version`
    // scheme, so the ledger is absent while the table already exists.
    await database.execAsync(
      `CREATE TABLE feasibility_probe (
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
    );
    await database.runAsync(
      `INSERT INTO feasibility_probe (id, callback_count, accepted_fix_count, rejected_fix_count, pending_audio_probe, updated_at_ms)
       VALUES (1, 7, 3, 1, 0, 500)`,
    );

    await migrateSessionSchema(database, 1_000);

    const preserved = await database.getFirstAsync<{ callback_count: number }>(
      "SELECT callback_count FROM feasibility_probe WHERE id = 1",
    );
    expect(preserved?.callback_count).toBe(7);
    await expect(
      database.getFirstAsync("SELECT name FROM sqlite_schema WHERE name = 'active_navigation'"),
    ).resolves.toBeTruthy();
    await database.closeAsync();
  });

  it("leaves no partial migration behind when a statement fails", async () => {
    const database = openTestDatabase();
    await database.execAsync("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
    // The real insert names `applied_at_ms`, which this stand-in table lacks, so
    // migration 1 fails after its DDL has already run inside the transaction.
    await expect(migrateSessionSchema(database, 1_000)).rejects.toThrow();

    const probe = await database.getFirstAsync(
      "SELECT name FROM sqlite_schema WHERE name = 'feasibility_probe'",
    );
    expect(probe).toBeNull();
    await database.closeAsync();
  });

  it("constrains the singleton active session row", async () => {
    const database = openTestDatabase();
    await migrateSessionSchema(database, 1_000);
    const insert = (id: number) =>
      database.runAsync(
        `INSERT INTO active_navigation (
           id, session_id, revision, kind, status, started_at_ms, updated_at_ms, expires_at_ms, session_json
         ) VALUES (?, 's', 1, 'ground', 'active', 1, 1, 2, '{}')`,
        [id],
      );

    await insert(1);
    await expect(insert(2)).rejects.toThrow();
    await database.closeAsync();
  });

  it("rejects an out-of-vocabulary status or kind", async () => {
    const database = openTestDatabase();
    await migrateSessionSchema(database, 1_000);
    await expect(
      database.runAsync(
        `INSERT INTO active_navigation (
           id, session_id, revision, kind, status, started_at_ms, updated_at_ms, expires_at_ms, session_json
         ) VALUES (1, 's', 1, 'flying', 'active', 1, 1, 2, '{}')`,
      ),
    ).rejects.toThrow();
    await expect(
      database.runAsync(
        `INSERT INTO active_navigation (
           id, session_id, revision, kind, status, started_at_ms, updated_at_ms, expires_at_ms, session_json
         ) VALUES (1, 's', 1, 'ground', 'cruising', 1, 1, 2, '{}')`,
      ),
    ).rejects.toThrow();
    await database.closeAsync();
  });

  it("keeps the terminal acknowledgement free of location-bearing columns", async () => {
    const database = openTestDatabase();
    await migrateSessionSchema(database, 1_000);
    const columns = await database.getAllAsync<{ name: string }>("PRAGMA table_info(terminal_ack)");
    const names = columns.map((column) => column.name.toLowerCase());

    expect(names).toEqual([
      "session_id",
      "kind",
      "final_status",
      "final_revision",
      "completed_at_ms",
    ]);
    for (const forbidden of ["lat", "lng", "coords", "geometry", "route", "token", "text"]) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
    await database.closeAsync();
  });
});
