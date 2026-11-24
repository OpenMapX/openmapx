import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";
import { jobChildLogger } from "../logger.js";
import {
  assertDataPublication,
  cancellableTransaction,
  dataWorkerSignal,
  publishDataChange,
  retainDataPublication,
} from "./execution/worker-scope.js";
import { buildPublicationFenceDDL, PUBLICATION_FENCE } from "./publication-fence.js";

/**
 * Publishing rebuilt data must never make the API's readers wait. A reader,
 * such as a backup, can hold the live tables for hours, and every statement
 * that asks for a lock behind it queues the readers that come after it. So a
 * publication only renames: renaming a schema takes no lock on its tables,
 * and every later query resolves the live name to the new tables. The old
 * tables are dropped afterwards, once their last reader has finished; until
 * then they sit under a name no reader uses. Before renaming, a publication
 * locks the schema's `publication_fence` (see `./publication-fence.ts`), which
 * no reader touches but a running backup holds, so a publication never
 * renames tables under a backup. Each step waits at most `lockTimeoutMs` for
 * a lock, so it can never queue readers for longer than that, and is retried
 * with growing pauses.
 */

export interface LockRetry {
  /** How often a step that timed out waiting for a lock runs in all. */
  attempts: number;
  /** The pause after the first timeout; it doubles after each further one, up to a minute. */
  backoffMs: number;
}

/** The longest a publication step waits for a lock, so readers queue behind it at most that long. */
export const PUBLICATION_LOCK_TIMEOUT_MS = 1000;

/** Enough to outlast a minute-long reader before a step gives up. */
export const PUBLICATION_LOCK_RETRY: LockRetry = { attempts: 8, backoffMs: 1000 };

const MAX_BACKOFF_MS = 60_000;
const LOCK_NOT_AVAILABLE = "55P03";
const DEADLOCK_DETECTED = "40P01";
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const MAX_IDENTIFIER_LENGTH = 63;

export interface PublishSchemaSwapOptions {
  live: string;
  staging: string;
  /**
   * Runs in the swap's transaction after the renames, to finish the new live
   * schema: for example to move a table over from the old one, now called
   * `previous`, which is null when no live schema existed.
   */
  carryOver?: (tx: postgres.TransactionSql, previous: string | null) => Promise<void>;
  lockTimeoutMs?: number;
  retry: LockRetry;
}

export interface PublishTableSwapOptions {
  schema: string;
  live: string;
  staging: string;
  /** Runs in the swap's transaction after the renames, for example to create an empty staging table. */
  afterSwap?: (tx: postgres.TransactionSql) => Promise<void>;
  lockTimeoutMs?: number;
  retry: LockRetry;
}

function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_LENGTH)
    throw new Error(`Invalid publication identifier "${name}"`);
}

export function previousName(live: string): string {
  const previous = `${live}__previous`;
  assertIdentifier(previous);
  return previous;
}

export function isLockTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === LOCK_NOT_AVAILABLE
  );
}

/**
 * A lock wait that ended without the lock: a timeout, or a deadlock whose
 * victim this statement was. A backup takes its locks one table at a time,
 * so a publication that holds the fence can meet a backup that is still
 * taking them. Either way PostgreSQL has rolled the whole transaction, or
 * savepoint, back, so it can run again.
 */
function isLockConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === LOCK_NOT_AVAILABLE || code === DEADLOCK_DETECTED;
}

function backoff(retry: LockRetry, attempt: number): number {
  return Math.min(retry.backoffMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/**
 * Runs `work` until it neither times out waiting for a lock nor loses a
 * deadlock, at most `retry.attempts` times. `work` must keep every effect
 * inside the transaction or savepoint that the failure rolls back. The last
 * error is rethrown unchanged, so a transaction that rolled back stays
 * recognisable as one.
 */
export async function retryOnLockTimeout<T>(retry: LockRetry, work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isLockConflict(error) || attempt >= retry.attempts) throw error;
      try {
        await sleep(backoff(retry, attempt), undefined, { signal: dataWorkerSignal() });
      } catch {
        throw error;
      }
    }
  }
}

function underLockTimeout<T>(
  sql: postgres.Sql,
  lockTimeoutMs: number,
  work: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0)
    throw new Error(`Invalid lock timeout ${lockTimeoutMs}`);
  return cancellableTransaction(sql, async (tx) => {
    await tx.unsafe(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    return work(tx);
  });
}

