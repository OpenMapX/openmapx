import type postgres from "postgres";

const SEARCH_INDEX_LOCK_NAMESPACE = 1_330_466_120;
const SEARCH_INDEX_LOCK_KEY = 2;
const NOTABLE_PLACES_LOCK_KEY = 3;

export interface SearchIndexOperationLock {
  readonly inFlight: boolean;
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * One build at a time per index, across processes: a Postgres advisory lock
 * held on a reserved connection, plus an in-process flag that refuses a second
 * build at once rather than queueing it behind the first.
 */
function createAdvisoryOperationLock(
  sql: postgres.Sql,
  key: number,
  busyMessage: string,
): SearchIndexOperationLock {
  let inFlight = false;
  return {
    get inFlight() {
      return inFlight;
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (inFlight) throw new Error(busyMessage);
      inFlight = true;
      let connection: Awaited<ReturnType<typeof sql.reserve>> | undefined;
      try {
        connection = await sql.reserve();
        await connection.unsafe(`SELECT pg_advisory_lock(${SEARCH_INDEX_LOCK_NAMESPACE}, ${key})`);
        return await operation();
      } finally {
        if (connection) {
          try {
            await connection.unsafe(
              `SELECT pg_advisory_unlock(${SEARCH_INDEX_LOCK_NAMESPACE}, ${key})`,
            );
          } finally {
            connection.release();
          }
        }
        inFlight = false;
      }
    },
  };
}

export function createSearchIndexOperationLock(sql: postgres.Sql): SearchIndexOperationLock {
  return createAdvisoryOperationLock(
    sql,
    SEARCH_INDEX_LOCK_KEY,
    "an OSM search-index build is already running",
  );
}

export function createNotablePlacesOperationLock(sql: postgres.Sql): SearchIndexOperationLock {
  return createAdvisoryOperationLock(
    sql,
    NOTABLE_PLACES_LOCK_KEY,
    "a notable-places build is already running",
  );
}
