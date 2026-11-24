import { DATA_ADVISORY_LOCKS } from "@openmapx/core/data-manager-sdk";
import type postgres from "postgres";
import { jobChildLogger } from "../../logger.js";
import {
  isLockTimeout,
  type LockRetry,
  PUBLICATION_LOCK_RETRY,
  PUBLICATION_LOCK_TIMEOUT_MS,
  renameTable,
  retryOnLockTimeout,
} from "../publish-schema-swap.js";

/**
 * Each generation's features live in one partition of `ambient_places.features`.
 * A build creates it as a standalone table and fills it; publication attaches
 * it, which takes SHARE UPDATE EXCLUSIVE on the parent and so never waits for
 * readers of the parent. A planet build fills its table across many
 * transactions, so the table is staged as `candidate_<hex>` and takes its
 * partition name `features_<hex>` only in the attaching transaction. Backups
 * leave out every `candidate_*` table by that name, so none reads one and the
 * attach does not wait for a backup. A regional build creates and attaches its
 * partition in one transaction, under the partition name from the start.
 * Retiring a generation deletes its row first, which stops every read of it,
 * then detaches the partition concurrently and drops it. Neither step queues
 * readers behind it, and each waits for a lock at most `lockTimeoutMs` per
 * attempt.
 */

export interface FeatureStorageLocking {
  lockTimeoutMs?: number;
  retry?: LockRetry;
}

/** A generation's table before publication: its partition, or a planet candidate. */
export type FeatureStorage = "partition" | "candidate";

/**
 * Dropping retired partitions after a publication committed is only tidying:
 * the next publication tries again. So it waits for a long reader, such as a
 * backup, for a few seconds at most instead of holding the job open.
 */
export const RETIRED_STORAGE_CLEANUP_RETRY: LockRetry = { attempts: 3, backoffMs: 500 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTITION = /^features_[0-9a-f]{32}$/;

/** Identifiers derive only from a validated UUID, never an operator-supplied path. */
function storageName(generation: string, storage: FeatureStorage = "partition"): string {
  if (!UUID.test(generation)) throw new Error("Invalid ambient generation");
  const prefix = storage === "candidate" ? "candidate" : "features";
  return `${prefix}_${generation.replaceAll("-", "").toLowerCase()}`;
}

/** The schema-qualified table that holds one generation's features. */
export function featureTable(generation: string, storage: FeatureStorage = "partition"): string {
  return `ambient_places.${storageName(generation, storage)}`;
}

function lockTimeout(locking: FeatureStorageLocking): string {
  const ms = locking.lockTimeoutMs ?? PUBLICATION_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`Invalid lock timeout ${ms}`);
  return `${ms}ms`;
}

/**
 * Creates the generation's unattached table. Its CHECK lets the later attach
 * skip the validation scan. Indexes are maintained while it is filled; their
 * names and the constraints' follow the table's name.
 */
export async function createFeatureStorage(
  tx: postgres.TransactionSql,
  generation: string,
  storage: FeatureStorage = "partition",
): Promise<void> {
  const name = storageName(generation, storage);
  await tx.unsafe(`CREATE TABLE ambient_places.${name} (LIKE ambient_places.features INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);
    ALTER TABLE ambient_places.${name} ADD CONSTRAINT ${name}_generation_check CHECK(generation='${generation}'::UUID)`);
}

export interface AttachFeatureStorageOptions extends FeatureStorageLocking {
  /** The table to attach; a candidate first takes the partition's name. */
  from?: FeatureStorage;
}

/**
 * Attaches the generation's partition inside the publication's transaction.
 * Renaming a candidate, its indexes and its constraints locks only that new
 * table, which nothing but its build reads.
 */
export async function attachFeatureStorage(
  tx: postgres.TransactionSql,
  generation: string,
  options: AttachFeatureStorageOptions = {},
): Promise<void> {
  const name = storageName(generation);
  const timeout = lockTimeout(options);
  await retryOnLockTimeout(options.retry ?? PUBLICATION_LOCK_RETRY, () =>
    tx.savepoint(async (savepoint) => {
      const [setting] = await savepoint.unsafe<{ previous: string }[]>(
        `SELECT current_setting('lock_timeout') AS previous`,
      );
      await savepoint.unsafe(`SELECT set_config('lock_timeout',$1,true)`, [timeout]);
      if (options.from === "candidate")
        await renameTable(savepoint, "ambient_places", storageName(generation, "candidate"), name);
      await savepoint.unsafe(
        `ALTER TABLE ambient_places.features ATTACH PARTITION ambient_places.${name} FOR VALUES IN ('${generation}')`,
      );
      await savepoint.unsafe(`SELECT set_config('lock_timeout',$1,true)`, [
        setting?.previous ?? "0",
      ]);
    }),
  );
}

