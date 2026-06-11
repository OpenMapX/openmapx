/**
 * Pure converters that turn saved places into the three file formats the app
 * already imports (GeoJSON / GPX / KML). These are deliberately dependency-free
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

/** Build the `<desc>` text shared by GPX/KML: note first, then address. */
function describePlace(place: ExportPlace): string | null {
  const parts = [place.note, place.address].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Serialize places to a GeoJSON FeatureCollection (as a plain object — the
 * caller stringifies). An empty input yields a valid empty FeatureCollection.
 * Point coordinates are `[lng, lat]`.
 */
export function placesToGeoJson(places: ExportPlace[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: places.map((place) => {
      const properties: Record<string, string> = { name: place.name };
      if (place.address) properties.address = place.address;
      if (place.note) properties.note = place.note;
      if (place.placeId) properties.placeId = place.placeId;
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
    '<gpx version="1.1" creator="OpenMapX" xmlns="http://www.topografix.com/GPX/1/1">',
  ];
  for (const place of places) {
    lines.push(`  <wpt lat="${place.lat}" lon="${place.lng}">`);
    lines.push(`    <name>${escapeXml(place.name)}</name>`);
    const desc = describePlace(place);
    if (desc) lines.push(`    <desc>${escapeXml(desc)}</desc>`);
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
    const desc = describePlace(place);
    if (desc) lines.push(`      <description>${escapeXml(desc)}</description>`);
    lines.push("      <Point>");
    lines.push(`        <coordinates>${place.lng},${place.lat}</coordinates>`);
    lines.push("      </Point>");
    lines.push("    </Placemark>");
  }
  lines.push("  </Document>");
  lines.push("</kml>");
  return `${lines.join("\n")}\n`;
}
