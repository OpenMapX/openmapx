/** A resolved link to a restaurant's menu. */
export interface RestaurantMenu {
  /** Absolute URL of the menu (HTML page or PDF). */
  menuUrl: string;
  /** How the link was found. `osm` = from an OSM `website:menu` tag (client-side). */
  source: "osm" | "jsonld" | "heuristic" | "pdf";
  format: "html" | "pdf";
}
