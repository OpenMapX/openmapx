import type postgres from "postgres";
import { jobChildLogger } from "../../logger.js";
import {
  isLockTimeout,
  type LockRetry,
  PUBLICATION_LOCK_RETRY,
  PUBLICATION_LOCK_TIMEOUT_MS,
  retryOnLockTimeout,
} from "../publish-schema-swap.js";

/**
 * Each generation's features live in one partition of `ambient_places.features`.
 * A build creates it as a standalone table and fills it; publication attaches
 * it, which takes SHARE UPDATE EXCLUSIVE on the parent and so never waits for
 * readers. Retiring a generation deletes its row first, which stops every
 * read of it, then detaches the partition concurrently and drops it. Neither
 * step queues readers behind it, and each waits for a lock at most
 * `lockTimeoutMs` per attempt.
 */

export interface FeatureStorageLocking {
  lockTimeoutMs?: number;
  retry?: LockRetry;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTITION = /^features_[0-9a-f]{32}$/;

/** Identifiers derive only from a validated UUID, never an operator-supplied path. */
function partitionName(generation: string): string {
  if (!UUID.test(generation)) throw new Error("Invalid ambient generation");
  return `features_${generation.replaceAll("-", "").toLowerCase()}`;
}

/** The schema-qualified table that holds one generation's features. */
export function featureTable(generation: string): string {
  return `ambient_places.${partitionName(generation)}`;
}

function lockTimeout(locking: FeatureStorageLocking): string {
  const ms = locking.lockTimeoutMs ?? PUBLICATION_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`Invalid lock timeout ${ms}`);
  return `${ms}ms`;
}

/**
 * Creates the generation's unattached partition. Its CHECK lets the later
 * attach skip the validation scan. Indexes are maintained while it is filled.
 */
export async function createFeatureStorage(
  tx: postgres.TransactionSql,
  generation: string,
): Promise<void> {
  const name = partitionName(generation);
  await tx.unsafe(`CREATE TABLE ambient_places.${name} (LIKE ambient_places.features INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);
    ALTER TABLE ambient_places.${name} ADD CONSTRAINT ${name}_generation_check CHECK(generation='${generation}'::UUID)`);
}

/** Attaches the generation's partition inside the publication's transaction. */
export async function attachFeatureStorage(
  tx: postgres.TransactionSql,
  generation: string,
  locking: FeatureStorageLocking = {},
): Promise<void> {
  const name = partitionName(generation);
  const timeout = lockTimeout(locking);
  await retryOnLockTimeout(locking.retry ?? PUBLICATION_LOCK_RETRY, () =>
    tx.savepoint(async (savepoint) => {
      const [setting] = await savepoint.unsafe<{ previous: string }[]>(
        `SELECT current_setting('lock_timeout') AS previous`,
      );
      await savepoint.unsafe(`SELECT set_config('lock_timeout',$1,true)`, [timeout]);
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

async function detach(connection: postgres.ReservedSql, name: string): Promise<void> {
  const [attached] = await connection.unsafe<{ pending: boolean }[]>(
    `SELECT inhdetachpending AS pending FROM pg_inherits WHERE inhrelid=to_regclass($1)`,
    [`ambient_places.${name}`],
  );
  if (!attached) return;
  // A detach that timed out waiting for older readers stays pending until finalized.
  await connection.unsafe(
    `ALTER TABLE ambient_places.features DETACH PARTITION ambient_places.${name} ${attached.pending ? "FINALIZE" : "CONCURRENTLY"}`,
  );
}

/**
 * Drops the partitions of generations that no longer have a row: retired
 * ones, and those a failed earlier attempt left behind. It runs outside any
 * transaction, as a concurrent detach requires. Returns false when a reader
 * outlasted the retries or another error stopped it; the next publication
 * tries again, so no error here fails the publication.
 */
export async function dropRetiredFeatureStorage(
  sql: postgres.Sql,
  locking: FeatureStorageLocking = {},
): Promise<boolean> {
  const timeout = lockTimeout(locking);
  const retry = locking.retry ?? PUBLICATION_LOCK_RETRY;
  let connection: postgres.ReservedSql | undefined;
  try {
    connection = await sql.reserve();
    const reserved = connection;
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
      await retryOnLockTimeout(retry, () => reserved.unsafe(`DROP TABLE ambient_places.${name}`));
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
      connection.release();
    }
  }
}
