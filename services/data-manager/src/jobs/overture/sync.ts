import { ingestOverture } from "./ingest.js";
import { withOvertureOperationLock } from "./operation-lock.js";
import { assertValidRegion, pullOverture, resolveOvertureRelease } from "./pull.js";
import { type RebuildOvertureLinksResult, rebuildOvertureLinksUnlocked } from "./rebuild-links.js";
import {
  overtureReleaseRetentionFromEnv,
  type PruneOvertureReleasesResult,
  pruneOvertureReleases,
} from "./retention.js";

export interface SyncOvertureRegionOptions {
  region: string;
  dataDir: string;
  release?: string;
  onProgress?: (msg: string) => void;
}

export interface SyncOvertureRegionResult {
  release: string;
  path: string;
  conflation: RebuildOvertureLinksResult["status"];
  linked: number;
  conflationError?: string;
  retention?: PruneOvertureReleasesResult;
}

interface SyncOvertureDependencies {
  pull: typeof pullOverture;
  ingest: typeof ingestOverture;
  rebuildLinks: typeof rebuildOvertureLinksUnlocked;
  withOperationLock: typeof withOvertureOperationLock;
  pruneReleases: typeof pruneOvertureReleases;
}

const defaultDependencies: SyncOvertureDependencies = {
  pull: pullOverture,
  ingest: ingestOverture,
  rebuildLinks: rebuildOvertureLinksUnlocked,
  withOperationLock: withOvertureOperationLock,
  pruneReleases: pruneOvertureReleases,
};

/**
 * Replaces a regional Overture dataset from one immutable release snapshot.
 * `ingestOverture` loads a staging schema and atomically swaps it into service,
 * so a failed pull/import never partially updates the live places table.
 * OSM link precomputation is optional and rebuilt only from the matching local
 * regional extract; category search remains fully functional without it.
 */
export async function syncOvertureRegion(
  opts: SyncOvertureRegionOptions,
  dependencies: SyncOvertureDependencies = defaultDependencies,
): Promise<SyncOvertureRegionResult> {
  return dependencies.withOperationLock(() => syncOvertureRegionUnlocked(opts, dependencies));
}

async function syncOvertureRegionUnlocked(
  opts: SyncOvertureRegionOptions,
  dependencies: SyncOvertureDependencies,
): Promise<SyncOvertureRegionResult> {
  assertValidRegion(opts.region);
  const release = await resolveOvertureRelease(opts.release);
  opts.onProgress?.(`Starting atomic regional Overture refresh for ${release}…`);
  const path = await dependencies.pull({ ...opts, release });
  await dependencies.ingest({ ...opts, release });

  opts.onProgress?.("Rebuilding OSM↔Overture links from the regional OSM extract…");
  const result = await dependencies.rebuildLinks({
    region: opts.region,
    dataDir: opts.dataDir,
    release,
    onProgress: opts.onProgress,
  });
  if (
    result.status === "failed" ||
    result.status === "waiting_for_osm" ||
    result.status === "already_running"
  ) {
    opts.onProgress?.(
      `Places release ${release} is active; independent link rebuild is ${result.status} ` +
        "and will retry before old snapshots are pruned.",
    );
    return {
      release,
      path,
      conflation: result.status,
      linked: result.linked,
      conflationError:
        result.status === "failed"
          ? result.error
          : result.status === "waiting_for_osm"
            ? `OSM PBF not found at ${result.pbfPath}`
            : "Another rebuild owns the durable state",
    };
  }
  opts.onProgress?.(
    `Regional Overture refresh complete; conflation ${result.status} (${result.linked} links).`,
  );
  const retention = dependencies.pruneReleases({
    dataDir: opts.dataDir,
    activeRelease: release,
    retain: overtureReleaseRetentionFromEnv(process.env.OVERTURE_RELEASE_RETENTION),
    onProgress: opts.onProgress,
  });
  return { release, path, conflation: result.status, linked: result.linked, retention };
}
