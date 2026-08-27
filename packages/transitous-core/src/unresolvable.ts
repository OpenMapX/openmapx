import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TransitousLogger } from "./runner.js";

/** Upstream's exact fatal line when a Transitland / MDB source won't resolve. */
const COULD_NOT_RESOLVE_RE = /Error: Could not resolve\s+(\S+)/g;

function resolveErrorText(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
    return [e.stderr, e.stdout, e.message]
      .filter((part): part is string => typeof part === "string")
      .join("\n");
  }
  return String(err);
}

function parseUnresolvableIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(COULD_NOT_RESOLVE_RE)) {
    const id = match[1]?.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Mark feed sources whose `transitland-atlas-id` / `mdb-id` matches one of
 * `ids` as `skip: true` (with a `skip-reason`). Returns the ids actually
 * matched + newly skipped (empty when none were found or all were skipped).
 */
function markSourcesSkipById(
  catalogDir: string,
  ids: ReadonlySet<string>,
  reason: string,
): string[] {
  const feedsDir = join(catalogDir, "feeds");
  if (!existsSync(feedsDir)) return [];
  const marked: string[] = [];
  for (const fileName of readdirSync(feedsDir)) {
    if (!fileName.endsWith(".json")) continue;
    const feedPath = join(feedsDir, fileName);
    let data: { sources?: Array<Record<string, unknown>> };
    try {
      data = JSON.parse(readFileSync(feedPath, "utf-8")) as {
        sources?: Array<Record<string, unknown>>;
      };
    } catch {
      continue;
    }
    let modified = false;
    for (const source of data.sources ?? []) {
      if (source.skip === true) continue;
      const atlasId = source["transitland-atlas-id"];
      const mdbId = source["mdb-id"];
      const matchId =
        typeof atlasId === "string" && ids.has(atlasId)
          ? atlasId
          : (typeof mdbId === "string" || typeof mdbId === "number") && ids.has(String(mdbId))
            ? String(mdbId)
            : null;
      if (!matchId) continue;
      source.skip = true;
      source["skip-reason"] = reason;
      marked.push(matchId);
      modified = true;
    }
    if (modified) writeFileSync(feedPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  }
  return marked;
}

export interface PruneUnresolvableSourcesOptions {
  catalogDir: string;
  /** Region globs scoping the check; mirror gen-motis-config's own scope. */
  countries: string[];
  /**
   * Runs upstream's import-only config generation over `countries` and rejects
   * with its output. The caller owns HOW that happens — a private runner
   * service for the daemon, the tools container for the CLI — so this module
   * never assembles an argv or names an interpreter.
   */
  runCheck: (countries: string[]) => Promise<void>;
  logger: TransitousLogger;
  /** Backstop against an unexpected non-terminating loop. */
  maxIterations?: number;
}

/**
 * Pre-skip sources that upstream's `generate-motis-config.py` can't resolve, by
 * RUNNING that script and acting on its own `Error: Could not resolve <id>`
 * verdict — rather than reimplementing transitland.py's resolution rules (which
 * would silently drift when upstream changes them).
 *
 * Both `fetch.py` and `generate-motis-config.py` `sys.exit(1)` the moment a
 * selected source is unresolvable — e.g. a Transitland feed that gained
 * `authorization=basic_auth` upstream and we hold no key for. fetch.py runs
 * per-feed-file and config-gen runs over all of them, so one such source breaks
 * the whole sync. The caller runs this before the fetch stage. The check uses
 * `--skip-missing-files` so it works before any GTFS is downloaded (resolution
 * happens before the file-existence check).
 *
 * Best-effort: it only acts on the "could not resolve" signal. Any OTHER failure
 * (network, malformed config) is left for the real config-gen stage to surface,
 * so it never fails on its own. Each iteration skips the cited source(s) and
 * re-runs until the check passes (the script exits at the first unresolvable
 * source, so ids surface one batch at a time). Returns the skipped source ids.
 *
 * `runCheck` may dispatch to the private runner service (daemon) or run the
 * script inside the tools container (CLI).
 */
export async function pruneUnresolvableSources(
  opts: PruneUnresolvableSourcesOptions,
): Promise<string[]> {
  const cap = opts.maxIterations ?? 100;
  const skipped: string[] = [];
  for (let i = 0; i < cap; i++) {
    try {
      await opts.runCheck(opts.countries);
      return skipped; // Everything resolves — fetch + config-gen are safe.
    } catch (err) {
      const ids = parseUnresolvableIds(resolveErrorText(err));
      if (ids.length === 0) {
        opts.logger.warn(
          "transitous: resolution pre-check failed for a non-resolution reason; deferring to gen-motis-config",
        );
        return skipped;
      }
      const reason = "unresolvable: upstream generate-motis-config could not resolve this source";
      const newly = markSourcesSkipById(opts.catalogDir, new Set(ids), reason);
      if (newly.length === 0) {
        opts.logger.warn(
          `transitous: generate-motis-config could not resolve ${ids.join(", ")}, but no matching feed source was found to skip`,
        );
        return skipped;
      }
      skipped.push(...newly);
      opts.logger.warn(
        `transitous: skipped unresolvable source(s) ${newly.join(", ")} (upstream generate-motis-config could not resolve them)`,
      );
    }
  }
  opts.logger.warn(
    `transitous: resolution pre-check hit the ${cap}-iteration cap; deferring remaining failures to gen-motis-config`,
  );
  return skipped;
}
