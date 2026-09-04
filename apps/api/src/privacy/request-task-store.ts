import { and, eq, lt, lte, or, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import { dataSubjectRequestTask } from "../db/schema.js";
import type { RunnerTask, RunnerTaskStore } from "./request-runner.js";

/**
 * Small CAS-backed task store used by the privacy runner.  It deliberately
 * does not share the general admin-job queue: task state, attempts and retry
 * deadlines are part of the statutory case record.
 */
export function createPrivacyRequestTaskStore(
  database: typeof defaultDb = defaultDb,
  options: { staleAfterMs?: number; now?: () => Date } = {},
): RunnerTaskStore {
  const staleAfterMs = options.staleAfterMs ?? 15 * 60_000;
  const now = options.now ?? (() => new Date());

  return {
    async claimDueTask(at: Date): Promise<RunnerTask | null> {
      const candidates = await database
        .select({
          id: dataSubjectRequestTask.id,
          requestId: dataSubjectRequestTask.requestId,
          status: dataSubjectRequestTask.status,
          attempts: dataSubjectRequestTask.attempts,
          nextAttemptAt: dataSubjectRequestTask.nextAttemptAt,
        })
        .from(dataSubjectRequestTask)
        // Only automated collector tasks are eligible for this worker.  An
        // operator task is a legal review gate and must never be converted to
        // an automatic "operator_review" decision by retry exhaustion.
        .where(
          and(
            sql`${dataSubjectRequestTask.collectorId} is not null`,
            or(
              eq(dataSubjectRequestTask.status, "pending"),
              eq(dataSubjectRequestTask.status, "retryable"),
            ),
            or(
              sql`${dataSubjectRequestTask.nextAttemptAt} is null`,
              lte(dataSubjectRequestTask.nextAttemptAt, at),
            ),
          ),
        )
        .orderBy(dataSubjectRequestTask.nextAttemptAt, dataSubjectRequestTask.createdAt)
        .limit(32);
      for (const candidate of candidates) {
        const rows = await database
          .update(dataSubjectRequestTask)
          .set({
            status: "running",
            attempts: sql`${dataSubjectRequestTask.attempts} + 1`,
            updatedAt: at,
          })
          .where(
            and(
              eq(dataSubjectRequestTask.id, candidate.id),
              or(
                eq(dataSubjectRequestTask.status, "pending"),
                eq(dataSubjectRequestTask.status, "retryable"),
              ),
              or(
                sql`${dataSubjectRequestTask.nextAttemptAt} is null`,
                lte(dataSubjectRequestTask.nextAttemptAt, at),
              ),
            ),
          )
          .returning({
            id: dataSubjectRequestTask.id,
            requestId: dataSubjectRequestTask.requestId,
            status: dataSubjectRequestTask.status,
            attempts: dataSubjectRequestTask.attempts,
            nextAttemptAt: dataSubjectRequestTask.nextAttemptAt,
          });
        if (rows[0]) return rows[0] as RunnerTask;
      }
      return null;
    },

    async completeTask(taskId: string): Promise<void> {
      await database
        .update(dataSubjectRequestTask)
        .set({ status: "complete", collectedAt: now(), updatedAt: now() })
        .where(
          and(eq(dataSubjectRequestTask.id, taskId), eq(dataSubjectRequestTask.status, "running")),
        );
    },

    async retryTask(taskId: string, nextAttemptAt: Date, errorCode: string): Promise<void> {
      await database
        .update(dataSubjectRequestTask)
        .set({ status: "retryable", nextAttemptAt, exceptionCode: errorCode, updatedAt: now() })
        .where(
          and(eq(dataSubjectRequestTask.id, taskId), eq(dataSubjectRequestTask.status, "running")),
        );
    },

    async deferTask(taskId: string, nextAttemptAt: Date, reasonCode: string): Promise<void> {
      await database
        .update(dataSubjectRequestTask)
        .set({
          status: "retryable",
          attempts: sql`greatest(0, ${dataSubjectRequestTask.attempts} - 1)`,
          nextAttemptAt,
          exceptionCode: reasonCode,
          updatedAt: now(),
        })
        .where(
          and(eq(dataSubjectRequestTask.id, taskId), eq(dataSubjectRequestTask.status, "running")),
        );
    },

    async operatorReview(taskId: string, errorCode: string): Promise<void> {
      await database
        .update(dataSubjectRequestTask)
        .set({
          status: "operator_review",
          nextAttemptAt: null,
          exceptionCode: errorCode,
          updatedAt: now(),
        })
        .where(
          and(eq(dataSubjectRequestTask.id, taskId), eq(dataSubjectRequestTask.status, "running")),
        );
    },

    async recoverInterrupted(): Promise<void> {
      const cutoff = new Date(now().getTime() - staleAfterMs);
      await database
        .update(dataSubjectRequestTask)
        .set({
          status: "retryable",
          nextAttemptAt: now(),
          exceptionCode: "runner-recovered",
          updatedAt: now(),
        })
        .where(
          and(
            eq(dataSubjectRequestTask.status, "running"),
            lt(dataSubjectRequestTask.updatedAt, cutoff),
          ),
        );
    },
  };
}
