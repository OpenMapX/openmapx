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
  integrationSearchPath,
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
/** PostgreSQL's `feature_not_supported`, which `EXECUTE` of COMMIT, ROLLBACK, BEGIN or SAVEPOINT raises. */
const FEATURE_NOT_SUPPORTED = "0A000";
/** PostgreSQL's `invalid_transaction_termination`: a COMMIT or ROLLBACK in a DO block or procedure. */
const INVALID_TRANSACTION_TERMINATION = "2D000";
/** PostgreSQL's `active_sql_transaction`: a statement that refuses to run inside a transaction or function. */
const ACTIVE_SQL_TRANSACTION = "25001";

/**
 * Runs one migration file. A multi-statement string through PL/pgSQL
 * `EXECUTE` runs inside the caller's transaction, and the server refuses any
 * statement in it that would end or start one, so a file can neither commit
 * part of the run nor carry on outside it.
 */
const CREATE_RUN_MIGRATION =
  "create function pg_temp.openmapx_run_migration(migration text) returns void language plpgsql as $run$ begin execute migration; end $run$";
const RUN_MIGRATION = "select pg_temp.openmapx_run_migration($1)";

/**
 * A foreign key from the integration's schema to a table outside it that
 * would block deleting the row it references. Account deletion and the
 * platform's other cleanups delete rows in many tables, and the set grows
 * with the platform, so every table outside the schema counts.
 */
const BLOCKING_FOREIGN_KEY = `select c.conname as name, format('%I.%I', target_ns.nspname, target.relname) as target
  from pg_constraint c
  join pg_class target on target.oid = c.confrelid
  join pg_namespace target_ns on target_ns.oid = target.relnamespace
  where c.contype = 'f'
    and c.connamespace = to_regnamespace($1)
    and target.relnamespace <> c.connamespace
    and c.confdeltype not in ('c', 'n')
  order by c.conname
  limit 1`;

/** The tables that hold an integration's rows outside its own schema. */
const INTEGRATION_BOOKKEEPING_TABLES = [
  "extension_migration",
  "integration_task_run",
  "subject_erasure_pending",
  "integration_subject_handler",
] as const;

/** Cancels each migration run in progress and resolves once its session is ended. */
const runningMigrations = new Set<() => Promise<void>>();

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

type Run = <T>(client: Pick<Sql, "unsafe">, query: string, params?: unknown[]) => Promise<T>;

/**
 * Cancels the extension migrations in progress: each running statement is
 * cancelled, the transaction rolls back and the session ends, which releases
 * the migration lock. Resolves once every session is ended. For a process
 * that stops before start-up has finished.
 */
export async function cancelRunningExtensionMigrations(): Promise<void> {
  await Promise.all([...runningMigrations].map((cancel) => cancel()));
}

