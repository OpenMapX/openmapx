import { feedState } from "@openmapx/db-schema";
import { type SQL, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { scrubSecretsOptional } from "../../utils/scrub-secrets.js";
import type { FeedFileEntry } from "./types.js";

/**
 * Short timeout applied to every feed_state write so a missing Postgres
 * (typical for unit tests, dev scripts without docker) fails fast and
 * the calling stage's try/catch wrapper records the warning without
 * stalling the pipeline.
 *
 * The first write that times out flips a process-wide circuit breaker so
 * subsequent writes in the same pipeline run no-op immediately rather than
 * spending another 800ms each. The breaker is per-process; restart picks up
 * a fresh DB connection on the next sync.
 */
const FEED_STATE_WRITE_TIMEOUT_MS = 800;
let feedStateCircuitOpen = false;

/**
 * Run feed_state work under the breaker and timeout. Callers pass a lazy
 * factory so an open breaker rejects before any query starts; a timed-out
 * operation is not cancelled and may still complete in the background.
 */
async function withTimeout<T>(work: () => Promise<T>): Promise<T> {
  if (feedStateCircuitOpen) {
    throw new Error("feed_state writes disabled (previous write failed)");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const promise = work();
    // Attach a passive catch handler so a delayed connection failure after the
    // timeout has fired does not surface as an unhandled rejection.
    promise.catch(() => {});
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`feed_state write timed out after ${FEED_STATE_WRITE_TIMEOUT_MS}ms`)),
          FEED_STATE_WRITE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    // First failure trips the breaker. Connection refused / timeout almost
    // always means the deployment is misconfigured; subsequent writes will
    // fail the same way, so we save the wallclock time and let the calling
    // stages keep going.
    feedStateCircuitOpen = true;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test-only reset for the circuit breaker. Production never calls this. */
export function resetFeedStateCircuitForTests(): void {
  feedStateCircuitOpen = false;
}

/**
 * Per-feed write surface used by the fetch + validate stages. Each call upserts
 * a row keyed on `(region, name)` so the staleness alert can read
 * `lastFetchedAt` + `validationStatus` + `consecutiveFailures` directly from
 * Postgres without poking at the in-memory state of a running pipeline.
 *
 * Failures here are swallowed by the caller: a transient DB outage during the
 * pipeline must not invalidate an otherwise successful GTFS run.
 */

export interface FeedStateKey {
  region: string;
  name: string;
}

/** Record one fetch outcome for a feed. */
export interface FetchOutcome extends FeedStateKey {
  ok: boolean;
  /** sha256 of the freshly fetched archive — only set on success. */
  hash?: string;
}

/** Record one validation outcome for a feed. */
export interface ValidateOutcome extends FeedStateKey {
  ok: boolean;
  message?: string;
}

/**
 * Mark the fetch attempt. `lastFetchedAt` advances on success (the upstream
 * payload landed on disk); we do not bump it on failure because the alerting
 * threshold ("48h stale") is meant to catch a feed that hasn't successfully
 * refreshed.
 */
export async function recordFetchOutcome(outcome: FetchOutcome): Promise<void> {
  const now = new Date();
  if (outcome.ok) {
    await withTimeout(() =>
      upsertFeedState({
        region: outcome.region,
        name: outcome.name,
        values: {
          lastFetchedAt: now,
          hash: outcome.hash ?? null,
          status: "active",
        },
      }),
    );
  } else {
    // Failed fetch: leave `lastFetchedAt` alone so the 48h staleness check
    // still fires. Mark status as `failed` for the admin UI.
    await withTimeout(() =>
      upsertFeedState({
        region: outcome.region,
        name: outcome.name,
        values: { status: "failed" },
      }),
    );
  }
}

/**
 * Mark the validation outcome. Success resets `consecutive_failures` to 0;
 * a failure increments the stored counter in the same statement, so
 * concurrent pipelines never lose a count.
 */
export async function recordValidateOutcome(outcome: ValidateOutcome): Promise<void> {
  const validationMessage = scrubSecretsOptional(outcome.message) ?? null;
  if (outcome.ok) {
    await withTimeout(() =>
      upsertFeedState({
        region: outcome.region,
        name: outcome.name,
        values: {
          validationStatus: "ok",
          validationMessage,
          consecutiveFailures: 0,
          status: "active",
        },
      }),
    );
    return;
  }
  await withTimeout(() =>
    upsertFeedState({
      region: outcome.region,
      name: outcome.name,
      values: {
        validationStatus: "error",
        validationMessage,
        status: "failed",
        consecutiveFailures: 1,
      },
      onConflict: { consecutiveFailures: sql`${feedState.consecutiveFailures} + 1` },
    }),
  );
}

interface FeedStateValues {
  lastFetchedAt?: Date | null;
  lastImportedAt?: Date | null;
  hash?: string | null;
  validationStatus?: string | null;
  validationMessage?: string | null;
  status?: string;
  consecutiveFailures?: number;
}

interface UpsertArgs {
  region: string;
  name: string;
  /** Written on a new row, and on an existing one unless `onConflict` replaces them. */
  values: FeedStateValues;
  onConflict?: { consecutiveFailures: SQL };
}

/** One statement keyed on `(region, name)`: inserts the row or updates the given columns. */
async function upsertFeedState(args: UpsertArgs): Promise<void> {
  await db
    .insert(feedState)
    .values({ region: args.region, name: args.name, ...args.values })
    .onConflictDoUpdate({
      target: [feedState.region, feedState.name],
      set: { ...args.values, ...args.onConflict },
    });
}

/**
 * Resolve a `FeedFileEntry` and an upstream source name into the
 * `(region, name)` primary key of the feed_state table. It stores `region` as
 * the country code (lowercased) and `name` as the
 * upstream-published source name (lowercased) so it lines up with how the
 * alert emitter logs and titles GitHub Issues.
 */
export function feedKeyForSource(
  feed: { country: string },
  sourceName: string,
  sourceRegion?: string,
): FeedStateKey {
  return {
    region: (sourceRegion ?? feed.country).toLowerCase(),
    name: sourceName.toLowerCase(),
  };
}

/** Same resolution path for a `FeedDownloadFailure`. */
export function feedKeyForFailure(failure: { country: string; id: string }): FeedStateKey {
  // The failure record only carries the synthesized id (`<country>_<name>`)
  // and the country. Split on the first `_` to recover the source name.
  const stripped = failure.id.toLowerCase();
  const region = failure.country.toLowerCase();
  const prefix = `${region}_`;
  const name = stripped.startsWith(prefix) ? stripped.slice(prefix.length) : stripped;
  return { region, name };
}

export function feedKeysForEntry(entry: FeedFileEntry): FeedStateKey[] {
  return entry.activeScheduleSources.map((source) =>
    feedKeyForSource(entry, source.name, source.region),
  );
}

/** Advance import evidence only after the corresponding source manifest is live. */
export async function recordPromotedSource(source: {
  region: string;
  name: string;
}): Promise<void> {
  await withTimeout(() =>
    upsertFeedState({
      region: source.region.toLowerCase(),
      name: source.name.toLowerCase(),
      values: { lastImportedAt: new Date(), status: "active" },
    }),
  );
}
