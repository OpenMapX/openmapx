"use client";

import { useImportedGeometryStore } from "@openmapx/core";
import { gpx, kml } from "@tmcw/togeojson";

/** Extensions the importer (and the manifest file_handlers) accept. */
export const IMPORT_ACCEPT = ".gpx,.geojson,.json,.kml";

function toFeatureCollection(data: unknown): GeoJSON.FeatureCollection | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as { type?: unknown; features?: unknown };
  if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
    return data as GeoJSON.FeatureCollection;
  }
  if (obj.type === "Feature") {
    return { type: "FeatureCollection", features: [data as GeoJSON.Feature] };
  }
  // Bare geometry (Point/LineString/Polygon/…).
  if (typeof obj.type === "string") {
    return {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: data as GeoJSON.Geometry }],
    };
  }
  return null;
}

/**
 * Parse a GeoJSON / GPX / KML file's text into a FeatureCollection. Returns null
 * for unsupported extensions, malformed XML/JSON, or empty results.
 */
export function parseGeoFile(filename: string, text: string): GeoJSON.FeatureCollection | null {
  const lower = filename.toLowerCase();
  try {
    if (lower.endsWith(".geojson") || lower.endsWith(".json")) {
      const fc = toFeatureCollection(JSON.parse(text));
      return fc && fc.features.length > 0 ? fc : null;
    }
    if (lower.endsWith(".gpx") || lower.endsWith(".kml")) {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      if (doc.querySelector("parsererror")) return null;
      const parsed = lower.endsWith(".gpx") ? gpx(doc) : kml(doc);
      // togeojson can emit features with null geometry — drop them.
      const features = parsed.features.filter((f): f is GeoJSON.Feature => f.geometry != null);
      return features.length > 0 ? { type: "FeatureCollection", features } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Read + parse a File and, on success, push it onto the imported-geometry store
 * so the map draws it. Returns false when the file couldn't be parsed.
 */
export async function importGeoFromFile(file: File): Promise<boolean> {
  try {
    const text = await file.text();
    const geojson = parseGeoFile(file.name, text);
    if (!geojson) return false;
    useImportedGeometryStore.getState().setImported({ name: file.name, geojson });
    return true;
  } catch {
    return false;
  }
}
