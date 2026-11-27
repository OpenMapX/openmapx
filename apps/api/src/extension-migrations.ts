import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extensionSchemaName } from "@openmapx/core/component-id";
import {
  MIGRATION_FILE_PATTERN,
  MIGRATION_NAME_PATTERN,
} from "@openmapx/extension-contracts/archive";
import type { Sql } from "postgres";
import { openMigrationSession } from "./db";
import {
  cancelQuietly,
  hasCode,
  type Statement,
  send,
  stopIntegrationDatabase,
} from "./integration-db";
import { readIntegrationFile, verifiedIntegrationPaths } from "./integration-files";

const MIGRATIONS_DIRECTORY = "migrations";

/**
 * How long one statement of the migration session waits for a lock,
 * including the integration's migration lock, before the migration fails. A
 * migration is not otherwise bounded per statement: it may rewrite a large
 * table.
 */
export const MIGRATION_LOCK_TIMEOUT_MS = 120_000;

/**
 * How long an integration's migrations may run in all. They run before its
 * code is imported and outside the load deadline, which a legitimate
 * migration may outlast; this bound keeps one that never ends from holding up
 * start-up or the reload queue for good.
 */
export const MIGRATION_DEADLINE_MS = 30 * 60_000;

/** PostgreSQL's `lock_not_available`: a lock wait passed `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03";

/** The tables that hold an integration's rows outside its own schema. */
const INTEGRATION_BOOKKEEPING_TABLES = [
  "extension_migration",
  "integration_task_run",
  "subject_erasure_pending",
  "integration_subject_handler",
] as const;

function migrationLockName(integrationId: string): string {
  return `openmapx-ext-migrations:${integrationId}`;
}

function sequenceNumber(name: string): number {
  return Number(MIGRATION_NAME_PATTERN.exec(name)?.[1] ?? Number.NaN);
}

/**
 * The file names under `migrations/` whose path matches the archive's
 * migration pattern, sorted, so in the order they apply. With a verified file
 * list only the paths the operations agent recorded count; without one the
 * directory is read as it is.
 */
export function listMigrationFiles(
  directory: string,
  verifiedPaths: readonly string[] | null,
): string[] {
  let paths: readonly string[] = verifiedPaths ?? [];
  if (verifiedPaths === null) {
    const migrations = join(directory, MIGRATIONS_DIRECTORY);
    paths = existsSync(migrations)
      ? readdirSync(migrations, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => `${MIGRATIONS_DIRECTORY}/${entry.name}`)
      : [];
  }
  return paths
    .filter((path) => MIGRATION_FILE_PATTERN.test(path))
    .map((path) => path.slice(MIGRATIONS_DIRECTORY.length + 1))
    .sort();
}

export interface ExtensionMigrationLimits {
  /** Overrides `MIGRATION_LOCK_TIMEOUT_MS`. */
  readonly lockTimeoutMs?: number;
  /** Overrides `MIGRATION_DEADLINE_MS`. */
  readonly deadlineMs?: number;
}

interface ShippedMigration {
  readonly name: string;
  readonly sha256: string;
  readonly text: string;
}

/**
 * Applies the integration's pending migrations in its own `ext_` schema, all
 * in one transaction on a session of their own, and records each in
 * `extension_migration`. The files are read through the verified path, so
 * what runs is what the operations agent installed. `schemaAhead` reports a
 * recorded migration this version does not ship: a newer version ran it and
 * was rolled back, which the older code may well survive.
 */
export async function applyExtensionMigrations(args: {
  integrationId: string;
  directory: string;
  limits?: ExtensionMigrationLimits;
}): Promise<{ applied: string[]; schemaAhead: boolean }> {
  const { integrationId, directory } = args;
  const schema = extensionSchemaName(integrationId);
  const lockTimeoutMs = args.limits?.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS;
  const deadlineMs = args.limits?.deadlineMs ?? MIGRATION_DEADLINE_MS;
  const files: ShippedMigration[] = listMigrationFiles(
    directory,
    verifiedIntegrationPaths(directory),
  ).map((name) => {
    const bytes = readIntegrationFile(directory, `${MIGRATIONS_DIRECTORY}/${name}`);
    if (!bytes)
      throw new Error(
        `Migration ${name} of ${integrationId} is missing or changed since installation`,
      );
    return {
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: bytes.toString("utf8"),
    };
  });

  const session = openMigrationSession();
  const deadlineError = new Error(
    `Migrations of ${integrationId} did not finish within ${deadlineMs / 1000} seconds`,
  );
  let expired = false;
  let current: Statement | undefined;
  const run = async <T>(client: Pick<Sql, "unsafe">, query: string, params?: unknown[]) => {
    if (expired) throw deadlineError;
    current = send(client, query, params);
    return (await current) as T;
  };

  const work = (async () => {
    await run(session, "select set_config('lock_timeout', $1, false)", [String(lockTimeoutMs)]);
    // Released when the session ends.
    await run(session, "select pg_advisory_lock(hashtextextended($1, 0))", [
      migrationLockName(integrationId),
    ]);
    return session.begin((tx) => migrateInTransaction(tx, integrationId, schema, files, run));
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      // The cancelled statement fails the transaction, which postgres.js then rolls back.
      cancelQuietly(current);
      reject(deadlineError);
    }, deadlineMs);
    timer.unref?.();
  });
  work.catch(() => {});
  deadline.catch(() => {});
  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    if (!expired && hasCode(error, LOCK_NOT_AVAILABLE))
      throw new Error(
        `Migrations of ${integrationId} waited longer than ${lockTimeoutMs / 1000} seconds for a database lock`,
        { cause: error },
      );
    throw error;
  } finally {
    clearTimeout(timer);
    await session.end({ timeout: 5 });
  }
}

