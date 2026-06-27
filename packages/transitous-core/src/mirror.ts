import type { CommandRunner, TransitousLogger } from "./runner.js";

/**
 * Mirror mode consumes Transitous's published, already-processed output instead
 * of cloning the catalog and running its scripts. These helpers build the
 * `wget` invocations, parse the published `license.json`, and rewrite the
 * published `config.yml`'s realtime URLs onto our own feed-proxy.
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
 * Build the `wget` commands that pull the published artifacts into `destDir`:
 * `config.yml` + `license.json` as direct fetches, then a recursive mirror of
 * the GTFS/NeTEx archives and `scripts/*.lua`. When `countries` is non-empty the
 * archive accept-list is scoped to `<cc>_*` / `<cc>-*` filename prefixes so a
 * region build doesn't pull the whole planet.
 */
export function buildMirrorCommands(
  baseUrl: string,
  destDir: string,
  countries: readonly string[] = [],
): MirrorCommand[] {
  const base = ensureTrailingSlash(baseUrl);
  const archiveAccepts =
    countries.length === 0
      ? ["*.gtfs.zip", "*.netex.zip", "*.lua"]
      : [
          ...countries.flatMap((cc) => [`${cc}_*.gtfs.zip`, `${cc}-*.gtfs.zip`]),
          ...countries.flatMap((cc) => [`${cc}_*.netex.zip`, `${cc}-*.netex.zip`]),
          "*.lua",
        ];
  return [
    { description: "config.yml", args: ["-q", "-O", `${destDir}/config.yml`, `${base}config.yml`] },
    {
      description: "license.json",
      args: ["-q", "-O", `${destDir}/license.json`, `${base}license.json`],
    },
    {
      description: "gtfs archives + scripts",
      args: [
        "--recursive",
        "--no-parent",
        "--no-host-directories",
        "--cut-dirs=1",
        "--no-verbose",
        "-R",
        "index.html*",
        "-A",
        archiveAccepts.join(","),
        "-P",
        destDir,
        base,
      ],
    },
  ];
}

/**
 * The `.import-running` sentinel published while Transitous's build host is
 * mid-import — mirroring then would capture a half-written tree.
 */
export async function isMirrorPublishInProgress(
  baseUrl: string,
  runner: CommandRunner,
): Promise<boolean> {
  const base = ensureTrailingSlash(baseUrl);
  try {
    // `wget --spider` returns non-zero (throws) when the sentinel is absent.
    await runner("wget", ["-q", "--spider", `${base}.import-running`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
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

export interface LicenseEntry {
  countryCode?: string;
  countryName?: string;
  regionCode?: string;
  regionName?: string;
  humanName?: string;
  filename?: string;
  lastUpdated?: string;
  spdxLicenseIdentifier?: string;
}

/**
 * Parse Transitous's `license.json` (an array). Tolerant of extra fields and of
 * either camelCase or the snake_case the script emits. Returns [] on bad input.
 */
export function parseLicenseManifest(jsonText: string): LicenseEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const str = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = r[k];
        if (typeof v === "string" && v.length > 0) return v;
      }
      return undefined;
    };
    return {
      countryCode: str("country_code", "countryCode"),
      countryName: str("country_name", "countryName"),
      regionCode: str("region_code", "regionCode"),
      regionName: str("region_name", "regionName"),
      humanName: str("human_name", "humanName", "name"),
      filename: str("filename"),
      lastUpdated: str("last_updated", "lastUpdated"),
      spdxLicenseIdentifier: str("spdx_license_identifier", "spdxLicenseIdentifier"),
    };
  });
}

/** Transitous's hosted realtime feed-proxy, baked into the published config. */
export const TRANSITOUS_FEED_PROXY_URL = "https://rt.triptix.tech";

/**
 * Rewrite the published `config.yml` so realtime feeds flow through OUR
 * feed-proxy instead of Transitous's hosted one (`rt.triptix.tech`) — keeping
 * our realtime independent of Transitous infrastructure. Returns the rewritten
 * text and how many occurrences were replaced.
 */
export function rewriteRtUrls(
  configText: string,
  feedProxyUrl: string,
): { text: string; replaced: number } {
  const target = feedProxyUrl.replace(/\/$/, "");
  let replaced = 0;
  const text = configText.split(TRANSITOUS_FEED_PROXY_URL).join(target);
  // Count occurrences replaced (split length - 1), guarding the no-op case.
  replaced = configText.split(TRANSITOUS_FEED_PROXY_URL).length - 1;
  return { text, replaced };
}
