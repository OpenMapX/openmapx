import { jobs } from "@openmapx/db-schema";
import { and, eq, isNull, ne } from "drizzle-orm";
import type postgres from "postgres";
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
}

/** Startup marks legacy workers interrupted without asserting process/child
 * containment. New versioned executions and logical guards have their own
 * retained reconciler. An interrupted legacy row keeps blocking writes until
 * {@link reconcileInterruptedLegacyJobs} observes that none of its recorded
 * host operations can still be running. */
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

/** What the ops agent says about one host operation a legacy job recorded.
 * `unknown` covers every case where the agent gave no usable answer. */
export type LegacyOperationObservation = "terminal" | "active" | "unknown";

export interface InterruptedLegacyJobOptions {
  database: postgres.Sql;
  /** Look up one recorded operation. It must never submit or cancel work. */
  observe: (
    operationKey: string,
    retained: Record<string, unknown>,
    context: { signal?: AbortSignal },
  ) => Promise<LegacyOperationObservation>;
  signal?: AbortSignal;
  /** Called when one job could not be examined or settled; the job is held. */
  onError?: (error: unknown, jobId?: string) => void;
}

export interface InterruptedLegacyJobResult {
  resolved: string[];
  held: string[];
}

type InterruptedLegacyRow = {
  id: string;
  ownership_version: number;
  operations: unknown;
};

async function operationsAreSettled(
  operations: unknown,
  options: InterruptedLegacyJobOptions,
): Promise<boolean> {
  if (!Array.isArray(operations)) return false;
  for (const entry of operations) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const retained = entry as Record<string, unknown>;
    if (retained.state === "terminal") continue;
    if (options.signal?.aborted || typeof retained.operationKey !== "string") return false;
    let observation: LegacyOperationObservation;
    try {
      observation = await options.observe(retained.operationKey, retained, {
        signal: options.signal,
      });
    } catch {
      return false;
    }
    if (observation !== "terminal") return false;
  }
  return true;
}

/**
 * Settles interrupted legacy data jobs that can no longer be doing anything.
 *
 * A row stays `interrupted`, and keeps blocking every durable data job, while
 * any operation it recorded may still be running or its state cannot be read.
 * It becomes `error` once it recorded no operation or every recorded one is
 * terminal. This only observes: it never submits or cancels an operation, and
 * an unreachable agent or a failed observation holds the row for the next pass.
 * A row whose catalog fetch was attempted stays held because no agent
 * operation can vouch for that local effect.
 */
export async function reconcileInterruptedLegacyJobs(
  options: InterruptedLegacyJobOptions,
): Promise<InterruptedLegacyJobResult> {
  const { database } = options;
  const rows = await database<InterruptedLegacyRow[]>`
    SELECT id,ownership_version,metadata->'retainedOps' AS operations
    FROM data_manager.jobs
    WHERE execution_version IS NULL AND finished_at IS NULL AND status='interrupted'
      AND kind <> 'configuration-maintenance'
      AND jsonb_typeof(metadata->'retainedOps')='array'
      AND coalesce(metadata->'catalogPreflight'->>'state','') <> 'git-fetch-attempted'
    ORDER BY started_at,id`;
  const resolved: string[] = [];
  const held: string[] = [];
  for (const row of rows) {
    if (options.signal?.aborted) {
      held.push(row.id);
      continue;
    }
    try {
      if (!(await operationsAreSettled(row.operations, options))) {
        held.push(row.id);
        continue;
      }
      const settled = await database`
        UPDATE data_manager.jobs
        SET status='error',finished_at=now(),ownership_version=ownership_version+1
        WHERE id=${row.id} AND execution_version IS NULL AND status='interrupted'
          AND finished_at IS NULL AND ownership_version=${row.ownership_version}
        RETURNING id`;
      (settled.length === 1 ? resolved : held).push(row.id);
    } catch (error) {
      held.push(row.id);
      options.onError?.(error, row.id);
    }
  }
  return { resolved, held };
}

export interface InterruptedLegacyJobReconciler {
  /** Runs one pass now, or joins the pass already running. */
  runOnce: () => Promise<void>;
  /** Stops scheduling, aborts observation and waits for a running pass. */
  stop: () => Promise<void>;
}

/** Runs {@link reconcileInterruptedLegacyJobs} immediately and then a fixed
 * delay after each pass finishes, so two passes can never overlap. */
export function startInterruptedLegacyJobReconciler(
  options: Omit<InterruptedLegacyJobOptions, "signal"> & {
    intervalMs?: number;
    onResult?: (result: InterruptedLegacyJobResult) => void;
  },
): InterruptedLegacyJobReconciler {
  const intervalMs = options.intervalMs ?? 60_000;
  const stopping = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    if (stopping.signal.aborted) return;
    timer = setTimeout(() => void runOnce(), intervalMs);
    timer.unref();
  };
  const pass = async () => {
    try {
      const result = await reconcileInterruptedLegacyJobs({
        database: options.database,
        observe: options.observe,
        onError: options.onError,
        signal: stopping.signal,
      });
      options.onResult?.(result);
    } catch (error) {
      options.onError?.(error);
    }
  };
  const runOnce = (): Promise<void> => {
    if (stopping.signal.aborted) return Promise.resolve();
    clearTimeout(timer);
    running ??= pass().finally(() => {
      running = undefined;
      schedule();
    });
    return running;
  };
  void runOnce();
  return {
    runOnce,
    async stop() {
      stopping.abort();
      clearTimeout(timer);
      await running;
    },
  };
}
