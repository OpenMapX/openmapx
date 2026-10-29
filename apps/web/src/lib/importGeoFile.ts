"use client";

import { useImportedGeometryStore } from "@openmapx/core";
import {
  parseSavedPlaceContributors,
  savedPlaceContributors,
} from "@openmapx/core/saved-place-contributors";
import { withFeatureContributors } from "@openmapx/mobility-core/contributors";
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

/** Imported display receipts are projected from the closed saved-field contract only.
 * Names/addresses are not rendered by this overlay. Ignore arbitrary serialized map owners.
 */
function importedFeature(feature: GeoJSON.Feature): GeoJSON.Feature {
  const {
    _mapAttributions: _untrusted,
    fieldContributors: raw,
    ...properties
  } = feature.properties ?? {};
  const captured = parseSavedPlaceContributors(raw);
  const clean = {
    ...feature,
    properties: {
      ...properties,
      ...(captured === undefined ? {} : { fieldContributors: captured }),
    },
  };
  return withFeatureContributors(clean, savedPlaceContributors(captured, ["lat", "lng"]));
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
      return fc && fc.features.length > 0
        ? { ...fc, features: fc.features.map(importedFeature) }
        : null;
    }
    if (lower.endsWith(".gpx") || lower.endsWith(".kml")) {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      if (doc.querySelector("parsererror")) return null;
      const parsed = lower.endsWith(".gpx") ? gpx(doc) : kml(doc);
      // togeojson can emit features with null geometry — drop them.
      const features = parsed.features.filter((f): f is GeoJSON.Feature => f.geometry != null);
      if (lower.endsWith(".gpx")) {
        // togeojson intentionally drops custom GPX extensions. Recover only our namespaced
        // waypoint capture, matched by geometry and name rather than converter output order.
        const waypoints = Array.from(
          doc.getElementsByTagNameNS("http://www.topografix.com/GPX/1/1", "wpt"),
        );
        const candidates = waypoints.map((wpt) => ({
          lat: Number(wpt.getAttribute("lat")),
          lng: Number(wpt.getAttribute("lon")),
          name: wpt.getElementsByTagNameNS("http://www.topografix.com/GPX/1/1", "name")[0]
            ?.textContent,
          capture: wpt.getElementsByTagNameNS(
            "https://openmapx.org/ns/saved-place/1",
            "fieldContributors",
          )[0]?.textContent,
        }));
        for (const feature of features) {
          if (feature.geometry.type !== "Point") continue;
          const index = candidates.findIndex(
            (wpt) =>
              wpt.lng === (feature.geometry as GeoJSON.Point).coordinates[0] &&
              wpt.lat === (feature.geometry as GeoJSON.Point).coordinates[1] &&
              (wpt.name ?? "") === (feature.properties?.name ?? ""),
          );
          if (index < 0) continue;
          const [wpt] = candidates.splice(index, 1);
          if (wpt.capture !== undefined)
            feature.properties = { ...feature.properties, fieldContributors: wpt.capture };
        }
      }
      return features.length > 0
        ? { type: "FeatureCollection", features: features.map(importedFeature) }
        : null;
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