/**
 * Unpublishes expired generations that no pointer references. Their rows go
 * in the caller's transaction; `dropRetiredFeatureStorage` removes their
 * partitions after it commits.
 */
export async function retireAmbientGenerations(tx: postgres.TransactionSql): Promise<void> {
  await tx.unsafe(
    `DELETE FROM ambient_places.generations WHERE id IN (SELECT g.id FROM ambient_places.generations g WHERE g.publication_status='published' AND g.cache_lease_until<clock_timestamp() AND NOT EXISTS(SELECT 1 FROM ambient_places.state s WHERE g.id=s.active OR g.id=s.previous) ORDER BY g.published_at LIMIT 8)`,
  );
}

async function attachment(
  connection: postgres.ReservedSql,
  name: string,
): Promise<{ pending: boolean } | undefined> {
  const [attached] = await connection.unsafe<{ pending: boolean }[]>(
    `SELECT inhdetachpending AS pending FROM pg_inherits WHERE inhrelid=to_regclass($1)`,
    [`ambient_places.${name}`],
  );
  return attached;
}

async function detach(connection: postgres.ReservedSql, name: string): Promise<void> {
  const attached = await attachment(connection, name);
  if (!attached) return;
  try {
    // A detach that timed out waiting for older readers stays pending until finalized.
    await connection.unsafe(
      `ALTER TABLE ambient_places.features DETACH PARTITION ambient_places.${name} ${attached.pending ? "FINALIZE" : "CONCURRENTLY"}`,
    );
  } catch (error) {
    // Another cleanup, such as one from an earlier version of this process,
    // may have completed the detach or dropped the table in the meantime.
    if (isLockTimeout(error) || (await attachment(connection, name))) throw error;
  }
}

/**
 * Drops the partitions of generations that no longer have a row: retired
 * ones, and those a failed earlier attempt left behind. It runs outside any
 * transaction, as a concurrent detach requires, and waits for readers only
 * within `retry` (by default a few seconds). Returns false when a reader
 * outlasted the retries or another error stopped it; the next publication
 * tries again, so no error here fails the publication. A cleanup that finds
 * another one running leaves the work to it.
 */
export async function dropRetiredFeatureStorage(
  sql: postgres.Sql,
  locking: FeatureStorageLocking = {},
): Promise<boolean> {
  const timeout = lockTimeout(locking);
  const retry = locking.retry ?? RETIRED_STORAGE_CLEANUP_RETRY;
  const [namespace, key] = DATA_ADVISORY_LOCKS.ambientPartitionCleanup;
  let connection: postgres.ReservedSql | undefined;
  let locked = false;
  try {
    connection = await sql.reserve();
    const reserved = connection;
    const [claim] = await reserved.unsafe<{ locked: boolean }[]>(
      `SELECT pg_try_advisory_lock($1,$2) AS locked`,
      [namespace, key],
    );
    locked = claim?.locked === true;
    if (!locked) return true;
    await reserved.unsafe(`SET lock_timeout='${timeout}'`);
    const orphans = await reserved.unsafe<{ name: string }[]>(
      `SELECT c.relname AS name FROM pg_class c LEFT JOIN pg_inherits i ON i.inhrelid=c.oid
        WHERE c.relnamespace=to_regnamespace('ambient_places') AND c.relkind='r' AND c.relname ~ '^features_[0-9a-f]{32}$'
          AND NOT EXISTS(SELECT 1 FROM ambient_places.generations g WHERE c.relname='features_'||replace(g.id::TEXT,'-',''))
        ORDER BY coalesce(i.inhdetachpending,false) DESC,c.relname`,
    );
    for (const { name } of orphans) {
      if (!PARTITION.test(name)) throw new Error(`Unexpected ambient partition "${name}"`);
      await retryOnLockTimeout(retry, () => detach(reserved, name));
      await retryOnLockTimeout(retry, () =>
        reserved.unsafe(`DROP TABLE IF EXISTS ambient_places.${name}`),
      );
    }
    return true;
  } catch (error) {
    const logger = jobChildLogger({ publication: "ambient_places" });
    if (isLockTimeout(error)) {
      logger.warn("A retired ambient partition is still being read; the next publication drops it");
    } else {
      const code = (error as { code?: unknown })?.code;
      logger.error(
        { code: typeof code === "string" ? code : undefined, err: (error as Error)?.message },
        "Dropping a retired ambient partition failed; the next publication drops it",
      );
    }
    return false;
  } finally {
    if (connection) {
      await connection.unsafe(`RESET lock_timeout`).catch(() => undefined);
      if (locked)
        await connection
          .unsafe(`SELECT pg_advisory_unlock($1,$2)`, [namespace, key])
          .catch(() => undefined);
      connection.release();
    }
  }
}
