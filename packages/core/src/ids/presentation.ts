/**
 * Registry of per-scheme display concerns — labels and URL builders used
 * to render `Place.ids` entries to the user. Integrations register the
 * schemes they produce so adding a new scheme doesn't require editing any
 * central file.
 *
 * Resolution order in UI is: `displayOrder` ascending, then insertion
 * order for anything without an explicit number.
 */

export interface IdSchemeView {
  /** Scheme key in `Place.ids` (e.g. `"osm"`, `"yelp"`, `"ocm"`). */
  scheme: string;
  /** Human-readable label (e.g. `"OSM"`, `"Open Charge Map"`). */
  label: string;
  /**
   * When true, the scheme is considered an implementation detail and
   * should be hidden from user-facing lists (coordinate fallbacks,
   * synthetic `saved`/`label`/`streetView` handles, etc.).
   */
  internal?: boolean;
  /** Lower sorts earlier. Unspecified = sorts after numbered entries in insertion order. */
  displayOrder?: number;
  /**
   * Return an external URL for a given id value, or `undefined` if the
   * scheme isn't naturally linkable (e.g. a raw EVA number). Accepts the
   * raw id value (without the `scheme:` prefix).
   */
  buildUrl?(value: string): string | undefined;
}

const registry = new Map<string, IdSchemeView>();

/**
 * Register or overwrite the view for a scheme. Idempotent — calling twice
 * with the same scheme replaces the previous entry (so integrations can
 * re-register on hot reload).
 */
export function registerIdSchemeView(view: IdSchemeView): void {
  registry.set(view.scheme, view);
}

/** Look up the registered view for a scheme, or `undefined` if none. */
export function getIdSchemeView(scheme: string): IdSchemeView | undefined {
  return registry.get(scheme);
}

/**
 * Return all registered views. Order: entries with `displayOrder` ascend,
 * then unnumbered entries in insertion order.
 */
export function listIdSchemeViews(): IdSchemeView[] {
  const all = Array.from(registry.values());
  const numbered: IdSchemeView[] = [];
  const unnumbered: IdSchemeView[] = [];
  for (const v of all) {
    if (typeof v.displayOrder === "number") numbered.push(v);
    else unnumbered.push(v);
  }
  numbered.sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  return [...numbered, ...unnumbered];
}
