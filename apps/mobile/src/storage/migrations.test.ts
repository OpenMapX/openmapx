import type { Database } from "./database";
import { LATEST_SCHEMA_VERSION, migrateSessionSchema, SESSION_MIGRATIONS } from "./migrations";
import { RELEASE_TABLES } from "./sql";
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
    expect(versions).toEqual(
      Array.from({ length: LATEST_SCHEMA_VERSION }, (_, index) => index + 1),
    );
  });

  it("starts the history with one baseline", () => {
    expect(SESSION_MIGRATIONS.map((migration) => migration.version)).toEqual([1]);
  });

  it("creates exactly the tables the release uses from an empty database", async () => {
    const database = openTestDatabase();
    const applied = await migrateSessionSchema(database, 1_000);

    expect(applied).toEqual([1]);
    expect(
      await database.getAllAsync(
        "SELECT version, applied_at_ms FROM schema_migrations ORDER BY version",
      ),
    ).toEqual([{ version: 1, applied_at_ms: 1_000 }]);
    const tables = await database.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    expect(tables.map((table) => table.name)).toEqual([...RELEASE_TABLES].sort());
    await database.closeAsync();
  });

  it("creates every table only once, so it never runs over an unexpected one", async () => {
    const database = openTestDatabase();
    await database.execAsync(
      "CREATE TABLE car_destinations (id INTEGER PRIMARY KEY, instance TEXT, payload TEXT)",
    );

    await expect(migrateSessionSchema(database, 1_000)).rejects.toThrow();
    await expect(
      database.getFirstAsync("SELECT name FROM sqlite_schema WHERE name = 'active_navigation'"),
    ).resolves.toBeNull();
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

  it("leaves no partial migration behind when a statement fails", async () => {
    const database = openTestDatabase();
    await database.execAsync("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
    // The real insert names `applied_at_ms`, which this stand-in table lacks, so
    // migration 1 fails after its DDL has already run inside the transaction.
    await expect(migrateSessionSchema(database, 1_000)).rejects.toThrow();

    const created = await database.getFirstAsync(
      "SELECT name FROM sqlite_schema WHERE name = 'active_navigation'",
    );
    expect(created).toBeNull();
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
    await database.closeAsync();
  });
});
