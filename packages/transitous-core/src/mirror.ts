import type { CommandRunner, TransitousLogger } from "./runner.js";

/**
 * Mirror mode reuses the build pipeline but replaces fetch.py (download each
 * origin feed + gtfsclean — the slow, fragile step) with a download of
 * Transitous's already-cleaned `*.gtfs.zip` / `*.netex.zip` artifacts from its
 * published output. The MOTIS config, attribution, and feed-proxy are still
 * generated from the catalog clone, so only the archive fetch differs.
 */

/** A single download command (argv for the runner's `wget`). */
export interface MirrorCommand {
  description: string;
  args: string[];
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Build the `wget` command that recursively mirrors the published GTFS/NeTEx
 * archives into `destDir`. When `countries` is non-empty the accept-list is
 * scoped to `<cc>_*` / `<cc>-*` filename prefixes so a region build doesn't pull
 * the whole planet. (config.yml / license.json / scripts are NOT mirrored — they
 * are regenerated from the catalog clone downstream.)
 */
export function buildMirrorCommands(
  baseUrl: string,
  destDir: string,
  countries: readonly string[] = [],
): MirrorCommand[] {
  const base = ensureTrailingSlash(baseUrl);
  const accepts =
    countries.length === 0
      ? ["*.gtfs.zip", "*.netex.zip"]
      : countries.flatMap((cc) => [
          `${cc}_*.gtfs.zip`,
          `${cc}-*.gtfs.zip`,
          `${cc}_*.netex.zip`,
          `${cc}-*.netex.zip`,
        ]);
  return [
    {
      description: "gtfs/netex archives",
      args: [
        "--recursive",
        "--no-parent",
        "--no-host-directories",
        "--cut-dirs=1",
        "--no-verbose",
        "-R",
        "index.html*",
        "-A",
        accepts.join(","),
        "-P",
        destDir,
        base,
      ],
    },
  ];
}

/** Run all mirror commands in order. Throws if any download fails. */
export async function mirrorArtifacts(opts: {
  baseUrl: string;
  destDir: string;
  countries?: readonly string[];
  runner: CommandRunner;
  logger: TransitousLogger;
}): Promise<number> {
  const commands = buildMirrorCommands(opts.baseUrl, opts.destDir, opts.countries ?? []);
  for (const cmd of commands) {
    opts.logger.info(`transitous-mirror: fetching ${cmd.description}`);
    await opts.runner("wget", cmd.args, { stdio: "pipe" });
  }
  return commands.length;
}

/** Transitous's hosted realtime feed-proxy, baked into the generated config. */
export const TRANSITOUS_FEED_PROXY_URL = "https://rt.triptix.tech";

/**
 * Rewrite the MOTIS `config.yml` so realtime feeds flow through OUR feed-proxy
 * instead of Transitous's hosted one (`rt.triptix.tech`) — keeping realtime
 * independent of Transitous infrastructure. Returns the rewritten text and how
 * many occurrences were replaced. Used by both build and mirror mode.
 */
export function rewriteRtUrls(
  configText: string,
  feedProxyUrl: string,
): { text: string; replaced: number } {
  const target = feedProxyUrl.replace(/\/$/, "");
  const parts = configText.split(TRANSITOUS_FEED_PROXY_URL);
  return { text: parts.join(target), replaced: parts.length - 1 };
}
