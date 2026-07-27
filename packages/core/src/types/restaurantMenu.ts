/** A resolved link to a restaurant's menu. */
export interface RestaurantMenu {
  /** Absolute URL of the menu (HTML page or PDF). */
  menuUrl: string;
  /** How the link was found. `osm` = from an OSM `website:menu` tag (client-side). */
  source: "osm" | "jsonld" | "heuristic" | "pdf";
  format: "html" | "pdf";
}

export interface RestaurantLinks {
  menuUrl?: string;
  source?: "jsonld" | "heuristic" | "pdf";
  format?: "html" | "pdf";
  /** Strongly signalled first-party online-order link from the same homepage crawl. */
  orderUrl?: string;
  /** Exact provider links explicitly exposed by the restaurant's own homepage. */
  providerOrderUrls?: string[];
}
