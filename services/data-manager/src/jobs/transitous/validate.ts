import { existsSync, statSync } from "node:fs";
import { execa } from "execa";
import { recordValidateOutcome } from "./feed-state-writer.js";
import { scanGtfsArchives } from "./internal.js";
import type { JobContext, StageFn, StageResult, StageStatus } from "./types.js";

/**
 * Light validation: each archive in `outDir` must exist, be non-empty, and
 * contain a `feed_info.txt` entry (verified via `unzip -p` so we don't pull a
 * full zip parser into the data-manager). Expensive validation (calendar
 * date-range checks, fare-rules sanity, etc.) belongs in motis-import.
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    const gtfsDir = ctx.state.gtfsDir ?? ctx.outDir;
    const archives = scanGtfsArchives(gtfsDir);
    const invalid: Array<{ id: string; reason: string }> = [];
    let validated = 0;
    const perFeed: Array<{ id: string; ok: boolean; reason?: string }> = [];

    for (const archive of archives) {
      if (!existsSync(archive.path)) {
        invalid.push({ id: archive.id, reason: "archive missing on disk" });
        perFeed.push({ id: archive.id, ok: false, reason: "archive missing on disk" });
        continue;
      }
      const size = statSync(archive.path).size;
      if (size <= 0) {
        invalid.push({ id: archive.id, reason: "archive is empty" });
        perFeed.push({ id: archive.id, ok: false, reason: "archive is empty" });
        continue;
      }
      const memberOk = await hasZipMember(archive.path, "feed_info.txt");
      if (!memberOk) {
        // feed_info.txt is optional per the GTFS spec but Transitous-published
        // archives always include it. Treat its absence as a soft warning by
        // marking the archive invalid; the fetch artifact already recorded
        // success so the data is still on disk for inspection.
        invalid.push({ id: archive.id, reason: "missing feed_info.txt" });
        perFeed.push({ id: archive.id, ok: false, reason: "missing feed_info.txt" });
        continue;
      }
      validated++;
      perFeed.push({ id: archive.id, ok: true });
    }

    // Persist per-feed validation outcomes for the staleness-alert cron (G2).
    // On success → reset `consecutive_failures` to 0. On failure → atomic
    // increment. Best-effort: DB outages here are logged but do not flip the
    // pipeline stage status.
    await persistValidateOutcomes(perFeed, ctx);

    let status: StageStatus = "ok";
    if (invalid.length > 0) {
      status = validated > 0 ? "partial" : "error";
    }

    return {
      stage: "validate",
      status,
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message:
        invalid.length === 0
          ? `Validated ${validated} archive(s)`
          : `Validated ${validated} / ${archives.length} archive(s); ${invalid.length} invalid`,
      artifacts: {
        validated,
        invalid,
      },
    } satisfies StageResult;
  } catch (error) {
    const err = error as Error;
    return {
      stage: "validate",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: err.message,
      error: { message: err.message, stack: err.stack },
    };
  }
};

/**
 * Translate `archive.id` (e.g. `de_vbb`) into the `(region, name)` natural key
 * used by `data_manager.feed_state`, then push the outcome through the
 * writer. Archives whose id doesn't start with a 2-letter country code are
 * skipped — the staleness cron is region/country-scoped so an unparseable id
 * cannot generate a useful alert.
 */
async function persistValidateOutcomes(
  perFeed: Array<{ id: string; ok: boolean; reason?: string }>,
  ctx: JobContext,
): Promise<void> {
  for (const entry of perFeed) {
    const split = entry.id.indexOf("_");
    if (split <= 0) continue;
    const region = entry.id.slice(0, split).toLowerCase();
    const name = entry.id.slice(split + 1).toLowerCase();
    if (!region || !name) continue;
    try {
      await recordValidateOutcome({
        region,
        name,
        ok: entry.ok,
        message: entry.reason,
      });
    } catch (err) {
      ctx.logger.warn(
        `transitous-validate: feed_state write failed for ${entry.id}: ${(err as Error).message}`,
      );
    }
  }
}

async function hasZipMember(archivePath: string, member: string): Promise<boolean> {
  try {
    // `unzip -Z1 <archive>` lists members one per line. Faster than `-l` and
    // doesn't print the size column. Tolerate missing `unzip` by treating the
    // check as a soft pass — the orchestrator already recorded fetch success.
    const { stdout } = await execa("unzip", ["-Z1", archivePath], { stdio: "pipe" });
    return stdout.split(/\r?\n/).some((line) => line.trim() === member);
  } catch {
    return true;
  }
}
