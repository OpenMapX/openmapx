import { jobs } from "@openmapx/db-schema";
import { eq } from "drizzle-orm";
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
    set: (values: { status: string; finishedAt: Date }) => {
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

/**
 * Mark every job still in `running` as `interrupted`, returning the ids it
 * reconciled.
 *
 * The data-manager is a single instance whose "a sync is running" signal lives
 * only in process memory (the single-flight `inflight` flag). So any `running`
 * row found at startup is a zombie left by a previous process that died mid-run
 * — a restart / redeploy / OOM during a multi-hour Transitous sync (graceful
 * shutdown only waits 30s before forcing exit). Without this sweep those rows
 * stay `running` forever: the admin "Sync in progress" banner shows a phantom
 * job indefinitely and `lastSyncStatus` reads null.
 *
 * MUST run only at startup, before any new job is created. At that point nothing
 * is genuinely running, so a blanket sweep across every job kind
 * (`transitous-sync` and `poi-ingest:*`, which share the table) is safe.
 */
export async function reconcileOrphanedJobs(
  opts: ReconcileOrphanedJobsOptions = {},
): Promise<string[]> {
  const handle: JobReconcileWriter = opts.db ?? (defaultDb as unknown as JobReconcileWriter);
  const finishedAt = opts.now ? opts.now() : new Date();
  const updated = await handle
    .update(jobs)
    .set({ status: INTERRUPTED_STATUS, finishedAt })
    .where(eq(jobs.status, "running"))
    .returning({ id: jobs.id });
  return updated.map((row) => row.id);
}
