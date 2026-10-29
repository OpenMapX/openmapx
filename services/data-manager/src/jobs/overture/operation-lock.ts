import { sql } from "../../db/index.js";

// Stable, application-owned two-key advisory lock. Every operation that can
// replace the Overture schema or its OSM snapshot uses the same lock.
export const OVERTURE_LOCK_NAMESPACE = 1_330_466_120;
export const OVERTURE_LOCK_KEY = 1;

const LOCK_RETRY_MS = 250;

type ReservedConnection = Awaited<ReturnType<typeof sql.reserve>>;

// Callers in this process take turns before reserving anything. A caller that
// blocked inside PostgreSQL on a reserved connection would keep a slot of the
// small shared pool, and enough of them leave the lock owner no connection to
// finish with. The tail only ever resolves, so a failed caller cannot poison it.
let queueTail: Promise<void> = Promise.resolve();

async function tryAcquire(connection: ReservedConnection): Promise<boolean> {
  const rows = await connection.unsafe<{ locked: unknown }[]>(
    `SELECT pg_try_advisory_lock(${OVERTURE_LOCK_NAMESPACE}, ${OVERTURE_LOCK_KEY}) AS locked`,
  );
  const locked = rows[0]?.locked;
  if (typeof locked !== "boolean") {
    throw new Error("Overture advisory lock attempt returned no boolean result");
  }
  return locked;
}

// Another process may hold the lock. Each unsuccessful attempt gives its
// connection back before the delay, so waiting never occupies a pool slot.
async function acquireSession(): Promise<ReservedConnection> {
  for (;;) {
    const connection = await sql.reserve();
    let locked: boolean;
    try {
      locked = await tryAcquire(connection);
    } catch (error) {
      connection.release();
      throw error;
    }
    if (locked) return connection;
    connection.release();
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

/**
 * Serializes Overture schema/extract/conflation mutations across processes.
 * Callers in this process run in arrival order; across processes the lock is
 * polled, so there is no ordering guarantee between them.
 */
export async function withOvertureOperationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = queueTail;
  let admitNext!: () => void;
  queueTail = new Promise<void>((resolve) => {
    admitNext = resolve;
  });
  await previous;
  try {
    const connection = await acquireSession();
    try {
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
  } finally {
    admitNext();
  }
}
