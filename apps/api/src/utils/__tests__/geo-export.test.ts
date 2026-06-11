import { describe, expect, it } from "vitest";
import {
  type ExportPlace,
  exportFilename,
  placesToGeoJson,
  placesToGpx,
  placesToKml,
} from "../geo-export.js";

const TWO_PLACES: ExportPlace[] = [
  {
    name: "Brandenburg Gate",
    lat: 52.5163,
    lng: 13.3777,
    address: "Pariser Platz, Berlin",
    note: "Meet at the columns",
    placeId: "p-1",
  },
  { name: "Eiffel Tower", lat: 48.8584, lng: 2.2945 },
];

describe("placesToGeoJson", () => {
  it("test 1: serializes two places into a FeatureCollection with [lng, lat] order", () => {
    const fc = placesToGeoJson(TWO_PLACES);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);

    const [first, second] = fc.features;
    // GeoJSON coordinates MUST be [lng, lat] — guard against a silent swap.
    expect(first.geometry).toEqual({ type: "Point", coordinates: [13.3777, 52.5163] });
    expect(first.properties).toEqual({
      name: "Brandenburg Gate",
      address: "Pariser Platz, Berlin",
      note: "Meet at the columns",
      placeId: "p-1",
    });
    expect(second.geometry).toEqual({ type: "Point", coordinates: [2.2945, 48.8584] });
    // Optional fields absent → not emitted.
    expect(second.properties).toEqual({ name: "Eiffel Tower" });
  });

  it("test 2: empty input yields a valid empty FeatureCollection", () => {
    expect(placesToGeoJson([])).toEqual({ type: "FeatureCollection", features: [] });
  });
});

describe("placesToGpx", () => {
  it("test 3: round-trips two places to the exact expected GPX with lat/lon attributes", () => {
    const gpx = placesToGpx(TWO_PLACES);
    const expected = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="OpenMapX" xmlns="http://www.topografix.com/GPX/1/1">',
      '  <wpt lat="52.5163" lon="13.3777">',
      "    <name>Brandenburg Gate</name>",
      "    <desc>Meet at the columns\nPariser Platz, Berlin</desc>",
      "  </wpt>",
      '  <wpt lat="48.8584" lon="2.2945">',
      "    <name>Eiffel Tower</name>",
      "  </wpt>",
      "</gpx>",
      "",
    ].join("\n");
    expect(gpx).toBe(expected);
  });

  it("test 4: empty input yields a valid <gpx> with no waypoints", () => {
    const gpx = placesToGpx([]);
    expect(gpx).toContain("<gpx");
    expect(gpx).toContain("</gpx>");
    expect(gpx).not.toContain("<wpt");
  });
});

describe("placesToKml", () => {
  it("test 5: round-trips two places to the exact expected KML with lng,lat coordinates", () => {
    const kml = placesToKml(TWO_PLACES);
    const expected = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2">',
      "  <Document>",
      "    <Placemark>",
      "      <name>Brandenburg Gate</name>",
      "      <description>Meet at the columns\nPariser Platz, Berlin</description>",
      "      <Point>",
      "        <coordinates>13.3777,52.5163</coordinates>",
      "      </Point>",
      "    </Placemark>",
      "    <Placemark>",
      "      <name>Eiffel Tower</name>",
      "      <Point>",
      "        <coordinates>2.2945,48.8584</coordinates>",
      "      </Point>",
      "    </Placemark>",
      "  </Document>",
      "</kml>",
      "",
    ].join("\n");
    expect(kml).toBe(expected);
  });

  it("test 6: empty input yields a valid <kml><Document> with no placemarks", () => {
    const kml = placesToKml([]);
    expect(kml).toContain("<kml");
    expect(kml).toContain("<Document>");
    expect(kml).toContain("</Document>");
    expect(kml).not.toContain("<Placemark>");
  });
});

describe("XML escaping", () => {
  const tricky: ExportPlace[] = [
    { name: 'Café & <bar> "x"', lat: 1.5, lng: -2.5, note: "a < b & c > d" },
  ];

  it("test 7: GPX escapes & < > \" ' in name and desc, never emitting raw specials", () => {
    const gpx = placesToGpx(tricky);
    expect(gpx).toContain("<name>Café &amp; &lt;bar&gt; &quot;x&quot;</name>");
    expect(gpx).toContain("<desc>a &lt; b &amp; c &gt; d</desc>");
    // No raw special chars leak into element text.
    expect(gpx).not.toContain("<bar>");
    expect(gpx).not.toContain("& <");
  });

  it("test 8: KML escapes the same characters in name and description", () => {
    const kml = placesToKml(tricky);
    expect(kml).toContain("<name>Café &amp; &lt;bar&gt; &quot;x&quot;</name>");
    expect(kml).toContain("<description>a &lt; b &amp; c &gt; d</description>");
    expect(kml).not.toContain("<bar>");
  });
});

describe("exportFilename", () => {
  it("maps sentinel default lists to fixed slugs", () => {
    expect(exportFilename("$favorites", "gpx")).toBe("favorites.gpx");
    expect(exportFilename("$wantToGo", "geojson")).toBe("want-to-go.geojson");
    expect(exportFilename("$starredPlaces", "kml")).toBe("starred-places.kml");
  });
  it("slugifies a user list name", () => {
    expect(exportFilename("My Trip 2026!", "gpx")).toBe("my-trip-2026.gpx");
  });
  it("falls back to 'list' when the name slugifies to empty", () => {
    expect(exportFilename("!!!", "kml")).toBe("list.kml");
  });
});
