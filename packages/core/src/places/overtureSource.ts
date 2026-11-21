import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  contributorsForRecords,
  parseContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
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

/**
 * A captured Overture source catalogue that every reader can credit: a receipt
 * array accepted by the shared contributor parser that names Overture itself,
 * which credits each place's GERS identity. Anything else is `undefined`.
 */
export function parseOvertureSourceCatalogue(value: unknown): Attribution[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const catalogue = parseContributors(value);
  return catalogue?.some((receipt) => receipt.sourceId === "overture") ? catalogue : undefined;
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

export interface OvertureAddressItem {
  freeform?: string | null;
  locality?: string | null;
  postcode?: string | null;
  region?: string | null;
  country?: string | null;
}

function isDroppedControlOrBidi(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/**
 * Cleans an upstream Overture string by converting line/tab separators to
 * spaces, dropping other C0/C1 control characters and Unicode bidi marks, and
 * collapsing surrounding/repeated whitespace. Returns undefined when blank.
 */
export function cleanOvertureString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  let cleaned = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x2028 || cp === 0x2029) {
      cleaned += " ";
      continue;
    }
    if (isDroppedControlOrBidi(cp)) continue;
    cleaned += ch;
  }
  const normalized = cleaned.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

/** Picks the first non-empty cleaned string alongside its original JSON Pointer. */
export function selectFirstOvertureString(
  values: readonly (string | null | undefined)[] | null | undefined,
  pointerPrefix: string,
): { value: string; pointer: string } | undefined {
  if (!values) return undefined;
  for (let index = 0; index < values.length; index++) {
    const cleaned = cleanOvertureString(values[index]);
    if (cleaned !== undefined) return { value: cleaned, pointer: `${pointerPrefix}/${index}` };
  }
  return undefined;
}

/** Cleans all non-empty entries while retaining each item's original JSON Pointer. */
export function selectOvertureStrings(
  values: readonly (string | null | undefined)[] | null | undefined,
  pointerPrefix: string,
): { values: string[]; pointers: string[] } | undefined {
  if (!values) return undefined;
  const cleanedValues: string[] = [];
  const pointers: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const cleaned = cleanOvertureString(values[index]);
    if (cleaned === undefined) continue;
    cleanedValues.push(cleaned);
    pointers.push(`${pointerPrefix}/${index}`);
  }
  return cleanedValues.length > 0 ? { values: cleanedValues, pointers } : undefined;
}

/** Normalizes the primary Overture address and returns exact upstream JSON Pointers. */
export function selectOvertureAddress(
  addresses: readonly OvertureAddressItem[] | null | undefined,
): {
  address?: string;
  city?: string;
  countryCode?: string;
  pointers: { address?: string[]; city?: string[]; countryCode?: string[] };
} {
  const value = addresses?.[0];
  if (!value) return { pointers: {} };
  const freeform = cleanOvertureString(value.freeform);
  const locality = cleanOvertureString(value.locality);
  const postcode = cleanOvertureString(value.postcode);
  const country = cleanOvertureString(value.country);
  const localityLine = [postcode, locality].filter(Boolean).join(" ");
  const includeLocalityLine =
    localityLine.length > 0 &&
    !freeform?.toLocaleLowerCase().includes(localityLine.toLocaleLowerCase());
  const address =
    [freeform, includeLocalityLine ? localityLine : undefined].filter(Boolean).join(", ") ||
    undefined;
  const addressPointers: string[] = [];
  if (freeform) addressPointers.push("/addresses/0/freeform");
  if (includeLocalityLine) {
    if (postcode) addressPointers.push("/addresses/0/postcode");
    if (locality) addressPointers.push("/addresses/0/locality");
  }
  const countryCode = country?.toLowerCase() || undefined;
  return {
    address,
    city: locality,
    countryCode,
    pointers: {
      ...(address ? { address: addressPointers } : {}),
      ...(locality ? { city: ["/addresses/0/locality"] } : {}),
      ...(countryCode ? { countryCode: ["/addresses/0/country"] } : {}),
    },
  };
}

/** Choose the localized scalar and its exact upstream JSON Pointer together. */
export function selectOvertureName(
  names: { primary?: string; common?: Record<string, string> | null } | null,
  fallback: string,
  lang?: string,
): { name: string; variants?: Record<string, string>; property: string } {
  const cleanedEntries: Array<[string, string]> = [];
  for (const [tag, raw] of Object.entries(names?.common ?? {})) {
    const cleaned = cleanOvertureString(raw);
    if (cleaned !== undefined) cleanedEntries.push([tag, cleaned]);
  }
  const requested = lang?.toLowerCase();
  const base = requested?.split("-")[0];
  const selected = requested
    ? (cleanedEntries.find(([tag]) => tag.toLowerCase() === requested) ??
      cleanedEntries.find(([tag]) => tag.toLowerCase() === base) ??
      cleanedEntries.find(([tag]) => tag.toLowerCase().split("-")[0] === base))
    : undefined;
  const primary = cleanOvertureString(names?.primary);
  const name = selected?.[1] || primary || cleanOvertureString(fallback) || "";
  return {
    name,
    variants: cleanedEntries.length > 0 ? Object.fromEntries(cleanedEntries) : undefined,
    property: selected
      ? `/names/common/${selected[0].replace(/~/g, "~0").replace(/\//g, "~1")}`
      : "/names/primary",
  };
}