async function migrateInTransaction(
  tx: Pick<Sql, "unsafe">,
  integrationId: string,
  schema: string,
  files: readonly ShippedMigration[],
  run: <T>(client: Pick<Sql, "unsafe">, query: string, params?: unknown[]) => Promise<T>,
): Promise<{ applied: string[]; schemaAhead: boolean }> {
  const [namespace] = await run<Array<{ present: boolean; owned: boolean | null }>>(
    tx,
    `select to_regnamespace($1) is not null as present,
      (select pg_get_userbyid(nspowner) = current_user from pg_namespace where nspname = $1) as owned`,
    [schema],
  );
  // Never `if not exists`: that would take on a schema someone else created.
  if (!namespace?.present) await run(tx, `create schema "${schema}"`);
  else if (namespace.owned !== true)
    throw new Error(`Schema ${schema} of ${integrationId} is not owned by the API role`);
  await run(tx, "select set_config('search_path', $1, true)", [`"${schema}", public`]);

  const recorded = await run<Array<{ name: string; sha256: string }>>(
    tx,
    "select name, sha256 from public.extension_migration where integration_id = $1",
    [integrationId],
  );
  const recordedSha256 = new Map(recorded.map((row) => [row.name, row.sha256]));
  const highestRecorded = Math.max(0, ...recorded.map((row) => sequenceNumber(row.name)));
  const applied: string[] = [];
  for (const file of files) {
    const sha256 = recordedSha256.get(file.name);
    if (sha256 !== undefined) {
      if (sha256 !== file.sha256)
        throw new Error(`Migration ${file.name} of ${integrationId} changed after it was applied`);
      continue;
    }
    if (highestRecorded > sequenceNumber(file.name))
      throw new Error(
        `Migration ${file.name} of ${integrationId} is older than a migration that was already applied`,
      );
    const [before] = await run<Array<{ id: string }>>(tx, "select txid_current()::text as id");
    await run(tx, file.text);
    // A COMMIT or ROLLBACK in the file would leave the rest of the work
    // outside the transaction that is meant to undo it on failure.
    const [after] = await run<Array<{ id: string }>>(tx, "select txid_current()::text as id");
    if (before?.id !== after?.id)
      throw new Error(`Migration ${file.name} of ${integrationId} ended the migration transaction`);
    await run(
      tx,
      "insert into public.extension_migration (integration_id, name, sha256) values ($1, $2, $3)",
      [integrationId, file.name, file.sha256],
    );
    applied.push(file.name);
  }
  const shipped = new Set(files.map((file) => file.name));
  return { applied, schemaAhead: recorded.some((row) => !shipped.has(row.name)) };
}

/**
 * Drops the integration's schema with everything in it and deletes its rows
 * from the platform's bookkeeping tables, on the caller's transaction. Its
 * database client is stopped first, so code of it that is still running can
 * no longer reach the database. Waits for a migration of the same
 * integration that is in progress.
 */
export async function removeIntegrationData(
  tx: Pick<Sql, "unsafe">,
  integrationId: string,
): Promise<{ schema: string }> {
  const schema = extensionSchemaName(integrationId);
  stopIntegrationDatabase(integrationId);
  await tx.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    migrationLockName(integrationId),
  ]);
  await tx.unsafe(`drop schema if exists "${schema}" cascade`);
  for (const table of INTEGRATION_BOOKKEEPING_TABLES)
    await tx.unsafe(`delete from public.${table} where integration_id = $1`, [integrationId]);
  return { schema };
}
