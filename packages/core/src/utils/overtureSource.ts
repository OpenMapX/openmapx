import type { PlaceProvenance } from "../types/place";

/**
 * Overture Places contributors represented by OpenMapX manifest data sources.
 *
 * Keep this list exact and deliberately closed: an upstream contributor must
 * not silently inherit the generic Overture attribution. Release activation
 * validates every observed `sources[].dataset` against this map.
 */
export const OVERTURE_PLACE_DATASET_SOURCE_IDS = {
  alltheplaces: "alltheplaces",
  brightquery: "brightquery",
  dac: "dac",
  foursquare: "foursquare",
  krick: "krick",
  meta: "meta-places",
  microsoft: "microsoft-places",
  overture: "overture",
  pinmeto: "pinmeto",
  renderseo: "renderseo",
} as const;

export type OverturePlaceDataset = keyof typeof OVERTURE_PLACE_DATASET_SOURCE_IDS;

function normalizeDatasetName(dataset: string): string {
  return dataset
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export interface OvertureSourceItem {
  property?: string | null;
  dataset?: string | null;
  license?: string | null;
  record_id?: string | null;
  update_time?: string | null;
}

/** Maps a current upstream dataset name to its manifest source id. */
export function overtureDatasetSourceId(dataset: string): string {
  const normalized = normalizeDatasetName(dataset) as OverturePlaceDataset;
  const sourceId = OVERTURE_PLACE_DATASET_SOURCE_IDS[normalized];
  if (!sourceId) {
    throw new Error(
      `Unsupported Overture Places contributor "${dataset}". ` +
        "Add its required attribution before activating this release.",
    );
  }
  return sourceId;
}

/** Fails closed when a release contains an unrepresented contributor. */
export function assertSupportedOvertureContributors(datasets: Iterable<string>): void {
  const unsupported = [...new Set(datasets)]
    .filter((dataset) => {
      try {
        overtureDatasetSourceId(dataset);
        return false;
      } catch {
        return true;
      }
    })
    .sort((a, b) => a.localeCompare(b));

  if (unsupported.length > 0) {
    throw new Error(
      `Overture Places release contains unsupported contributor dataset(s): ${unsupported.join(", ")}. ` +
        "Add manifest attribution and the dataset mapping before activation.",
    );
  }
}

export function normalizeOvertureProvenance(
  sources: OvertureSourceItem[] | null | undefined,
  release?: string | null,
): PlaceProvenance[] {
  const normalized: PlaceProvenance[] = [
    { sourceId: "overture", dataset: "Overture Maps", release: release ?? undefined },
  ];
  const seen = new Set(["overture|Overture Maps||"]);
  for (const source of sources ?? []) {
    const dataset = source.dataset?.trim();
    if (!dataset) continue;
    const sourceId = overtureDatasetSourceId(dataset);
    const property = source.property?.trim() || undefined;
    const recordId = source.record_id?.trim() || undefined;
    const key = `${sourceId}|${dataset}|${property ?? ""}|${recordId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      sourceId,
      dataset,
      property,
      recordId,
      updatedAt: source.update_time ?? undefined,
      license: source.license ?? undefined,
      release: release ?? undefined,
    });
  }
  return normalized;
}
