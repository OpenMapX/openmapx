import type { PlaceProvenance } from "../types/place";

export interface OvertureSourceItem {
  property?: string | null;
  dataset?: string | null;
  license?: string | null;
  record_id?: string | null;
  update_time?: string | null;
}

/** Maps current upstream dataset names to manifest source ids without losing unknown names. */
export function overtureDatasetSourceId(dataset: string): string {
  const normalized = dataset.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.includes("foursquare")) return "foursquare";
  if (normalized.includes("alltheplaces")) return "alltheplaces";
  if (normalized.includes("brightquery")) return "brightquery";
  if (normalized.includes("microsoft")) return "microsoft-places";
  if (normalized.includes("pinmeto")) return "pinmeto";
  if (normalized.includes("renderseo")) return "renderseo";
  if (normalized === "dac" || normalized.includes("dacgroup")) return "dac";
  if (normalized.includes("krick")) return "krick";
  if (normalized === "meta" || normalized.includes("metaplaces")) return "meta-places";
  return "overture";
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
