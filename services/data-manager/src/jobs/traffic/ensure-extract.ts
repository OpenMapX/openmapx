import { execa } from "execa";

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
/** Must match `mjolnir.traffic_extract` in services/valhalla/config/valhalla.json. */
const TRAFFIC_TAR_PATH = "/custom_files/traffic.tar";
/** Must match `mjolnir.tile_dir` in services/valhalla/config/valhalla.json. */
export const TILE_DIR_PATH = "/custom_files/valhalla_tiles";

export interface DockerRunResult {
  exitCode: number;
  stdout: string;
}

/**
 * Test seam: invoked instead of `execa("docker", [...])` so the unit suite
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

async function defaultRunDocker(args: string[]): Promise<DockerRunResult> {
  const result = await execa("docker", args, { stdio: "pipe", reject: false });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout ?? "" };
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
  const run = deps.runDocker ?? defaultRunDocker;
  const container = resolveContainer(deps);
  const configPath = deps.configPath ?? DEFAULT_VALHALLA_CONFIG_PATH;

  if (!deps.force) {
    const presence = await run(["exec", container, "test", "-f", TRAFFIC_TAR_PATH]);
    if (presence.exitCode === 0) {
      deps.logger?.info("traffic-extract: already present", { container });
      return { built: false };
    }
  }

  deps.logger?.info("traffic-extract: building", { container });
  // `-t`/`--with-traffic` is a flag, not a path — the output path comes from
  // `mjolnir.traffic_extract` in the config. This deployment configures
  // `mjolnir.tile_dir` (a tile DIRECTORY, "/custom_files/valhalla_tiles"), not
  // a `mjolnir.tile_extract` tar — `valhalla_build_extract -t` reads the tile
  // directory directly, so the plan's tile_extract-orphaning concern does not
  // apply here (there is no graph-tile extract tar to leave stale).
  const build = await run(["exec", container, "valhalla_build_extract", "-c", configPath, "-t"]);
  if (build.exitCode !== 0) {
    // Don't restart the container or claim success on a failed build — that
    // would mask the failure until the next daily guard sweep and bounce
    // Valhalla for nothing. Surface it now so the caller logs it immediately.
    throw new Error(
      `traffic-extract: valhalla_build_extract exited ${build.exitCode} on container "${container}"`,
    );
  }
  await run(["restart", container]);
  return { built: true };
}

async function getMtimeSeconds(
  run: DockerRunner,
  container: string,
  path: string,
): Promise<number | null> {
  const result = await run(["exec", container, "stat", "-c", "%Y", path]);
  if (result.exitCode !== 0) return null;
  const parsed = Number(result.stdout.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * True when a rebuild is due: the traffic extract is missing outright, or the
 * graph tiles directory is newer than it (a prior tile rebuild invalidated
 * the edge-count-sized extract). Used by the slow guard cron in `cron.ts` —
 * see the ordering-constraint note on `ensureTrafficExtract`.
 */
export async function isTrafficExtractStale(deps: EnsureTrafficExtractDeps = {}): Promise<boolean> {
  const run = deps.runDocker ?? defaultRunDocker;
  const container = resolveContainer(deps);

  const [tileMtime, tarMtime] = await Promise.all([
    getMtimeSeconds(run, container, TILE_DIR_PATH),
    getMtimeSeconds(run, container, TRAFFIC_TAR_PATH),
  ]);
  if (tarMtime === null) return true;
  if (tileMtime === null) return false;
  return tileMtime > tarMtime;
}
