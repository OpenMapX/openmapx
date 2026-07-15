/**
 * Where transit data comes from:
 * - `mirror`: download Transitous's pre-processed output (gtfs + config + license).
 * - `build`: clone the catalog and run Transitous's scripts (fetch + config-gen).
 */
export type TransitSource = "mirror" | "build";

/** Resolve {@link TransitSource} from `TRANSIT_SOURCE` (default `mirror`). */
export function parseTransitSource(env: NodeJS.ProcessEnv = process.env): TransitSource {
  return env.TRANSIT_SOURCE?.trim().toLowerCase() === "build" ? "build" : "mirror";
}

/** Upstream Transitous git repo (the GTFS catalog + MOTIS config scripts). */
export const DEFAULT_TRANSITOUS_REPO_URL = "https://github.com/public-transport/transitous.git";

/** Working-tree dir name for the cloned catalog, under the data dir. */
export const TRANSITOUS_CATALOG_DIR = ".transitous-catalog";

/** Fetch-cache dir name, under the data dir. */
export const TRANSITOUS_DOWNLOADS_DIR = ".transitous-downloads";

/**
 * MOTIS version the consumed Transitous config targets. The generated/published
 * `config.yml` is MOTIS-version-coupled, so the importing MOTIS must match.
 * Keep in lockstep with upstream when bumping the catalog.
 *
 * This is the **single source of truth** for the MOTIS pin; the `motis` /
 * `motis-staging` service.json tags, the transitous-tools Dockerfile ARG, and
 * the `@motis-project/motis-client` deps must all match it — enforced by
 * `pnpm check-toolchain-pins`.
 */
export const MOTIS_VERSION = "2.10.2";

/**
 * Pinned `gtfsclean` build (the GTFS post-processor fetch.py runs). Single
 * source of truth for the commit baked into both the transitous-tools and
 * data-manager images — enforced by `pnpm check-toolchain-pins`.
 */
export const GTFSCLEAN_COMMIT = "bb3ea74f66ef9bc07dc1bd038c3f653e10f0ade0";

/**
 * Base URL of Transitous's published, already-processed output (mirror mode):
 * postprocessed `*.gtfs.zip`, `config.yml`, `license.json`, `scripts/*.lua`,
 * and an `.import-running` sentinel. This is the stable, version-independent
 * integration seam Transitous itself designed for downstream consumers.
 */
export const TRANSITOUS_ARTIFACT_BASE_URL = "https://api.transitous.org/gtfs/";

/** Immutable MobilityData registry revision paired with gbfs-catalog.lock.json. */
export const MOBILITYDATA_GBFS_CATALOG_COMMIT = "39a290ed5c5b8f62b720d5715a31bc3f0c0725d9";
export const MOBILITYDATA_GBFS_CATALOG_URL = `https://raw.githubusercontent.com/MobilityData/gbfs/${MOBILITYDATA_GBFS_CATALOG_COMMIT}/systems.csv`;
