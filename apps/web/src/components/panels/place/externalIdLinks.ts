import { getIdSchemeView, type PlaceIds } from "@openmapx/core";

export interface ExternalRef {
  /** Canonical scheme key (e.g. "osm", "wikidata"). */
  scheme: string;
  /** Human-readable label from the registered view. */
  label: string;
  /** The identifier value (displayed to the user, copyable). */
  value: string;
  /** External URL if the scheme's view can build one — otherwise undefined. */
  url?: string;
}

/**
 * Turn a {@link PlaceIds} map into an ordered list of user-visible external
 * references. Each scheme is looked up in the core presentation registry
 * (`registerIdSchemeView`); internal schemes, empty values, and schemes
 * without an explicit registration are dropped. Appearing in the user-
 * facing cross-reference list requires an opt-in — per-provider dispatch
 * schemes (transit providers, data-source item ids) are not cross-refs
 * and shouldn't be shown.
 */
export function buildExternalRefs(ids: PlaceIds | undefined): ExternalRef[] {
  if (!ids) return [];

  type Entry = {
    scheme: string;
    value: string;
    order: number;
    insertionIndex: number;
    label: string;
    url: string | undefined;
  };
  const entries: Entry[] = [];
  let insertionIndex = 0;

  for (const [scheme, value] of Object.entries(ids)) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const view = getIdSchemeView(scheme);
    if (!view || view.internal) continue;
    entries.push({
      scheme,
      value,
      order: view.displayOrder ?? Number.POSITIVE_INFINITY,
      insertionIndex: insertionIndex++,
      label: view.label,
      url: view.buildUrl?.(value),
    });
  }

  entries.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.insertionIndex - b.insertionIndex;
  });

  return entries.map(({ scheme, value, label, url }) => ({ scheme, value, label, url }));
}
