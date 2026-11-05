import { jobs } from "@openmapx/db-schema";
import { and, desc, eq, gt } from "drizzle-orm";
import type postgres from "postgres";
import z from "zod/v4";
import type { db as defaultDb } from "../../db/index.js";
import { assertDataMutationAdmission } from "../execution/admission.js";
import { withDataAdmissionTransaction } from "../execution/store.js";

/**
 * Single-flight controller for the Transitous sync pipeline. Prevents two
 * concurrent runs from racing on the shared catalog dir / staging MOTIS
 * container, and rejects API replays of the same idempotency key inside a
 * 24h window so a flaky client retry doesn't kick off a duplicate 4h job.
 *
 * The in-memory `inflight` flag is process-local — the data-manager runs as
 * a single instance, so this is sufficient. If we ever scale horizontally
 * this needs to move to a Postgres advisory lock.
 *
 * The latch is taken synchronously before any `await`, so two concurrent
 * callers in the same tick cannot both pass the guard and both start a sync.
 */

export type SyncTrigger = "cron" | "manual" | "api";

export interface TryStartSyncOptions {
  trigger: SyncTrigger;
  triggeredBy: string;
  idempotencyKey?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

export type TryStartSyncResult =
  | { ok: true; jobId: string }
  // `existingJobId` is `null` when another call is mid-start and its job
  // row has not been created yet.
  | { ok: false; reason: "in-flight"; existingJobId: string | null }
  | { ok: false; reason: "duplicate-idempotency-key"; existingJobId: string };

export interface SingleFlightDeps {
  /** Drizzle DB handle. Tests inject a stub. */
  db: typeof defaultDb;
  /** `Date.now()` indirection so tests can advance the clock deterministically. */
  now?: () => number;
  admissionSql?: postgres.Sql;
}

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SingleFlightController {
  tryStartSync(opts: TryStartSyncOptions): Promise<TryStartSyncResult>;
  reserveOwned(jobId: string): boolean;
  markSyncFinished(jobId?: string): void;
  getInflight(): { jobId: string; startedAt: Date } | null;
}

/**
 * Build a controller. Exported as a factory (rather than a module-level
 * singleton) so tests can spin up isolated controllers with stubbed DBs.
 * The production entrypoint constructs one shared controller and re-exports
 * its bound methods.
 */
export function createSingleFlightController(deps: SingleFlightDeps): SingleFlightController {
  const db = deps.db;
  const now = deps.now ?? Date.now;
  let inflight: { jobId: string; startedAt: Date } | null = null;
  let starting = false;

  async function tryStartSync(opts: TryStartSyncOptions): Promise<TryStartSyncResult> {
    if (inflight) {
      return { ok: false, reason: "in-flight", existingJobId: inflight.jobId };
    }
    if (starting) {
      return { ok: false, reason: "in-flight", existingJobId: null };
    }

    starting = true;
    try {
      const reserve = async (
        db: Pick<typeof defaultDb, "select" | "insert">,
      ): Promise<TryStartSyncResult> => {
        if (opts.idempotencyKey) {
          const cutoff = new Date(now() - IDEMPOTENCY_WINDOW_MS);
          const existing = await db
            .select({ id: jobs.id })
            .from(jobs)
            .where(and(eq(jobs.idempotencyKey, opts.idempotencyKey), gt(jobs.startedAt, cutoff)))
            .orderBy(desc(jobs.startedAt))
            .limit(1);
          const row = existing[0];
          if (row) {
            return { ok: false, reason: "duplicate-idempotency-key", existingJobId: row.id };
          }
        }

        const inserted = await db
          .insert(jobs)
          .values({
            kind: opts.kind ?? "transitous-sync",
            status: "running",
            triggeredBy: `${opts.trigger}:${opts.triggeredBy}`,
            idempotencyKey: opts.idempotencyKey ?? null,
            metadata: opts.metadata ?? null,
          })
          .returning({ id: jobs.id });

        const row = inserted[0];
        if (!row) throw new Error("Failed to create data_manager.jobs row");

        inflight = { jobId: row.id, startedAt: new Date(now()) };
        return { ok: true, jobId: row.id };
      };
      if (!deps.admissionSql) return await reserve(db);
      return await withDataAdmissionTransaction(
        deps.admissionSql,
        async (tx): Promise<TryStartSyncResult> => {
          await assertDataMutationAdmission(tx);
          if (opts.idempotencyKey) {
            const existing = await tx<
              { id: string }[]
            >`SELECT id FROM data_manager.jobs WHERE idempotency_key=${opts.idempotencyKey} AND started_at>${new Date(now() - IDEMPOTENCY_WINDOW_MS).toISOString()}::text::timestamptz ORDER BY started_at DESC LIMIT 1`;
            if (existing[0])
              return {
                ok: false,
                reason: "duplicate-idempotency-key",
                existingJobId: existing[0].id,
              };
          }
          const inserted = await tx<
            { id: string }[]
          >`INSERT INTO data_manager.jobs(kind,status,triggered_by,idempotency_key,metadata) VALUES(${opts.kind ?? "transitous-sync"},'running',${`${opts.trigger}:${opts.triggeredBy}`},${opts.idempotencyKey ?? null},${opts.metadata ? JSON.stringify(z.json().parse(opts.metadata)) : null}::text::jsonb) RETURNING id`;
          const row = inserted[0];
          if (!row) throw Error("Transit reservation did not persist");
          inflight = { jobId: row.id, startedAt: new Date(now()) };
          return { ok: true, jobId: row.id };
        },
      );
    } finally {
      starting = false;
    }
  }

  function markSyncFinished(jobId?: string): void {
    if (jobId !== undefined && inflight?.jobId !== jobId) return;
    inflight = null;
  }

  function getInflight(): { jobId: string; startedAt: Date } | null {
    return inflight ? { ...inflight } : null;
  }

  return {
    tryStartSync,
    markSyncFinished,
    getInflight,
    reserveOwned(jobId) {
      if (inflight || starting) return false;
      inflight = { jobId, startedAt: new Date(now()) };
      return true;
    },
  };
}
