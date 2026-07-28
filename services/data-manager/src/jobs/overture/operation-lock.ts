import { sql } from "../../db/index.js";

// Stable, application-owned two-key advisory lock. Every operation that can
// replace the Overture schema or its OSM snapshot uses the same lock.
const OVERTURE_LOCK_NAMESPACE = 1_330_466_120;
const OVERTURE_LOCK_KEY = 1;

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
      await connection.unsafe(
        `SELECT pg_advisory_unlock(${OVERTURE_LOCK_NAMESPACE}, ${OVERTURE_LOCK_KEY})`,
      );
    } finally {
      connection.release();
    }
  }
}
