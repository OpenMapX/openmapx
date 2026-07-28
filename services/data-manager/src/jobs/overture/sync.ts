import { existsSync } from "node:fs";
import { join } from "node:path";
import { osmPbfName } from "../download-osm.js";
import { conflateOverture } from "./conflate.js";
import { extractOsmPois } from "./extract-osm-pois.js";
import { ingestOverture } from "./ingest.js";
import { assertValidRegion, pullOverture, resolveOvertureRelease } from "./pull.js";

export interface SyncOvertureRegionOptions {
  region: string;
  dataDir: string;
  release?: string;
  onProgress?: (msg: string) => void;
}

export interface SyncOvertureRegionResult {
  release: string;
  path: string;
  conflation: "completed" | "skipped";
  linked: number;
}

interface SyncOvertureDependencies {
  pull: typeof pullOverture;
  ingest: typeof ingestOverture;
  extract: typeof extractOsmPois;
  conflate: typeof conflateOverture;
  fileExists: typeof existsSync;
}

const defaultDependencies: SyncOvertureDependencies = {
  pull: pullOverture,
  ingest: ingestOverture,
  extract: extractOsmPois,
  conflate: conflateOverture,
  fileExists: existsSync,
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
  assertValidRegion(opts.region);
  const release = await resolveOvertureRelease(opts.release);
  opts.onProgress?.(`Starting atomic regional Overture refresh for ${release}…`);
  const path = await dependencies.pull({ ...opts, release });
  await dependencies.ingest({ ...opts, release });

  const pbfPath = join(opts.dataDir, "osm", osmPbfName(opts.region));
  if (!dependencies.fileExists(pbfPath)) {
    opts.onProgress?.(
      `OSM PBF not found at ${pbfPath}; skipping optional OSM↔Overture link rebuild.`,
    );
    return { release, path, conflation: "skipped", linked: 0 };
  }

  opts.onProgress?.("Rebuilding OSM↔Overture links from the regional OSM extract…");
  await dependencies.extract({ ...opts, pbfPath });
  const result = await dependencies.conflate({
    region: opts.region,
    release,
    onProgress: opts.onProgress,
  });
  opts.onProgress?.(`Regional Overture refresh complete: ${result.linked} links.`);
  return { release, path, conflation: "completed", linked: result.linked };
}
