import type { Database } from "./database";
import {
  CREATE_ACTIVE_NAVIGATION,
  CREATE_ACTIVE_NAVIGATION_INDEX,
  CREATE_CAR_DESTINATIONS,
  CREATE_DIAGNOSTIC_EVENTS,
  CREATE_DIAGNOSTIC_EVENTS_INDEX,
  CREATE_PROCESSED_COMMANDS,
  CREATE_PROCESSED_COMMANDS_INDEX,
  CREATE_QUARANTINED_SESSIONS,
  CREATE_SCHEDULED_ALERTS,
  CREATE_SCHEDULED_ALERTS_INDEX,
  CREATE_SCHEMA_MIGRATIONS,
  CREATE_TERMINAL_ACK,
  INSERT_APPLIED_MIGRATION,
  SELECT_APPLIED_MIGRATIONS,
} from "./sql";

/**
 * The ordered, append-only schema history.
 *
 * Version 1 is the schema the first release ships. Editing an existing entry
 * would leave installed devices on a different shape than a fresh install, so
 * new work always appends a version. Each version runs exactly once, inside
 * the transaction that records it.
 */
export interface Migration {
  version: number;
  statements: readonly string[];
}

export const SESSION_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      CREATE_ACTIVE_NAVIGATION,
      CREATE_ACTIVE_NAVIGATION_INDEX,
      CREATE_TERMINAL_ACK,
      CREATE_PROCESSED_COMMANDS,
      CREATE_PROCESSED_COMMANDS_INDEX,
      CREATE_SCHEDULED_ALERTS,
      CREATE_SCHEDULED_ALERTS_INDEX,
      CREATE_DIAGNOSTIC_EVENTS,
      CREATE_DIAGNOSTIC_EVENTS_INDEX,
      CREATE_QUARANTINED_SESSIONS,
      CREATE_CAR_DESTINATIONS,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = Math.max(
  ...SESSION_MIGRATIONS.map((migration) => migration.version),
);

/**
 * Applies every migration this database has not recorded yet.
 *
 * Each migration and its bookkeeping row commit together in one exclusive
 * transaction, so an interrupted upgrade leaves the database at a version that
 * genuinely matches its shape rather than at a version it merely claims.
 *
 * Returns the versions actually applied, which is what makes idempotency
 * observable to a caller instead of only to the schema.
 */
export async function migrateSessionSchema(
  database: Database,
  nowMs: number = Date.now(),
): Promise<number[]> {
  await database.execAsync(CREATE_SCHEMA_MIGRATIONS);
  const applied = new Set(
    (await database.getAllAsync<{ version: number }>(SELECT_APPLIED_MIGRATIONS)).map(
      (row) => row.version,
    ),
  );

  const ordered = [...SESSION_MIGRATIONS].sort((a, b) => a.version - b.version);
  const performed: number[] = [];
  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;
    await database.withExclusiveTransactionAsync(async (tx) => {
      for (const statement of migration.statements) await tx.execAsync(statement);
      await tx.runAsync(INSERT_APPLIED_MIGRATION, [migration.version, nowMs]);
    });
    performed.push(migration.version);
  }
  return performed;
}
