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
 */
export const MOTIS_VERSION = "2.10.2";

/**
 * Base URL of Transitous's published, already-processed output (mirror mode):
 * postprocessed `*.gtfs.zip`, `config.yml`, `license.json`, `scripts/*.lua`,
 * and an `.import-running` sentinel. This is the stable, version-independent
 * integration seam Transitous itself designed for downstream consumers.
 */
export const TRANSITOUS_ARTIFACT_BASE_URL = "https://api.transitous.org/gtfs/";
