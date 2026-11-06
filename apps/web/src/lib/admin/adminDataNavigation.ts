/** Specialized maintenance retains ownership of recovery phases and publication controls. */
export const OSM_OPERATION_IDS = ["download-osm", "download-fonts", "convert-overpass"] as const;
export const ADVANCED_OPERATION_IDS = ["update", "link", "clean"] as const;
export function adminDataOperationHref(id: string) {
  const topic = id.startsWith("overture-")
    ? "overture"
    : ["search-index-build", "notable-places-build"].includes(id)
      ? "search"
      : (OSM_OPERATION_IDS as readonly string[]).includes(id)
        ? "osm"
        : "operations";
  return `/admin/data/${topic}#operation-${encodeURIComponent(id)}`;
}
