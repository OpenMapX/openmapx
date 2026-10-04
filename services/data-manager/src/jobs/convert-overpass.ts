import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import type { StateStore } from "../state.js";

export interface ConvertOverpassOptions {
  /** Explicit input .osm.pbf path (absolute or relative to `dataDir`). */
  sourcePbf: string;
  /** Explicit output .osm.bz2 path. */
  targetBz2: string;
  /** Called every second with the current on-disk size of the output bz2. */
  onProgress?: (bytes: number) => void;
}

export async function convertPbfToBz2(opts: ConvertOverpassOptions): Promise<void> {
  mkdirSync(dirname(opts.targetBz2), { recursive: true });

  // Overpass wants bz2-compressed OSM XML (`planet.osm.bz2`). libosmium's bz2
  // writer is single-threaded and the encoder is the bottleneck (~1.5 MB/s of
  // output), so osmium writes plain XML to a pipe and lbzip2 compresses it on
  // every core. The result lands in a temporary file renamed over the target
  // only once both processes succeed, so a failed run never leaves a truncated
  // `data.osm.bz2` behind.
  const threads = Math.max(2, availableParallelism());
  const temporary = `${opts.targetBz2}.tmp`;
  const osmium = execa("osmium", ["cat", opts.sourcePbf, "-f", "osm", "-o", "-"], {
    stderr: "inherit",
  });
  const compressed = osmium.pipe("lbzip2", ["-n", String(threads), "-c"], {
    stdout: { file: temporary },
    stderr: "inherit",
  });

  const poll = opts.onProgress
    ? setInterval(() => {
        try {
          opts.onProgress?.(statSync(temporary).size);
        } catch {
          // tmp file not created yet
        }
      }, 1000)
    : null;

  try {
    await compressed;
    renameSync(temporary, opts.targetBz2);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    if (poll) clearInterval(poll);
  }
  if (opts.onProgress) {
    try {
      opts.onProgress(statSync(opts.targetBz2).size);
    } catch {
      // best effort
    }
  }
}

export interface ConvertOverpassForRegionOptions {
  /**
   * OSM region id (e.g. `europe/germany`, or `planet`). When absent, the
   * single most-recently-downloaded `osm-pbf` entry in the state store is
   * used. Throws if zero / multiple candidates exist without a region hint.
   */
  region?: string;
  dataDir: string;
  store: StateStore;
  onProgress?: (bytes: number, totalBytes?: number) => void;
}

export interface ConvertOverpassForRegionResult {
  sourcePbf: string;
  targetBz2: string;
  sizeBytes: number;
}

/**
 * Higher-level wrapper that picks the right source PBF from the state store
 * and writes to the canonical overpass location `<dataDir>/osm-bz2/data.osm.bz2`
 * (Overpass's init config is hard-coded to `file:///osm/data.osm.bz2`, so
 * there's no per-region naming on the output side).
 */
export async function convertPbfToBz2ForRegion(
  opts: ConvertOverpassForRegionOptions,
): Promise<ConvertOverpassForRegionResult> {
  const osmEntries = opts.store.getAll().filter((d) => d.type === "osm-pbf");
  if (osmEntries.length === 0) {
    throw new Error(
      "no osm-pbf downloads found — run `pnpm openmapx data download osm <region>` first",
    );
  }

  let picked = osmEntries[0];
  if (opts.region) {
    const match = osmEntries.find((d) => d.region === opts.region || d.id === opts.region);
    if (!match) {
      throw new Error(
        `no osm-pbf download for region "${opts.region}". ` +
          `Available: ${osmEntries.map((d) => d.region ?? d.id).join(", ")}`,
      );
    }
    picked = match;
  } else if (osmEntries.length > 1) {
    throw new Error(
      `multiple osm-pbf downloads are registered (${osmEntries
        .map((d) => d.region ?? d.id)
        .join(", ")}) — pass \`region\` to disambiguate which one to convert for Overpass`,
    );
  }

  if (!picked.path || !existsSync(picked.path)) {
    throw new Error(
      `osm-pbf entry for "${picked.region ?? picked.id}" references missing file ${picked.path}`,
    );
  }

  const targetDir = join(opts.dataDir, "osm-bz2");
  mkdirSync(targetDir, { recursive: true });
  const targetBz2 = join(targetDir, "data.osm.bz2");

  // No `totalBytes` hint: the bz2-compressed XML output is typically ~1.1×
  // the input PBF (PBF is more compact than bz2 XML), so the *input* size
  // makes a misleading progress target. Let the CLI fall back to its
  // unknown-total renderer (bytes + rate, no bar, no ETA).
  await convertPbfToBz2({
    sourcePbf: picked.path,
    targetBz2,
    onProgress: opts.onProgress ? (bytes) => opts.onProgress?.(bytes) : undefined,
  });

  const sizeBytes = statSync(targetBz2).size;
  opts.store.upsert({
    type: "osm-pbf-bz2",
    id: picked.region ?? picked.id,
    region: picked.region,
    sizeBytes,
    downloadedAt: new Date().toISOString(),
    path: targetBz2,
  });

  return { sourcePbf: picked.path, targetBz2, sizeBytes };
}
