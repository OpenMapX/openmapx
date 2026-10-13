import type { Attribution } from "@openmapx/mobility-core/attribution";
import { contributorsForRecords, snapshotContributors } from "@openmapx/mobility-core/contributors";
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
  const sourceId = Object.hasOwn(OVERTURE_PLACE_DATASET_SOURCE_IDS, normalized)
    ? OVERTURE_PLACE_DATASET_SOURCE_IDS[normalized]
    : undefined;
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

/** Overture JSON Pointer inheritance: a dedicated property source overrides
 * ancestors, including the whole-feature root. Catalogue snapshots are captured
 * by the trusted acquisition adapter; they are never a list of display credits.
 * https://docs.overturemaps.org/schema/reference/common/source_item/
 */
export function overturePropertyContributors(
  sources: readonly OvertureSourceItem[] | null | undefined,
  catalogue: readonly Attribution[],
  propertyPointers: Iterable<string>,
): Attribution[] {
  const ids = new Set<string>();
  let supplied = false;
  for (const pointer of propertyPointers) {
    supplied = true;
    const matching = (sources ?? []).filter(
      (source) =>
        typeof source.property === "string" &&
        (source.property === "" ||
          pointer === source.property ||
          pointer.startsWith(`${source.property}/`)),
    );
    const specificity = Math.max(-1, ...matching.map((source) => source.property?.length ?? -1));
    for (const source of matching) {
      if (source.property?.length !== specificity || !source.dataset?.trim()) continue;
      ids.add(overtureDatasetSourceId(source.dataset));
    }
  }
  if (!supplied) return [];
  ids.add("overture");
  return snapshotContributors(catalogue.filter((receipt) => ids.has(receipt.sourceId)));
}

/** Normalize producer property receipts onto the fields actually retained. */
export function captureOvertureFieldContributors<T extends object>(
  record: T,
  sources: readonly OvertureSourceItem[] | null | undefined,
  catalogue: readonly Attribution[],
  fieldPointers: Readonly<Record<string, readonly string[]>>,
): T & { contributors: Attribution[]; fieldContributors: Record<string, Attribution[]> } {
  const fieldContributors = Object.fromEntries(
    Object.entries(fieldPointers).map(([field, pointers]) => [
      field,
      overturePropertyContributors(sources, catalogue, pointers),
    ]),
  );
  return {
    ...record,
    fieldContributors,
    contributors: contributorsForRecords(
      Object.values(fieldContributors).map((contributors) => ({ contributors })),
    ),
  };
}

/** Choose the localized scalar and its exact upstream JSON Pointer together. */
export function selectOvertureName(
  names: { primary?: string; common?: Record<string, string> | null } | null,
  fallback: string,
  lang?: string,
): { name: string; variants?: Record<string, string>; property: string } {
  const common = names?.common ?? undefined;
  const requested = lang?.toLowerCase();
  const base = requested?.split("-")[0];
  const entries = Object.entries(common ?? {});
  const selected = requested
    ? (entries.find(([tag]) => tag.toLowerCase() === requested) ??
      entries.find(([tag]) => tag.toLowerCase() === base) ??
      entries.find(([tag]) => tag.toLowerCase().split("-")[0] === base))
    : undefined;
  const name = selected?.[1].trim() || names?.primary?.trim() || fallback;
  return {
    name,
    variants: common && entries.length > 0 ? common : undefined,
    property: selected?.[1].trim()
      ? `/names/common/${selected[0].replace(/~/g, "~0").replace(/\//g, "~1")}`
      : "/names/primary",
  };
}
