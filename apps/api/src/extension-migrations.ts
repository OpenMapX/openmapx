import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extensionSchemaName } from "@openmapx/core/component-id";
import {
  MIGRATION_FILE_PATTERN,
  MIGRATION_NAME_PATTERN,
} from "@openmapx/extension-contracts/archive";
import { loggableThrown } from "@openmapx/integration-framework";
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
import {
  erasurePendingAttentionKey,
  schemaAheadAttentionKey,
} from "./privacy/extension-subject-data";
import { processLogger } from "./process-logger";
import { resolveAttention } from "./services/attention";

export { schemaAheadAttentionKey };

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
 *
 * `set constraints all immediate` fires the checks of deferred constraints
 * the file left pending inside the same statement, so a violation is
 * reported with the file's name rather than at the run's `COMMIT`. The mode
 * stays immediate for the rest of the run.
 *
 * `reset all` in the same statement returns every setting the file changed
 * to the session's own (its search path and limits are startup parameters)
 * before the runner's next statement starts, so a file's statement timeout
 * or search path cannot apply to the runner's checks, its bookkeeping or the
 * next file. A statement timeout set during a statement does not apply to
 * that statement itself.
 */
const CREATE_RUN_MIGRATION =
  "create function pg_temp.openmapx_run_migration(migration text) returns void language plpgsql as $run$ begin execute migration; set constraints all immediate; reset all; end $run$";
const RUN_MIGRATION = "select pg_temp.openmapx_run_migration($1)";

/**
 * The first foreign key of the integration's schema that could stop the
 * platform from deleting a row outside the schema, such as an account.
 * Account deletion and the platform's other cleanups delete rows in many
 * tables, and the set grows with the platform, so every table outside the
 * schema counts. The effect is judged over the whole schema:
 *
 * - a key to a table outside the schema must be `ON DELETE CASCADE`;
 * - the tables such a cascade deletes rows from, directly or through
 *   further cascades in the schema, are `reachable`, and every key to one of
 *   them must be `ON DELETE CASCADE` as well.
 *
 * Every other action is refused. `SET NULL` and `SET DEFAULT` write into the
 * referencing row, and whether that write succeeds depends on what else
 * constrains the column: a key that references it, a `MATCH FULL` key, a
 * domain, a generated column, a check. `NO ACTION` lets a cascade through
 * only when the same statement deletes the referencing rows, which depends
 * on data. A key on or to a partitioned table has a copy for each partition,
 * and each copy is judged on its own: a cascade may reach one partition but
 * not its parent, so the copy that references that partition decides. A
 * refused copy is reported under the name of the key it was copied from.
 * Triggers and rules are not judged.
 */
const BLOCKING_FOREIGN_KEY = `with recursive fk as (
    select c.oid, c.conname::text as name, c.conrelid, c.confrelid, c.conparentid,
      c.confdeltype::text as action,
      target.relnamespace <> c.connamespace as leaves,
      format('%I.%I', source_ns.nspname, source.relname) as source,
      format('%I.%I', target_ns.nspname, target.relname) as target
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class source on source.oid = c.conrelid
    join pg_catalog.pg_namespace source_ns on source_ns.oid = source.relnamespace
    join pg_catalog.pg_class target on target.oid = c.confrelid
    join pg_catalog.pg_namespace target_ns on target_ns.oid = target.relnamespace
    where c.contype = 'f' and c.connamespace = pg_catalog.to_regnamespace($1)
  ),
  reachable as (
    select conrelid as relid, target as origin, array[name] as path, array[conrelid] as visited
      from fk where leaves and action = 'c'
    union all
    select fk.conrelid, r.origin, r.path || fk.name, r.visited || fk.conrelid
      from fk join reachable r on fk.confrelid = r.relid
      where not fk.leaves and fk.action = 'c' and fk.conrelid <> all(r.visited)
  ),
  lineage as (
    select fk.oid, fk.conparentid as parent, fk.name as root from fk
    union all
    select l.oid, c.conparentid, c.conname::text
      from lineage l join pg_catalog.pg_constraint c on c.oid = l.parent
  ),
  refused as (
    select distinct on (fk.oid) l.root as name, fk.source, fk.target, fk.action, r.origin, r.path
      from fk
      join lineage l on l.oid = fk.oid and l.parent = 0
      left join reachable r on not fk.leaves and r.relid = fk.confrelid
      where (fk.leaves or r.relid is not null)
        and fk.action <> 'c'
      order by fk.oid, cardinality(r.path)
  )
  select name, source, target, action, origin, path
    from refused order by name limit 1`;

interface BlockingForeignKey {
  readonly name: string;
  readonly source: string;
  readonly target: string;
  /** `confdeltype`: `a` NO ACTION, `r` RESTRICT, `d` SET DEFAULT, `n` SET NULL. */
  readonly action: string;
  /** For a key inside the schema: the outside table the cascade starts from. */
  readonly origin: string | null;
  /** For a key inside the schema: the keys the cascade follows, in order. */
  readonly path: string[] | null;
}

const DELETE_ACTIONS: Record<string, string> = {
  a: "NO ACTION",
  r: "RESTRICT",
  d: "SET DEFAULT",
  n: "SET NULL",
};