/**
 * Drops what a publication retired; returns false when that failed. The
 * publication has already committed and the next one drops the leftover
 * first, so no error here, a cancelled job included, fails the publication.
 */
async function dropRetired(
  sql: postgres.Sql,
  statement: string,
  what: string,
  lockTimeoutMs: number,
  retry: LockRetry,
): Promise<boolean> {
  try {
    await retryOnLockTimeout(retry, () =>
      underLockTimeout(sql, lockTimeoutMs, async (tx) => {
        await tx.unsafe(statement);
      }),
    );
    return true;
  } catch (error) {
    const logger = jobChildLogger({ publication: what });
    if (isLockTimeout(error)) {
      logger.warn(`${what} is still being read; it stays until the next publication drops it`);
    } else {
      const code = (error as { code?: unknown })?.code;
      logger.error(
        { code: typeof code === "string" ? code : undefined, err: (error as Error)?.message },
        `Dropping ${what} failed; it stays until the next publication drops it`,
      );
    }
    return false;
  }
}

/**
 * A publication that could not drop its old data leaves it behind, so the
 * next one drops it first. Unlike the drop after a swap, this one must
 * succeed: the old data's name is needed again.
 */
async function dropLeftover(
  sql: postgres.Sql,
  statement: string,
  lockTimeoutMs: number,
  retry: LockRetry,
): Promise<void> {
  await retryOnLockTimeout(retry, () =>
    underLockTimeout(sql, lockTimeoutMs, async (tx) => {
      await tx.unsafe(statement);
    }),
  );
}

