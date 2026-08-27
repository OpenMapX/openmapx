import { runOpsOperation } from "../../ops-client.js";

/**
 * Default Valhalla container name under the default docker-compose project
 * naming (`<project>-<service>-1`). `infra/docker`'s compose project is named
 * "docker" and `services/valhalla/service.json` pins no
 * `container.containerName`, so the runtime container falls back to this
 * convention. Overridable via `VALHALLA_CONTAINER` for non-default compose
 * project names.
 */
// Exported so sibling traffic jobs (e.g. `ways-to-edges.ts`, which also shells
// out to the Valhalla container) share these constants instead of duplicating
// values that would silently drift.
export const DEFAULT_VALHALLA_CONTAINER = "docker-valhalla-1";
export const DEFAULT_VALHALLA_CONFIG_PATH = "/custom_files/valhalla.json";
/** Must match `mjolnir.tile_dir` in services/valhalla/config/valhalla.json. */
export const TILE_DIR_PATH = "/custom_files/valhalla_tiles";

export interface DockerRunResult {
  exitCode: number;
  stdout: string;
}

/**
 * Retained shape for callers/tests; the effect itself is a typed agent
 * operation, so the unit suite
 * never shells out to docker. One shape covers `exec`, `restart`, and the
 * `stat`-based mtime probes used by the staleness check — the first arg
 * (`args[0]`) distinguishes them, mirroring `cron.ts`'s `reloadFeedProxy` seam.
 */
export type DockerRunner = (args: string[]) => Promise<DockerRunResult>;

interface TrafficExtractLogger {
  info: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface EnsureTrafficExtractDeps {
  runDocker?: DockerRunner;
  container?: string;
  configPath?: string;
  logger?: TrafficExtractLogger;
  /**
   * Skip the presence check and rebuild unconditionally. Used by the guard
   * cron once it has already determined the extract is stale — re-checking
   * presence there would be a no-op since the file exists, just outdated.
   */
  force?: boolean;
}

export interface EnsureTrafficExtractResult {
  built: boolean;
}

/**
 * Resolves the Valhalla container name from an explicit override, falling
 * back to `VALHALLA_CONTAINER` and then the default compose-project naming
 * convention. Exported for reuse by sibling traffic jobs that also shell out
 * to the same container (e.g. `ways-to-edges.ts`).
 */
export function resolveContainer(deps: { container?: string }): string {
  if (deps.container) return deps.container;
  const envValue = process.env.VALHALLA_CONTAINER;
  return envValue && envValue.trim() !== "" ? envValue.trim() : DEFAULT_VALHALLA_CONTAINER;
}

/**
 * Ensures the Valhalla container has a `traffic.tar` extract at
 * `mjolnir.traffic_extract` before anything tries to mmap it (the future
 * live-speed writer needs the tar to already exist).
 *
 * Ordering constraint: the extract is sized to the graph's directed-edge
 * count at build time and cannot grow in place. Any Valhalla tile rebuild
 * (new OSM PBF) invalidates it, and a stale extract doesn't fail soft —
 * Valhalla throws mid-request when a traffic tile's `directed_edge_count`
 * disagrees with the graph tile it maps to. `isTrafficExtractStale` +
 * `cron.ts`'s guard cron detect that condition and call this with
 * `force: true` to rebuild eagerly rather than let it surface at request
 * time.
 */
export async function ensureTrafficExtract(
  deps: EnsureTrafficExtractDeps = {},
): Promise<EnsureTrafficExtractResult> {
  // The whole build/validate/chown/restart sequence is host authority and lives
  // in the operations agent. Data-manager holds no Docker socket and names no
  // container, config path, or argv.
  if (!deps.force && !(await isTrafficExtractStale(deps))) {
    deps.logger?.info("traffic-extract: already present");
    return { built: false };
  }
  deps.logger?.info("traffic-extract: building");
  const result = await runOpsOperation({ kind: "valhalla.traffic.rebuild" });
  return { built: result.changed };
}

/**
 * True when a rebuild is due: the traffic extract is missing outright, or the
 * graph tiles directory is newer than it (a prior tile rebuild invalidated
 * the edge-count-sized extract). Used by the slow guard cron in `cron.ts` —
 * see the ordering-constraint note on `ensureTrafficExtract`.
 */
export async function isTrafficExtractStale(
  _deps: EnsureTrafficExtractDeps = {},
): Promise<boolean> {
  const result = await runOpsOperation({ kind: "valhalla.traffic.inspect" });
  // `unknown` means the agent could not read the tile directory while an
  // extract exists. Treat that as not-stale so an inconclusive probe never
  // triggers a needless rebuild-and-restart of Valhalla.
  return result.state === "not_ready";
}
