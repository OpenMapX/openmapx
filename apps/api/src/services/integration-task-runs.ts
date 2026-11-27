import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { integrationTaskRun } from "../db/schema";
import type { TaskRunStore } from "../integration-scheduler";

/**
 * The run history of scheduled tasks in `integration_task_run`, platform data
 * on the platform's connection. Each change away from `running` writes
 * `finished_at` in the same statement, as the table's check requires.
 */
export function createTaskRunStore(database: typeof db = db): TaskRunStore {
  return {
    async start(integrationId, taskName) {
      // The partial unique index admits one running row per task; a conflict
      // means another run of the task is still going.
      const [row] = await database
        .insert(integrationTaskRun)
        .values({ integrationId, taskName })
        .onConflictDoNothing()
        .returning({ id: integrationTaskRun.id });
      return row?.id ?? null;
    },
    async finish(runId, status, error) {
      await database
        .update(integrationTaskRun)
        .set({ status, finishedAt: sql`now()`, error: error ?? null })
        .where(and(eq(integrationTaskRun.id, runId), eq(integrationTaskRun.status, "running")));
    },
    async failInterrupted() {
      const rows = await database
        .update(integrationTaskRun)
        .set({ status: "failed", finishedAt: sql`now()`, error: "interrupted by restart" })
        .where(eq(integrationTaskRun.status, "running"))
        .returning({ id: integrationTaskRun.id });
      return rows.length;
    },
  };
}

/**
 * Deletes the finished runs started more than `days` ago. It filters on the
 * start time, the table's only indexed time, and keeps running rows.
 */
export async function pruneIntegrationTaskRuns(
  days = 30,
  database: typeof db = db,
): Promise<number> {
  const rows = await database.execute<{ id: string }>(
    sql`DELETE FROM integration_task_run WHERE started_at < now() - make_interval(days => ${days}::integer) AND status <> 'running' RETURNING id`,
  );
  return rows.length;
}
