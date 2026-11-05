import { jobs } from "@openmapx/db-schema";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";

/** Terminal status stamped on jobs orphaned in `running` by a process death. */
export const INTERRUPTED_STATUS = "interrupted";

/**
 * Minimal drizzle-like surface that {@link reconcileOrphanedJobs} exercises.
 * Structural alias so tests can pass a hand-rolled stub without dragging the
 * full Drizzle types through. Production callers omit `db` and get the
 * package-wide singleton.
 */
export type JobReconcileWriter = {
  update: (table: typeof jobs) => {
    set: (values: { status: string; finishedAt: Date | null }) => {
      where: (predicate: unknown) => {
        returning: (columns: { id: typeof jobs.id }) => PromiseLike<Array<{ id: string }>>;
      };
    };
  };
};

export interface ReconcileOrphanedJobsOptions {
  /** Drizzle handle; defaults to the package-wide singleton. */
  db?: JobReconcileWriter;
  /** Test seam: override the wall clock. */
  now?: () => Date;
}

/** Startup marks legacy workers interrupted without asserting process/child
 * containment. New versioned executions and logical guards have their own
 * retained reconciler; unfinished legacy evidence continues to block writes. */
export async function reconcileOrphanedJobs(
  opts: ReconcileOrphanedJobsOptions = {},
): Promise<string[]> {
  const predicate = and(
    eq(jobs.status, "running"),
    isNull(jobs.executionVersion),
    ne(jobs.kind, "configuration-maintenance"),
  );
  const updated = opts.db
    ? await opts.db
        .update(jobs)
        .set({ status: INTERRUPTED_STATUS, finishedAt: null })
        .where(predicate)
        .returning({ id: jobs.id })
    : await defaultDb
        .update(jobs)
        .set({ status: INTERRUPTED_STATUS, finishedAt: null })
        .where(predicate)
        .returning({ id: jobs.id });
  return updated.map((row) => row.id);
}