/** Statistics for the first queries after the swap. */
async function analyzeSchema(sql: postgres.Sql, schema: string): Promise<void> {
  const tables = await sql.unsafe<{ name: string }[]>(
    `SELECT c.relname AS name FROM pg_class c
      WHERE c.relnamespace = to_regnamespace($1) AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
    [schema],
  );
  for (const { name } of tables) await sql`ANALYZE ${sql(schema)}.${sql(name)}`;
}

/**
 * Replaces the live schema with a fully built staging schema. The staging
 * schema's indexes and its fence must already exist; its tables are analyzed
 * here. One transaction locks the live fence, renames live to
 * `<live>__previous` and staging to live and drops the old fence; a second,
 * after the publication is recorded, drops `<live>__previous`. When
 * readers outlast that second step, the old schema stays and the next
 * publication drops it before it swaps.
 */
export async function publishSchemaSwap(
  sql: postgres.Sql,
  options: PublishSchemaSwapOptions,
): Promise<void> {
  const { live, staging, carryOver, retry } = options;
  const lockTimeoutMs = options.lockTimeoutMs ?? PUBLICATION_LOCK_TIMEOUT_MS;
  assertIdentifier(live);
  assertIdentifier(staging);
  const previous = previousName(live);

  await analyzeSchema(sql, staging);
  await dropLeftover(sql, `DROP SCHEMA IF EXISTS "${previous}" CASCADE`, lockTimeoutMs, retry);
  await assertDataPublication();
  await publishDataChange(() =>
    retryOnLockTimeout(retry, () =>
      underLockTimeout(sql, lockTimeoutMs, async (tx) => {
        const [current] = await tx.unsafe<{ exists: boolean; fenced: boolean }[]>(
          `SELECT to_regnamespace($1) IS NOT NULL AS exists, to_regclass($2) IS NOT NULL AS fenced`,
          [live, `"${staging}".${PUBLICATION_FENCE}`],
        );
        if (!current?.fenced)
          throw new Error(`The staging schema "${staging}" has no ${PUBLICATION_FENCE} table`);
        if (current.exists) {
          // Waits for a running backup, which holds the fence, before anything is renamed.
          await tx.unsafe(`LOCK TABLE "${live}".${PUBLICATION_FENCE} IN ACCESS EXCLUSIVE MODE`);
          await tx.unsafe(`ALTER SCHEMA "${live}" RENAME TO "${previous}"`);
        }
        await tx.unsafe(`ALTER SCHEMA "${staging}" RENAME TO "${live}"`);
        if (current.exists) await tx.unsafe(`DROP TABLE "${previous}".${PUBLICATION_FENCE}`);
        await carryOver?.(tx, current.exists ? previous : null);
      }),
    ),
  );
  await retainDataPublication();
  await dropRetired(
    sql,
    `DROP SCHEMA IF EXISTS "${previous}" CASCADE`,
    previous,
    lockTimeoutMs,
    retry,
  );
}

/** Replaces `from` as a whole underscore-separated part of an object name. */
function renamedObject(name: string, from: string, to: string): string | null {
  // `from` is a checked identifier, so it holds no pattern characters.
  const match = new RegExp(`(^|_)${from}(?=_|$)`).exec(name);
  if (!match) return null;
  const start = match.index + (match[1]?.length ?? 0);
  const renamed = `${name.slice(0, start)}${to}${name.slice(start + from.length)}`;
  if (renamed.length > MAX_IDENTIFIER_LENGTH)
    throw new Error(`Renaming "${name}" for publication gives a name longer than 63 bytes`);
  return renamed;
}

/**
 * Renames a table together with the indexes and constraints named after it,
 * so that its successor can take their names. It locks only that table.
 */
export async function renameTable(
  tx: postgres.TransactionSql,
  schema: string,
  from: string,
  to: string,
): Promise<void> {
  const indexes = await tx.unsafe<{ name: string }[]>(
    `SELECT i.relname AS name FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
      WHERE x.indrelid = to_regclass($1) ORDER BY i.relname`,
    [`"${schema}"."${from}"`],
  );
  // Postgres names new constraints so that they are unique in the schema, so
  // each one moves with its table's name. Those an index backs move with it.
  const constraints = await tx.unsafe<{ name: string }[]>(
    `SELECT conname AS name FROM pg_constraint
      WHERE conrelid = to_regclass($1) AND contype NOT IN ('p', 'u', 'x') ORDER BY conname`,
    [`"${schema}"."${from}"`],
  );
  await tx`ALTER TABLE ${tx(schema)}.${tx(from)} RENAME TO ${tx(to)}`;
  // Renaming an index also renames the constraint it backs.
  for (const { name } of indexes) {
    const renamed = renamedObject(name, from, to);
    if (renamed) await tx`ALTER INDEX ${tx(schema)}.${tx(name)} RENAME TO ${tx(renamed)}`;
  }
  for (const { name } of constraints) {
    const renamed = renamedObject(name, from, to);
    if (renamed)
      await tx`ALTER TABLE ${tx(schema)}.${tx(to)} RENAME CONSTRAINT ${tx(name)} TO ${tx(renamed)}`;
  }
}

/**
 * Replaces one live table with a fully built staging table in the same
 * schema, as `publishSchemaSwap` does for a schema. Renaming a table takes
 * its lock, so the swap waits for readers at most `lockTimeoutMs` per
 * attempt. Indexes and constraints named after a table move with its name.
 * The schema's fence is locked first and replaced in the same transaction.
 */
export async function publishTableSwap(
  sql: postgres.Sql,
  options: PublishTableSwapOptions,
): Promise<void> {
  const { schema, live, staging, afterSwap, retry } = options;
  const lockTimeoutMs = options.lockTimeoutMs ?? PUBLICATION_LOCK_TIMEOUT_MS;
  assertIdentifier(schema);
  assertIdentifier(live);
  assertIdentifier(staging);
  const previous = previousName(live);

  await sql.unsafe(`ANALYZE "${schema}"."${staging}"`);
  await dropLeftover(sql, `DROP TABLE IF EXISTS "${schema}"."${previous}"`, lockTimeoutMs, retry);
  await assertDataPublication();
  await publishDataChange(() =>
    retryOnLockTimeout(retry, () =>
      underLockTimeout(sql, lockTimeoutMs, async (tx) => {
        // Waits for a running backup, which holds the fence, before anything is renamed.
        await tx.unsafe(`LOCK TABLE "${schema}".${PUBLICATION_FENCE} IN ACCESS EXCLUSIVE MODE`);
        const [current] = await tx.unsafe<{ exists: boolean }[]>(
          `SELECT to_regclass($1) IS NOT NULL AS exists`,
          [`"${schema}"."${live}"`],
        );
        if (current?.exists) await renameTable(tx, schema, live, previous);
        await renameTable(tx, schema, staging, live);
        await afterSwap?.(tx);
        await tx.unsafe(
          `DROP TABLE "${schema}".${PUBLICATION_FENCE}; ${buildPublicationFenceDDL(schema)}`,
        );
      }),
    ),
  );
  await retainDataPublication();
  await dropRetired(
    sql,
    `DROP TABLE IF EXISTS "${schema}"."${previous}"`,
    `${schema}.${previous}`,
    lockTimeoutMs,
    retry,
  );
}
