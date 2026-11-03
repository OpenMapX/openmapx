import { CATEGORY_DEFINITIONS, type CategoryId } from "@openmapx/core";

// MUI LocalGasStation glyph — fuel isn't a poi-search chip category, so we carry
// its icon here and query it via the `preset:amenity/fuel` server path.
const FUEL_ICON_PATH =
  "M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h9v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77M12 10H6V5h6z";

// MUI EvStation glyph — `ev_charging` is a search category without a chip
// definition, so it has no icon of its own there.
const CHARGING_ICON_PATH =
  "m19.77 7.23.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77M18 10c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1M8 18v-4.5H6L10 6v5h2z";

/**
 * MUI Place glyph — the along-route pin icon for a brand search, which (unlike
 * a category) has no single glyph of its own.
 */
export const PLACE_ICON_PATH =
  "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7m0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5";

function iconFor(id: CategoryId): string {
  return CATEGORY_DEFINITIONS.find((d) => d.id === id)?.iconPath ?? "";
}

export interface RouteSearchCategory {
  /** A `CategoryId`, or `preset:<id>`, as the category search accepts it. */
  key: string;
  /** Message key in the `navigation` namespace. */
  labelKey: string;
  iconPath: string;
}

/** The stop kinds both along-route searches offer, in display order. */
export const ROUTE_SEARCH_CATEGORIES: readonly RouteSearchCategory[] = [
  { key: "preset:amenity/fuel", labelKey: "rsFuel", iconPath: FUEL_ICON_PATH },
  { key: "ev_charging", labelKey: "rsCharging", iconPath: CHARGING_ICON_PATH },
  { key: "restaurants", labelKey: "rsRestaurants", iconPath: iconFor("restaurants") },
  { key: "cafes", labelKey: "rsCafes", iconPath: iconFor("cafes") },
  { key: "supermarkets", labelKey: "rsSupermarkets", iconPath: iconFor("supermarkets") },
  { key: "parking", labelKey: "rsParking", iconPath: iconFor("parking") },
  { key: "hotels", labelKey: "rsHotels", iconPath: iconFor("hotels") },
];

export function RouteSearchGlyph({ path, size = 24 }: { path: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}
