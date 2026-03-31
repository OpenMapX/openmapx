import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MOTIS_DATA_DIR =
  process.env.MOTIS_DATA_DIR ?? join(process.cwd(), "../../infra/docker/data/motis");
const LICENSE_FILE = join(MOTIS_DATA_DIR, "license.json");

interface FeedEntry {
  country_code?: string;
  country_name?: string;
  human_name?: string;
  filename?: string;
  source?: string;
  spdx_license_identifier?: string;
  license_url?: string;
  publisher?: { name?: string; url?: string };
}

let cachedData: FeedEntry[] | null = null;
let cachedMtime = 0;

function loadAttribution(): FeedEntry[] {
  if (!existsSync(LICENSE_FILE)) return [];

  const mtime = statSync(LICENSE_FILE).mtimeMs;
  if (cachedData && mtime === cachedMtime) return cachedData;

  try {
    cachedData = JSON.parse(readFileSync(LICENSE_FILE, "utf-8"));
    cachedMtime = mtime;
    return cachedData ?? [];
  } catch {
    return [];
  }
}

/**
 * Build a provider attribution map from license.json keyed by feed tag.
 * Feed tags match the format MOTIS uses in its `source` field (e.g. "de_DELFI").
 */
export function getFeedProviders(): Record<
  string,
  { label: string; url: string; license?: string; licenseUrl?: string }
> {
  const feeds = loadAttribution();
  const result: Record<
    string,
    { label: string; url: string; license?: string; licenseUrl?: string }
  > = {};
  for (const feed of feeds) {
    if (!feed.filename) continue;
    // filename: "de_DELFI.gtfs.zip" → tag: "de_DELFI"
    const tag = feed.filename.replace(/\.(gtfs|netex)\.zip$/, "");
    if (!tag) continue;
    result[tag] = {
      label: feed.human_name ?? tag,
      url: feed.publisher?.url ?? feed.source ?? "",
      license: feed.spdx_license_identifier,
      licenseUrl: feed.license_url,
    };
  }
  return result;
}

/** @deprecated Attribution is now served by the transit-motis integration */
