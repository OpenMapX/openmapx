"use client";

/** Filesystem-safe name carrying the departure instant the artifact was computed for. */
export function transitIsochroneFilename(queryTime: string): string {
  const stamp = queryTime.replace(/[:.]/g, "-").replace(/Z$/, "");
  return `transit-isochrone-${stamp}.geojson`;
}

/**
 * Serialise an already-fetched isochrone FeatureCollection to a download.
 *
 * The collection is the one the client already holds, so exporting never
 * triggers a second sampling run. It carries its own `openmapx` provenance
 * member, which is what keeps the saved file honest about its sampling
 * resolution, accuracy, and attribution once it leaves the app.
 */
export function exportTransitIsochrone(
  collection: GeoJSON.FeatureCollection,
  filename: string,
): void {
  const blob = new Blob([JSON.stringify(collection, null, 2)], {
    type: "application/geo+json",
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}
