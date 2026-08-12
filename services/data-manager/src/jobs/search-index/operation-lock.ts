import type postgres from "postgres";

const SEARCH_INDEX_LOCK_NAMESPACE = 1_330_466_120;
const SEARCH_INDEX_LOCK_KEY = 2;

export interface SearchIndexOperationLock {
  readonly inFlight: boolean;
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createSearchIndexOperationLock(sql: postgres.Sql): SearchIndexOperationLock {
  let inFlight = false;
  return {
    get inFlight() {
      return inFlight;
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (inFlight) throw new Error("an OSM search-index build is already running");
      inFlight = true;
      let connection: Awaited<ReturnType<typeof sql.reserve>> | undefined;
      try {
        connection = await sql.reserve();
        await connection.unsafe(
          `SELECT pg_advisory_lock(${SEARCH_INDEX_LOCK_NAMESPACE}, ${SEARCH_INDEX_LOCK_KEY})`,
        );
        return await operation();
      } finally {
        if (connection) {
          try {
            await connection.unsafe(
              `SELECT pg_advisory_unlock(${SEARCH_INDEX_LOCK_NAMESPACE}, ${SEARCH_INDEX_LOCK_KEY})`,
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
