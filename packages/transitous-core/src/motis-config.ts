import { load as parseYaml } from "js-yaml";

export interface MotisConfigExpectations {
  timetableDatasets: number;
  realtimeFeeds: number;
  gbfsFeeds: number;
  expectsGbfs: boolean;
  tilesEnabled: boolean;
  elevationEnabled: boolean;
  routedTransfersEnabled: boolean;
  gbfsProxyUrl: string | null;
  feedProxyUrls: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function countRealtimeFeeds(datasets: Record<string, unknown>): number {
  let count = 0;
  for (const dataset of Object.values(datasets)) {
    const rt = asRecord(dataset).rt;
    if (Array.isArray(rt)) count += rt.length;
    else if (isRecord(rt)) count += Object.keys(rt).length;
  }
  return count;
}

/** Decode the stable MOTIS config features used by candidates, health and admin. */
export function parseMotisConfigExpectations(configText: string): MotisConfigExpectations {
  const parsed = parseYaml(configText);
  if (!isRecord(parsed)) throw new Error("MOTIS config must decode to a YAML object");
  const timetable = asRecord(parsed.timetable);
  const datasets = asRecord(timetable.datasets);
  const gbfs = asRecord(parsed.gbfs);
  const gbfsFeeds = asRecord(gbfs.feeds);
  const elevation = parsed.elevation ?? parsed.elevation_data ?? parsed.elevation_tiles;
  const feedProxyUrls: string[] = [];
  for (const dataset of Object.values(datasets)) {
    const rt = asRecord(dataset).rt;
    const values = Array.isArray(rt) ? rt : Object.values(asRecord(rt));
    for (const feed of values) {
      const url = asRecord(feed).url;
      if (typeof url === "string" && url.includes("/feed/")) feedProxyUrls.push(url);
    }
  }
  return {
    timetableDatasets: Object.keys(datasets).length,
    realtimeFeeds: countRealtimeFeeds(datasets),
    gbfsFeeds: Object.keys(gbfsFeeds).length,
    expectsGbfs: Object.keys(gbfsFeeds).length > 0,
    tilesEnabled: parsed.tiles !== undefined && parsed.tiles !== false,
    elevationEnabled: elevation !== undefined && elevation !== false,
    routedTransfersEnabled: parsed.osr_footpath === true || parsed.routed_transfers === true,
    gbfsProxyUrl: typeof gbfs.proxy === "string" ? gbfs.proxy : null,
    feedProxyUrls: feedProxyUrls.sort(),
  };
}
