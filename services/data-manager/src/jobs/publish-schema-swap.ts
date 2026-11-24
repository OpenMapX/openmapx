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

/**
 * Publishing rebuilt data must never make the API's readers wait. A reader,
 * such as a backup, can hold the live tables for hours, and every statement
 * that asks for a lock behind it queues the readers that come after it. So a
 * publication only renames: renaming a schema takes no table lock, so the
 * swap commits at once and every later query resolves the live name to the
 * new tables. The old tables are dropped afterwards, once their last reader
 * has finished; until then they sit under a name no reader uses. Each step
 * waits at most `lockTimeoutMs` for a lock, so it can never queue readers for
 * longer than that, and is retried with growing pauses.
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

function isLockTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === LOCK_NOT_AVAILABLE
  );
}

function backoff(retry: LockRetry, attempt: number): number {
  return Math.min(retry.backoffMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/**
 * Runs `work` until it does not time out waiting for a lock, at most
 * `retry.attempts` times. The last error is rethrown unchanged, so a
 * transaction that rolled back stays recognisable as one.
 */
async function retryOnLockTimeout<T>(retry: LockRetry, work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isLockTimeout(error) || attempt >= retry.attempts) throw error;
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

/** Drops what a publication retired; returns false when its readers outlasted every attempt. */
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
    if (!isLockTimeout(error)) throw error;
    jobChildLogger({ publication: what }).warn(
      `${what} is still being read; it stays until the next publication drops it`,
    );
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
  if (tables.length === 0) return;
  await sql.unsafe(`ANALYZE ${tables.map(({ name }) => `"${schema}"."${name}"`).join(", ")}`);
}

/**
 * Replaces the live schema with a fully built staging schema. The staging
 * schema's indexes must already exist; its tables are analyzed here. One
 * transaction renames live to `<live>__previous` and staging to live; a
 * second, after the publication is recorded, drops `<live>__previous`. When
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
        const [current] = await tx.unsafe<{ exists: boolean }[]>(
          `SELECT to_regnamespace($1) IS NOT NULL AS exists`,
          [live],
        );
        if (current?.exists) await tx.unsafe(`ALTER SCHEMA "${live}" RENAME TO "${previous}"`);
        await tx.unsafe(`ALTER SCHEMA "${staging}" RENAME TO "${live}"`);
        await carryOver?.(tx, current?.exists ? previous : null);
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
 * so that its successor can take their names.
 */
async function renameTable(
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
  await tx.unsafe(`ALTER TABLE "${schema}"."${from}" RENAME TO "${to}"`);
  // Renaming an index also renames the constraint it backs.
  for (const { name } of indexes) {
    const renamed = renamedObject(name, from, to);
    if (renamed) await tx.unsafe(`ALTER INDEX "${schema}"."${name}" RENAME TO "${renamed}"`);
  }
  for (const { name } of constraints) {
    const renamed = renamedObject(name, from, to);
    if (renamed)
      await tx.unsafe(
        `ALTER TABLE "${schema}"."${to}" RENAME CONSTRAINT "${name}" TO "${renamed}"`,
      );
  }
}

/**
 * Replaces one live table with a fully built staging table in the same
 * schema, as `publishSchemaSwap` does for a schema. Renaming a table takes
 * its lock, so the swap waits for readers at most `lockTimeoutMs` per
 * attempt. Indexes and constraints named after a table move with its name.
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
        const [current] = await tx.unsafe<{ exists: boolean }[]>(
          `SELECT to_regclass($1) IS NOT NULL AS exists`,
          [`"${schema}"."${live}"`],
        );
        if (current?.exists) await renameTable(tx, schema, live, previous);
        await renameTable(tx, schema, staging, live);
        await afterSwap?.(tx);
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
