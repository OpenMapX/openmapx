import { sql } from "../../db/index.js";
import { withDataSqlSettlement } from "../execution/worker-scope.js";

// Stable, application-owned two-key advisory lock. Every operation that can
// replace the Overture schema or its OSM snapshot uses the same lock.
export const OVERTURE_LOCK_NAMESPACE = 1_330_466_120;
export const OVERTURE_LOCK_KEY = 1;

/** Serializes Overture schema/extract/conflation mutations across processes. */
export async function withOvertureOperationLock<T>(operation: () => Promise<T>): Promise<T> {
  const connection = await sql.reserve();
  try {
    await connection.unsafe(
      `SELECT pg_advisory_lock(${OVERTURE_LOCK_NAMESPACE}, ${OVERTURE_LOCK_KEY})`,
    );
    return await operation();
  } finally {
    try {
      await withDataSqlSettlement(() =>
        connection.unsafe(
          `SELECT pg_advisory_unlock(${OVERTURE_LOCK_NAMESPACE}, ${OVERTURE_LOCK_KEY})`,
        ),
      );
    } finally {
      connection.release();
    }
  }
}

/** Read the existing two-key lease without acquiring it or creating a worker. */
export async function overtureOperationBusy(): Promise<boolean> {
  const [row] = await sql.unsafe<{ busy: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
       AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
       AND classid::bigint=$1::bigint AND objid::bigint=$2::bigint AND objsubid=2 AND granted) AS busy`,
    [OVERTURE_LOCK_NAMESPACE, OVERTURE_LOCK_KEY],
  );
  return row?.busy === true;
}