function foreignKeyRefusal(prefix: string, key: BlockingForeignKey): string {
  const cascade =
    key.origin === null || key.path === null
      ? ""
      : `; rows of ${key.target} are deleted by a cascade from ${key.origin} through ${key.path.join(", ")}`;
  return `${prefix} adds foreign key ${key.name} on ${key.source} to ${key.target} with ON DELETE ${DELETE_ACTIONS[key.action] ?? key.action}${cascade}; declare ON DELETE CASCADE, or store the id without a foreign key and erase the rows through the subject-data handler, so the platform can still delete the rows it references, for example an account`;
}

/** The tables that hold an integration's rows outside its own schema. */
const INTEGRATION_BOOKKEEPING_TABLES = [
  "extension_migration",
  "integration_task_run",
  "subject_erasure_pending",
  "integration_subject_handler",
] as const;

/** Cancels each migration run in progress and resolves once its session is ended. */
const runningMigrations = new Set<() => Promise<void>>();

/**
 * Set once the process is stopping. Start-up and a reload migrate one
 * integration after another, so cancelling only the run in progress would
 * let the next integration's run open a session the process then leaves
 * behind.
 */
let stopRequested = false;

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
 * that is stopping: from now on every new run is refused before it opens a
 * session, so start-up or a reload cannot go on to the next integration.
 */
export async function cancelRunningExtensionMigrations(): Promise<void> {
  stopRequested = true;
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
  if (stopRequested)
    throw new Error(`Migrations of ${integrationId} were cancelled because the API is stopping`);
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
  // ends no later than the client's deadline, which reports the outcome. As
  // startup parameters these are what a `RESET ALL`, the file's or the
  // runner's, returns to.
  const session = openMigrationSession({
    lock_timeout: String(lockTimeoutMs),
    transaction_timeout: String(deadlineMs),
    search_path: integrationSearchPath(schema),
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
    const prefix = `Migration ${file.name} of ${integrationId}`;
    try {
      await run(tx, RUN_MIGRATION, [file.text]);
    } catch (error) {
      throw migrationFailure(integrationId, file, error);
    }
    let blocking: BlockingForeignKey | undefined;
    try {
      [blocking] = await run<BlockingForeignKey[]>(tx, BLOCKING_FOREIGN_KEY, [schema]);
      if (!blocking)
        await run(
          tx,
          "insert into public.extension_migration (integration_id, name, sha256) values ($1, $2, $3)",
          [integrationId, file.name, file.sha256],
        );
    } catch (error) {
      // What the file left that `reset all` cannot undo, such as a read-only
      // transaction, fails the runner's own statements.
      throw new Error(`${prefix} failed: ${errorText(error)}`, { cause: error });
    }
    if (blocking) throw new Error(foreignKeyRefusal(prefix, blocking));
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

function errorText(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message ?? error);
}

/** The error of a file that failed, naming the file and, where known, its line. */
function migrationFailure(integrationId: string, file: ShippedMigration, error: unknown): Error {
  const failed = error as {
    internal_position?: unknown;
    internal_query?: unknown;
  } | null;
  const message = errorText(error);
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
 * from the platform's bookkeeping tables, on the caller's transaction: its
 * migrations, task runs, subject-data handler row and the erasures it still
 * owed, which are moot once its data is gone. Its database client is stopped
 * first, so code of it that is still running can no longer reach the
 * database. Waits for a migration of the same integration that is in
 * progress.
 *
 * The caller must call `afterCommit` once its transaction has committed: it
 * logs how many owed erasures were dropped and resolves the integration's
 * attention items. It never rejects. Without that call the drop is not
 * logged; the next erasure run and the next sync of the handler table still
 * resolve the items, but only then.
 */
export async function removeIntegrationData(
  tx: Pick<Sql, "unsafe">,
  integrationId: string,
): Promise<{ schema: string; droppedErasures: number; afterCommit: () => Promise<void> }> {
  const schema = extensionSchemaName(integrationId);
  stopIntegrationDatabase(integrationId);
  await tx.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    migrationLockName(integrationId),
  ]);
  await tx.unsafe(`drop schema if exists "${schema}" cascade`);
  let droppedErasures = 0;
  for (const table of INTEGRATION_BOOKKEEPING_TABLES) {
    const deleted = await tx.unsafe(
      `delete from public.${table} where integration_id = $1 returning 1`,
      [integrationId],
    );
    if (table === "subject_erasure_pending") droppedErasures = deleted.length;
  }
  const afterCommit = async () => {
    if (droppedErasures > 0)
      processLogger.warn(
        { integrationId, dropped: droppedErasures },
        `Dropped ${droppedErasures} owed erasure${droppedErasures === 1 ? "" : "s"} of integration ${integrationId}: its data was removed`,
      );
    for (const key of [
      erasurePendingAttentionKey(integrationId),
      schemaAheadAttentionKey(integrationId),
    ])
      await resolveAttention(key).catch((error: unknown) =>
        processLogger.warn(
          { err: loggableThrown(error), key },
          `Could not update the attention item ${key}`,
        ),
      );
  };
  return { schema, droppedErasures, afterCommit };
}
