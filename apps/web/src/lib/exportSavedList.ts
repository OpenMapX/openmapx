"use client";

import { apiUrl } from "@openmapx/core";

export type ExportFormat = "gpx" | "geojson" | "kml";

/** Extensions the export menu offers (mirrors IMPORT_ACCEPT's trio). */
export const EXPORT_FORMATS: ExportFormat[] = ["gpx", "geojson", "kml"];

/**
 * Fetch a saved list's export from the API (cookie-authenticated) and trigger a
 * browser download. `filename` is the user-facing download name. Throws on a
 * non-OK response so the caller can surface an error.
 */
export async function exportSavedList(
  listId: string,
  format: ExportFormat,
  filename: string,
): Promise<void> {
  const url = apiUrl(`/api/saved/lists/${encodeURIComponent(listId)}/export`, { format });
  const res = await fetch(url, { credentials: "include", headers: { Accept: "*/*" } });
  if (!res.ok) {
    throw new Error(`Export failed: ${res.status}`);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}
