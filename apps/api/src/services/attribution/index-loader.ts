import { existsSync, readFileSync, statSync } from "node:fs";
import type { Logger } from "@openmapx/integration-framework";
import type { ManifestDataSource, MotisLicenseEntry, ResolvedAttribution } from "./types.js";

export interface LoadResult {
  bySourceId: Map<string, ResolvedAttribution>;
  byMotisFilename: Map<string, ResolvedAttribution>;
  /** ISO 8601 timestamp of the load. */
  loadedAt: string;
  /** mtime in ms of the MOTIS license.json file, when present. */
  motisLicenseMtime?: number;
}

/** Strip MOTIS feed-extension suffix, returning the bare feed tag. */
function feedTagFromFilename(filename: string): string {
  return filename.replace(/\.(gtfs|netex)\.zip$/i, "");
}

/** Build a ResolvedAttribution row from a MOTIS license.json entry. */
function resolveMotisEntry(entry: MotisLicenseEntry): ResolvedAttribution {
  const tag = feedTagFromFilename(entry.filename);
  const publisher = entry.publisher
    ? { name: entry.publisher.name ?? tag, url: entry.publisher.url }
    : undefined;
  return {
    sourceId: tag,
    name: entry.human_name ?? tag,
    url: entry.publisher?.url ?? entry.source,
    spdxLicense: entry.spdx_license_identifier,
    licenseUrl: entry.license_url,
    attributionText: entry.attribution_text,
    publisher,
    source: "motis-license",
    raw: entry,
  };
}

/** Build a ResolvedAttribution row from an integration manifest dataSources entry. */
function resolveManifestEntry(ds: ManifestDataSource): ResolvedAttribution {
  return {
    sourceId: ds.sourceId,
    name: ds.name,
    url: ds.url,
    spdxLicense: undefined,
    licenseUrl: ds.licenseUrl,
    attributionText: ds.attribution,
    source: "integration-manifest",
    raw: ds,
  };
}

interface LoaderLogger {
  warn: Logger["warn"];
  info: Logger["info"];
}

export interface LoadAttributionIndexOpts {
  /** Absolute path to MOTIS license.json. */
  motisLicenseFile?: string;
  /** Pre-resolved manifest dataSources (the loader does not read manifests itself). */
  integrationManifests?: ManifestDataSource[];
  log: LoaderLogger;
}

/**
 * Read MOTIS license.json + integration manifest dataSources and build the
 * sourceId → ResolvedAttribution map. Doesn't cache — that's the index's job.
 *
 * Precedence on sourceId collision: integration-manifest entries replace
 * motis-license entries, because manifests are the more-curated source.
 */
export async function loadAttributionIndex(opts: LoadAttributionIndexOpts): Promise<LoadResult> {
  const { motisLicenseFile, integrationManifests, log } = opts;

  const bySourceId = new Map<string, ResolvedAttribution>();
  const byMotisFilename = new Map<string, ResolvedAttribution>();
  let motisLicenseMtime: number | undefined;

  if (motisLicenseFile && existsSync(motisLicenseFile)) {
    try {
      motisLicenseMtime = statSync(motisLicenseFile).mtimeMs;
      const raw = JSON.parse(readFileSync(motisLicenseFile, "utf-8")) as unknown;
      const entries = Array.isArray(raw) ? (raw as MotisLicenseEntry[]) : [];
      for (const entry of entries) {
        if (!entry?.filename) continue;
        const resolved = resolveMotisEntry(entry);
        if (!resolved.sourceId) continue;
        bySourceId.set(resolved.sourceId, resolved);
        byMotisFilename.set(entry.filename, resolved);
      }
      log.info(
        `[attribution-index] loaded ${entries.length} MOTIS license entries from ${motisLicenseFile}`,
      );
    } catch (err) {
      log.warn(
        `[attribution-index] failed to read MOTIS license.json at ${motisLicenseFile}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else if (motisLicenseFile) {
    log.warn(
      `[attribution-index] MOTIS license.json not found at ${motisLicenseFile} — feed-level attribution will fall back`,
    );
  }

  if (integrationManifests) {
    for (const ds of integrationManifests) {
      if (!ds?.sourceId) continue;
      // Integration manifest wins over MOTIS entry on collision.
      bySourceId.set(ds.sourceId, resolveManifestEntry(ds));
    }
  }

  return {
    bySourceId,
    byMotisFilename,
    loadedAt: new Date().toISOString(),
    motisLicenseMtime,
  };
}

export const __testing = {
  feedTagFromFilename,
  resolveMotisEntry,
  resolveManifestEntry,
};
