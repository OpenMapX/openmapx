import type { FeatureCollection } from "geojson";
import {
  parseSavedPlaceContributors,
  type SavedPlaceFieldContributors,
} from "./saved-place-contributors";
import {
  describeSavedPlace,
  SAVED_PLACE_XML_NAMESPACE,
  savedPlaceAttribution,
} from "./saved-place-description";

/**
 * Pure converters that turn saved places into the three file formats the app
 * already imports (GeoJSON / GPX / KML). These are deliberately pure
 * and side-effect-free: they take an {@link ExportPlace}[] and return a string
 * (GPX/KML) or a plain object (GeoJSON), so they can be unit-tested without a
 * Fastify request or a database, and reused from any future export route.
 *
 * Coordinate order is the classic trap and differs per format:
 *  - GeoJSON Point: `[lng, lat]`
 *  - GPX waypoint:  `<wpt lat="…" lon="…">`
 *  - KML Point:     `<coordinates>lng,lat</coordinates>`
 */

/**
 * The minimal shape of a place we can export. Modeled on the `saved_place`
 * table columns: name/lat/lng are NOT NULL, the rest are nullable. `note` is
 * singular (matches the column name) and maps onto the description element in
 * GPX/KML.
 */
export interface ExportPlace {
  name: string;
  lat: number;
  lng: number;
  address?: string | null;
  note?: string | null;
  placeId?: string | null;
  fieldContributors?: SavedPlaceFieldContributors;
}

/** Escape the five XML predefined entities for use in element text and attributes. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function captureForPlace(place: ExportPlace) {
  return parseSavedPlaceContributors(place.fieldContributors);
}

/**
 * Serialize places to a GeoJSON FeatureCollection (as a plain object — the
 * caller stringifies). An empty input yields a valid empty FeatureCollection.
 * Point coordinates are `[lng, lat]`.
 */
export function placesToGeoJson(places: ExportPlace[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: places.map((place) => {
      const properties: Record<string, unknown> = { name: place.name };
      if (place.address) properties.address = place.address;
      if (place.note) properties.note = place.note;
      if (place.placeId) properties.placeId = place.placeId;
      const capture = captureForPlace(place);
      if (capture !== undefined) properties.fieldContributors = capture;
      const attribution = savedPlaceAttribution(place);
      if (attribution.length) properties.attribution = attribution;
      return {
        type: "Feature",
        properties,
        geometry: { type: "Point", coordinates: [place.lng, place.lat] },
      };
    }),
  };
}

/**
 * Serialize places to a GPX 1.1 document string. Each place becomes a
 * `<wpt lat lon>` with `<name>` and (when present) `<desc>`. An empty input
 * yields a valid `<gpx>` with no waypoints.
 */
export function placesToGpx(places: ExportPlace[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="OpenMapX" xmlns="http://www.topografix.com/GPX/1/1" xmlns:omx="${SAVED_PLACE_XML_NAMESPACE}">`,
  ];
  for (const place of places) {
    lines.push(`  <wpt lat="${place.lat}" lon="${place.lng}">`);
    lines.push(`    <name>${escapeXml(place.name)}</name>`);
    const desc = describeSavedPlace(place);
    if (desc) lines.push(`    <desc>${escapeXml(desc)}</desc>`);
    for (const link of savedPlaceAttribution(place).flatMap((notice) => notice.links)) {
      lines.push(
        `    <link href="${escapeXml(link.url)}"><text>${escapeXml(link.label)}</text></link>`,
      );
    }
    const capture = captureForPlace(place);
    if (capture !== undefined || place.address) {
      lines.push("    <extensions>");
      if (place.address) lines.push(`      <omx:address>${escapeXml(place.address)}</omx:address>`);
      if (capture !== undefined)
        lines.push(
          `      <omx:fieldContributors>${escapeXml(JSON.stringify(capture))}</omx:fieldContributors>`,
        );
      lines.push("    </extensions>");
    }
    lines.push("  </wpt>");
  }
  lines.push("</gpx>");
  return `${lines.join("\n")}\n`;
}

/**
 * Serialize places to a KML 2.2 document string. Each place becomes a
 * `<Placemark>` with `<name>`, optional `<description>`, and a `<Point>` whose
 * `<coordinates>` are `lng,lat`. An empty input yields a valid `<kml><Document>`
 * with no placemarks.
 */
export function placesToKml(places: ExportPlace[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    "  <Document>",
  ];
  for (const place of places) {
    lines.push("    <Placemark>");
    lines.push(`      <name>${escapeXml(place.name)}</name>`);
    if (place.address) lines.push(`      <address>${escapeXml(place.address)}</address>`);
    const desc = describeSavedPlace(place);
    // KML viewers interpret descriptions as HTML after XML entity decoding.
    // Escape both layers so required plain notices and user notes remain inert text.
    if (desc) lines.push(`      <description>${escapeXml(escapeXml(desc))}</description>`);
    const capture = captureForPlace(place);
    lines.push('      <ExtendedData><Data name="openmapx:savedPlace"><value>1</value></Data>');
    if (capture !== undefined)
      lines.push(
        `        <Data name="fieldContributors"><value>${escapeXml(JSON.stringify(capture))}</value></Data>`,
      );
    lines.push("      </ExtendedData>");
    lines.push("      <Point>");
    lines.push(`        <coordinates>${place.lng},${place.lat}</coordinates>`);
    lines.push("      </Point>");
    lines.push("    </Placemark>");
  }
  lines.push("  </Document>");
  lines.push("</kml>");
  return `${lines.join("\n")}\n`;
}

/** The file formats we can export to (mirrors the import trio). */
export const SAVED_EXPORT_FORMATS = ["gpx", "geojson", "kml"] as const;
export type ExportFormat = (typeof SAVED_EXPORT_FORMATS)[number];

/** The file extension for each format. */
export const EXPORT_EXTENSION: Record<ExportFormat, string> = {
  gpx: "gpx",
  geojson: "geojson",
  kml: "kml",
};

/** The MIME type for each format (charset appended by the route). */
export const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
  gpx: "application/gpx+xml",
  geojson: "application/geo+json",
  kml: "application/vnd.google-earth.kml+xml",
};

/** Sentinel default-list names → fixed ASCII slugs (no i18n on the API side). */
const DEFAULT_LIST_SLUGS: Record<string, string> = {
  $favorites: "favorites",
  $wantToGo: "want-to-go",
  $starredPlaces: "starred-places",
};

/**
 * Build a safe ASCII filename (with extension) for an exported list. Default
 * lists use a fixed slug; user lists are slugified from their name. Falls back
 * to `list` when slugification empties the name (e.g. a name of only symbols).
 */
export function exportFilename(listName: string, format: ExportFormat): string {
  const ext = EXPORT_EXTENSION[format];
  const fixed = DEFAULT_LIST_SLUGS[listName];
  if (fixed) return `${fixed}.${ext}`;
  const slug = listName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "list"}.${ext}`;
}