/**
 * Applies the integration's pending migrations in its own `ext_` schema, all
 * in one transaction on a session of their own, and records each in
 * `extension_migration`. The files are read through the verified path, so
 * what runs is what the operations agent installed. `schemaAhead` reports a
 * recorded migration this version does not ship: a newer version ran it and
 * was rolled back, which the older code may well survive.
 *
 * Both bounds hold on the server as well: the session's `lock_timeout` and
 * `transaction_timeout` end a migration whose API process went away, and the
 * server then releases the migration lock with the session.
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

  // The transaction starts after the lock wait, so the server's bound on it
  // ends no later than the client's deadline, which reports the outcome.
  const session = openMigrationSession({
    lock_timeout: String(lockTimeoutMs),
    transaction_timeout: String(deadlineMs),
  });
  let stopped: Error | undefined;
  let current: Statement | undefined;
  let rejectStopped!: (reason: Error) => void;
  const stopping = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  stopping.catch(() => {});
  // The cancelled statement fails the transaction, which postgres.js then rolls back.
  const stop = (reason: Error) => {
    if (stopped) return;
    stopped = reason;
    cancelQuietly(current);
    rejectStopped(reason);
  };
  const run: Run = async <T>(client: Pick<Sql, "unsafe">, query: string, params?: unknown[]) => {
    if (stopped) throw stopped;
    current = send(client, query, params);
    return (await current) as T;
  };

  let markEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    markEnded = resolve;
  });
  const cancel = () => {
    stop(new Error(`Migrations of ${integrationId} were cancelled`));
    return ended;
  };
  runningMigrations.add(cancel);

  const work = (async () => {
    // Released when the session ends.
    await run(session, "select pg_advisory_lock(hashtextextended($1, 0))", [
      migrationLockName(integrationId),
    ]);
    return session.begin((tx) => migrateInTransaction(tx, integrationId, schema, files, run));
  })();
  work.catch(() => {});
  const timer = setTimeout(
    () =>
      stop(
        new Error(
          `Migrations of ${integrationId} did not finish within ${deadlineMs / 1000} seconds`,
        ),
      ),
    deadlineMs,
  );
  timer.unref?.();
  try {
    return await Promise.race([work, stopping]);
  } catch (error) {
    if (
      !stopped &&
      (hasCode(error, LOCK_NOT_AVAILABLE) ||
        hasCode((error as { cause?: unknown } | null)?.cause, LOCK_NOT_AVAILABLE))
    )
      throw new Error(
        `Migrations of ${integrationId} waited longer than ${lockTimeoutMs / 1000} seconds for a database lock`,
        { cause: error },
      );
    throw error;
  } finally {
    clearTimeout(timer);
    try {
      await session.end({ timeout: 5 });
    } finally {
      runningMigrations.delete(cancel);
      markEnded();
    }
  }
}

async function migrateInTransaction(
  tx: Pick<Sql, "unsafe">,
  integrationId: string,
  schema: string,
  files: readonly ShippedMigration[],
  run: Run,
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

  const recorded = await run<Array<{ name: string; sha256: string }>>(
    tx,
    "select name, sha256 from public.extension_migration where integration_id = $1",
    [integrationId],
  );
  const recordedSha256 = new Map(recorded.map((row) => [row.name, row.sha256]));
  const highestRecorded = Math.max(0, ...recorded.map((row) => sequenceNumber(row.name)));
  const pending: ShippedMigration[] = [];
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
    pending.push(file);
  }

  if (pending.length > 0) await run(tx, CREATE_RUN_MIGRATION);
  for (const file of pending) {
    // Whatever the file before changed, each file starts from the session's
    // own settings, with the timeouts it was opened with, in the schema.
    await run(tx, "reset all");
    await run(tx, "select set_config('search_path', $1, true)", [integrationSearchPath(schema)]);
    try {
      await run(tx, RUN_MIGRATION, [file.text]);
    } catch (error) {
      throw migrationFailure(integrationId, file, error);
    }
    const [blocking] = await run<Array<{ name: string; target: string }>>(
      tx,
      BLOCKING_FOREIGN_KEY,
      [schema],
    );
    if (blocking)
      throw new Error(
        `Migration ${file.name} of ${integrationId} adds foreign key ${blocking.name} to ${blocking.target} without ON DELETE CASCADE or ON DELETE SET NULL; declare one of them so the platform can still delete the rows it references, for example an account`,
      );
    await run(
      tx,
      "insert into public.extension_migration (integration_id, name, sha256) values ($1, $2, $3)",
      [integrationId, file.name, file.sha256],
    );
  }
  const shipped = new Set(files.map((file) => file.name));
  return {
    applied: pending.map((file) => file.name),
    schemaAhead: recorded.some((row) => !shipped.has(row.name)),
  };
}

/** The 1-based line of the 1-based character `position` in `text`. */
function lineAt(text: string, position: number): number {
  const before = Array.from(text)
    .slice(0, position - 1)
    .join("");
  return before.split("\n").length;
}

/** The error of a file that failed, naming the file and, where known, its line. */
function migrationFailure(integrationId: string, file: ShippedMigration, error: unknown): Error {
  const failed = error as {
    message?: unknown;
    internal_position?: unknown;
    internal_query?: unknown;
  } | null;
  const message = String(failed?.message ?? error);
  const prefix = `Migration ${file.name} of ${integrationId}`;
  if (
    hasCode(error, INVALID_TRANSACTION_TERMINATION) ||
    (hasCode(error, FEATURE_NOT_SUPPORTED) && message.includes("transaction commands"))
  )
    return new Error(
      `${prefix} may not end or start a transaction (COMMIT, ROLLBACK, BEGIN, SAVEPOINT); all migrations of a start run in one transaction`,
      { cause: error },
    );
  if (hasCode(error, ACTIVE_SQL_TRANSACTION))
    return new Error(
      `${prefix} contains a statement that cannot run inside a transaction, such as CREATE INDEX CONCURRENTLY or VACUUM: ${message}`,
      { cause: error },
    );
  const position = Number(failed?.internal_position);
  const line =
    failed?.internal_query === file.text && Number.isInteger(position) && position > 0
      ? ` at line ${lineAt(file.text, position)}`
      : "";
  return new Error(`${prefix} failed${line}: ${message}`, { cause: error });
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
