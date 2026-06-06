import type { Command } from "commander";
import { dockerCompose } from "../lib/docker";
import { log, table } from "../lib/output";

/**
 * Turn a `cache clear` target into a Redis key glob.
 *
 * A bare word is treated as an integration namespace (`geocoding` →
 * `int:geocoding:*`), matching the `int:<id>:` prefix every integration's
 * `ctx.cache` writes under. Anything already containing a `*` is passed through
 * verbatim, so callers can target other prefixes too (e.g. `cache:geocode*` for
 * the API's own `withCache` keys, or `int:transit:*`).
 */
export function resolveCachePattern(target: string): string {
  return target.includes("*") ? target : `int:${target}:*`;
}

/**
 * Group Redis keys by namespace (everything up to the last `:` segment) with a
 * count each, sorted by count desc then name. Used by `cache list` to show what
 * is cached without dumping individual keys.
 */
export function aggregateNamespaces(keys: string[]): Array<{ namespace: string; count: number }> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const idx = key.lastIndexOf(":");
    const namespace = idx === -1 ? key : key.slice(0, idx);
    counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([namespace, count]) => ({ namespace, count }))
    .sort((a, b) => b.count - a.count || a.namespace.localeCompare(b.namespace));
}

/** Run `redis-cli` inside the compose `redis` service. */
async function redisCli(args: string[]) {
  return dockerCompose(["exec", "-T", "redis", "redis-cli", ...args]);
}

function parseKeyList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function scanKeys(pattern: string): Promise<string[] | null> {
  const result = await redisCli(["--scan", "--pattern", pattern]);
  if (result.exitCode !== 0) {
    log.err(result.stderr.trim() || "could not reach the redis service (is the stack running?)");
    return null;
  }
  return parseKeyList(result.stdout);
}

export function registerCacheCommands(program: Command): void {
  const cache = program.command("cache").description("Inspect and clear the Redis cache");

  cache
    .command("list")
    .description("List cache key namespaces and their counts")
    .action(async () => {
      const keys = await scanKeys("*");
      if (keys === null) process.exit(1);
      if (keys.length === 0) {
        log.info("Cache is empty.");
        return;
      }
      const rows = aggregateNamespaces(keys).map((r) => ({
        namespace: r.namespace,
        count: String(r.count),
      }));
      console.log(
        table(
          [
            { key: "namespace", header: "Namespace" },
            { key: "count", header: "Keys" },
          ],
          rows,
        ),
      );
      log.dim(`${keys.length} keys total`);
    });

  cache
    .command("clear [target]")
    .description(
      "Delete cached keys. target = a namespace (e.g. `geocoding`) or a key glob " +
        "(e.g. `int:geocoding:*`). Omit target and pass --all to flush everything.",
    )
    .option("--all", "Flush the entire cache database (FLUSHDB)")
    .option("--dry-run", "Report how many keys match without deleting them")
    .action(async (target: string | undefined, opts: { all?: boolean; dryRun?: boolean }) => {
      if (!target && !opts.all) {
        log.err("Specify a namespace or glob (e.g. `cache clear geocoding`), or pass --all.");
        process.exit(1);
      }
      if (target && opts.all) {
        log.err("Pass either a target or --all, not both.");
        process.exit(1);
      }

      if (opts.all) {
        const keys = await scanKeys("*");
        if (keys === null) process.exit(1);
        if (opts.dryRun) {
          log.info(`Would flush the entire cache: ${keys.length} keys.`);
          return;
        }
        const result = await redisCli(["FLUSHDB"]);
        if (result.exitCode !== 0) {
          log.err(result.stderr.trim() || "FLUSHDB failed");
          process.exit(1);
        }
        log.ok(`Flushed the entire cache (${keys.length} keys).`);
        return;
      }

      const pattern = resolveCachePattern(target as string);
      const keys = await scanKeys(pattern);
      if (keys === null) process.exit(1);
      if (keys.length === 0) {
        log.info(`No cache keys match "${pattern}".`);
        return;
      }
      if (opts.dryRun) {
        log.info(
          `Would delete ${keys.length} key${keys.length === 1 ? "" : "s"} matching "${pattern}".`,
        );
        return;
      }
      // Delete in batches to keep argv lengths sane on large key sets.
      let deleted = 0;
      for (let i = 0; i < keys.length; i += 500) {
        const batch = keys.slice(i, i + 500);
        const result = await redisCli(["del", ...batch]);
        if (result.exitCode !== 0) {
          log.err(result.stderr.trim() || "DEL failed");
          process.exit(1);
        }
        deleted += Number.parseInt(result.stdout.trim(), 10) || 0;
      }
      log.ok(`Deleted ${deleted} key${deleted === 1 ? "" : "s"} matching "${pattern}".`);
    });
}
