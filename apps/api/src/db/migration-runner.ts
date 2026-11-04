import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Sql } from "postgres";

/**
 * Advisory lock key that serializes app-api instances migrating one database.
 * Drizzle's migrator takes no lock: two instances starting together would both
 * read the same last applied migration and run the pending ones twice.
 */
export const MIGRATION_LOCK_KEY = 4_206_712_018_342n;

const DEFAULT_PROGRESS_INTERVAL_MS = 60_000;
const LOGGED_STATEMENT_LENGTH = 200;
// Docker waits 10 seconds after SIGTERM before it kills the container.
const CANCEL_RETRY_MS = 5_000;
const CANCEL_POLL_MS = 250;

export interface MigrationLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

interface JournalEntry {
  tag: string;
  when: number;
}

/**
 * The journal tags Drizzle's migrator will apply, by its own rule: every entry
 * newer than the newest applied migration's timestamp.
 */
export function pendingMigrations(entries: JournalEntry[], lastAppliedAt: number | null): string[] {
  return entries
    .filter((entry) => lastAppliedAt === null || lastAppliedAt < entry.when)
    .map((entry) => entry.tag);
}

function readJournal(migrationsFolder: string): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  return (journal as { entries: JournalEntry[] }).entries;
}

/** The newest applied migration's timestamp, or null before the first migration. */
async function lastAppliedAt(session: Sql): Promise<number | null> {
  const [{ exists }] = await session<{ exists: boolean }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists
  `;
  if (!exists) return null;
  const [{ applied }] = await session<{ applied: string | null }[]>`
    SELECT max(created_at)::text AS applied FROM drizzle.__drizzle_migrations
  `;
  return applied === null ? null : Number(applied);
}

export interface MigrationRunOptions {
  /** A dedicated single-connection client; the run ends it when it settles. */
  session: Sql;
  /** Another client, used to watch and stop the migrating session. */
  control: Sql;
  migrationsFolder: string;
  log: MigrationLogger;
  progressIntervalMs?: number;
}

export interface MigrationRun {
  /** Settles with the tags applied, or rejects when the migration failed. */
  done: Promise<string[]>;
  /**
   * Stops the migration in Postgres so its transaction rolls back and releases
   * its locks now. Closing the client alone leaves a long statement running on
   * the server until it next writes to the gone connection.
   */
  cancel(): Promise<void>;
}

interface SessionActivity {
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  statement: string | null;
  seconds: number | null;
}

/**
 * Applies the pending migrations on one session that holds the migration lock,
 * logging what it applies and, while it runs, what the session is doing.
 */
export function startMigrations(options: MigrationRunOptions): MigrationRun {
  const { session, control, migrationsFolder, log } = options;
  const progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  let backendPid: number | null = null;
  let settled = false;
  let phase: "waiting-for-lock" | "migrating" = "waiting-for-lock";
  let pending: string[] = [];
  const startedAt = Date.now();

  const reportProgress = async () => {
    if (backendPid === null || settled) return;
    const [activity] = await control<SessionActivity[]>`
      SELECT state, wait_event_type, wait_event,
             left(query, ${LOGGED_STATEMENT_LENGTH}) AS statement,
             extract(epoch FROM now() - query_start)::int AS seconds
      FROM pg_stat_activity WHERE pid = ${backendPid}
    `;
    if (settled) return;
    const fields = {
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      ...(phase === "migrating" ? { migrations: pending } : {}),
      statement: activity?.statement ?? null,
      statementSeconds: activity?.seconds ?? null,
      waitEvent: activity?.wait_event ? `${activity.wait_event_type}:${activity.wait_event}` : null,
    };
    if (phase === "waiting-for-lock") {
      log.info(fields, "Still waiting for another app-api instance to finish migrating");
    } else if (activity?.wait_event_type === "Lock") {
      log.warn(fields, "Database migration is waiting for a lock another session holds");
    } else {
      log.info(fields, "Still applying database migrations");
    }
  };
  const progressTimer = setInterval(() => {
    reportProgress().catch((err) =>
      log.warn({ err }, "Could not read the migrating session's progress"),
    );
  }, progressIntervalMs);
  progressTimer.unref();

  const run = async (): Promise<string[]> => {
    const [{ pid }] = await session<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    backendPid = pid;

    const [{ locked }] = await session<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY.toString()}::bigint) AS locked
    `;
    if (!locked) {
      log.info({}, "Waiting for another app-api instance to finish migrating the database");
      await session`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY.toString()}::bigint)`;
    }
    phase = "migrating";

    pending = pendingMigrations(readJournal(migrationsFolder), await lastAppliedAt(session));
    if (pending.length > 0) {
      log.info(
        { migrations: pending },
        `Applying ${pending.length} database migration${pending.length === 1 ? "" : "s"}`,
      );
    }

    await migrate(drizzle(session), { migrationsFolder });
    return pending;
  };

  const done = run().finally(async () => {
    settled = true;
    clearInterval(progressTimer);
    // Ending the session also releases the advisory lock.
    await session.end({ timeout: 5 });
  });

  const settledWithin = (ms: number) =>
    Promise.race([
      done.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref()),
    ]);

  return {
    done,
    async cancel() {
      if (settled || backendPid === null) return;
      // Cancelling the running statement aborts the migration transaction and
      // lets the client roll it back on its live connection. A cancel that
      // lands between two statements has nothing to stop, so repeat it.
      const deadline = Date.now() + CANCEL_RETRY_MS;
      while (!settled && Date.now() < deadline) {
        await control`SELECT pg_cancel_backend(${backendPid})`;
        if (await settledWithin(CANCEL_POLL_MS)) return;
      }
      if (!settled) {
        await control`SELECT pg_terminate_backend(${backendPid})`;
        await settledWithin(CANCEL_POLL_MS);
      }
    },
  };
}
