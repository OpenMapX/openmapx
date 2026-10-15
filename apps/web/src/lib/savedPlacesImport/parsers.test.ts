import { placesToGeoJson, placesToGpx, placesToKml } from "@openmapx/core/saved-place-export";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { coordinatesFromGoogleUrl, s2CellCenter } from "./googleUrl";
import { parseImportFiles, parseImportText } from "./index";

const parse = (name: string, text: string) => parseImportText(name, text);
const current = (coordinates = [13.4, 52.5]) => ({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates },
      properties: {
        google_maps_url: "https://maps.google.com/?q=Berlin&ftid=0xd193384e8ee1c83:0x1",
        location: { name: "Cafe", address: "Street 1" },
      },
    },
  ],
});

describe("saved place file parsers", () => {
  it.each(["Title,Note,URL,Tags,Comment", "Title,Note,URL,Comment"])(
    "maps Takeout columns by header: %s",
    (header) => {
      const tagged = header.includes("Tags");
      const result = parse(
        "Trip.csv",
        `\uFEFFList description\r\n\r\n${header}\r\n${tagged ? ",,,," : ",,,"}\r\n"Cafe, West","Line one\nLine two",https://google.com/maps/place/Cafe/data=!3d52.5!4d13.4,${tagged ? "food;coffee," : ""}My comment`,
      );
      expect(result[0].places[0]).toMatchObject({
        name: "Cafe, West",
        lat: 52.5,
        lng: 13.4,
        status: "exact",
        note: `Line one\nLine two\n\nMy comment${tagged ? "\n\nTags: food, coffee" : ""}`,
      });
    },
  );
  it("derives a decoded name or translated dropped-pin label", () => {
    const result = parse(
      "pins.csv",
      "Title,Note,URL,Comment\n,,https://google.com/maps/place/Caf%C3%A9+West/data=!3d52!4d13,\n,,https://google.com/maps/search/52%2C+13,",
    );
    expect(result[0].places.map((p) => p.name)).toEqual(["Café West", "Dropped pin"]);
  });
  it.each([
    ["https://google.com/maps/place/A/data=!3d38.7!4d-9.1", 38.7, -9.1],
    ["https://google.com/maps/search/38.7%2C+-9.1", 38.7, -9.1],
    ["https://google.com/?q=38.7%2C-9.1", 38.7, -9.1],
  ] as const)("extracts exact coordinates from %s", (url, lat, lng) =>
    expect(coordinatesFromGoogleUrl(url)).toMatchObject({ lat, lng, status: "exact" }),
  );
  it("does not locate a named query at the ll viewport centre", () => {
    expect(coordinatesFromGoogleUrl("https://google.com/?q=Cafe+Lisbon&ll=52%2C13")).toEqual({
      status: "needsLookup",
    });
  });
  it.each([
    ["Title,Note,URL,Comment", "Cafe,,https://google.com/?q=52%2C13,"],
    ["Name,Latitude,Longitude", "Cafe,52,13"],
  ])("detects the delimiter from the supported header after a description: %s", (header, row) => {
    const preamble = "Description;with;many;semicolons\n".repeat(12);
    expect(parse("trip.csv", `${preamble}${header}\n${row}`)[0].places[0]).toMatchObject({
      name: "Cafe",
      lat: 52,
      lng: 13,
      status: "exact",
    });
  });
  it("preserves the address in the official OsmAnd Favorites example and ignores unrelated addresses", () => {
    // https://osmand.net/docs/user/personal/favorites/#favorites-in-gpx-file
    const result = parse(
      "favorites.gpx",
      `<gpx version="1.1" creator="OsmAnd" xmlns="http://www.topografix.com/GPX/1/1" xmlns:osmand="https://osmand.net" xmlns:test="https://test.net">
      <wpt lat="37.5460870" lon="-77.4532843"><time>2023-06-07T12:31:35Z</time><name>Test</name><type>SOTM</type>
        <extensions><test:address>Wrong address</test:address><osmand:address>Floyd Avenue (The Fan) 907, Richmond</osmand:address><osmand:icon>place_town</osmand:icon><osmand:background>circle</osmand:background><osmand:color>#ff4e4eff</osmand:color><test:country>United States</test:country><test:state>Virginia</test:state><test:telephone>(804) 828-0100</test:telephone><test:postcode>23284</test:postcode></extensions>
      </wpt><wpt lat="38" lon="-77"><name>Other</name><extensions><test:address>Unrelated</test:address></extensions></wpt>
    </gpx>`,
    );
    expect(result[0].places[0].address).toBe("Floyd Avenue (The Fan) 907, Richmond");
    expect(result[1].places[0].address).toBeUndefined();
  });
  it("surfaces unsupported and empty saved-list CSVs inside Takeout", async () => {
    const data = zipSync({
      "Takeout/Saved/Broken.csv": strToU8("Wrong,Header\nCafe,Here"),
      "Takeout/Gespeichert/Empty.csv": strToU8("Title,Note,URL,Comment\n"),
    });
    const result = await parseImportFiles([new File([data], "takeout.zip")]);
    expect(result.errors).toEqual([
      { file: "takeout.zip/Takeout/Saved/Broken.csv", code: "unsupported" },
      { file: "takeout.zip/Takeout/Gespeichert/Empty.csv", code: "empty" },
    ]);
  });
  it("never inflates unrelated CSV entries", async () => {
    const data = zipSync({
      "Other/product.csv": strToU8("broken"),
      "Saved/Trip.csv": strToU8("Title,URL\nCafe,https://google.com/?q=52%2C13"),
    });
    const view = new DataView(data.buffer);
    view.setUint16(8, 99, true);
    for (let i = 0; i < data.length - 46; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint16(i + 10, 99, true);
        break;
      }
    }
    const result = await parseImportFiles([new File([data], "takeout.zip")]);
    expect(result.errors).toEqual([]);
    expect(result.lists[0].places[0].name).toBe("Cafe");
  });
  it("rejects excessive archive entry counts even for irrelevant entries", async () => {
    const data = zipSync(
      Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [`other/${i}`, new Uint8Array()])),
    );
    expect((await parseImportFiles([new File([data], "many.zip")])).errors).toEqual([
      { file: "many.zip", code: "tooLarge" },
    ]);
  });
  it("caps actual expanded bytes when every entry lies about its size", async () => {
    const one = zipSync({ "Saved/000.csv": strToU8("a".repeat(4 * 1024 * 1024)) });
    const source = new DataView(one.buffer);
    const centralOffset = source.getUint32(one.length - 6, true);
    const local = one.slice(0, centralOffset);
    const central = one.slice(centralOffset, one.length - 22);
    const count = 51;
    const data = new Uint8Array(count * (local.length + central.length) + 22);
    const view = new DataView(data.buffer);
    for (let i = 0; i < count; i++) {
      const offset = i * local.length;
      data.set(local, offset);
      view.setUint32(offset + 22, 64, true);
      data.set(strToU8(String(i).padStart(3, "0")), offset + 36);
      const directory = count * local.length + i * central.length;
      data.set(central, directory);
      view.setUint32(directory + 24, 64, true);
      view.setUint32(directory + 42, offset, true);
      data.set(strToU8(String(i).padStart(3, "0")), directory + 52);
    }
    const end = data.length - 22;
    data.set(one.slice(-22), end);
    view.setUint16(end + 8, count, true);
    view.setUint16(end + 10, count, true);
    view.setUint32(end + 12, count * central.length, true);
    view.setUint32(end + 16, count * local.length, true);
    expect((await parseImportFiles([new File([data], "lying.zip")])).errors).toEqual([
      { file: "lying.zip", code: "tooLarge" },
    ]);
  });
  it("keeps S2 centres approximate and does not use viewport centres as places", () => {
    const coordinates = coordinatesFromGoogleUrl(
      "https://google.com/maps/place/A/@52,13/data=!1s0xd193384e8ee1c83:0x1",
    );
    expect(coordinates.status).toBe("approximate");
    expect(coordinates.lat).toBeCloseTo(38.722, 2);
    expect(coordinates.lng).toBeCloseTo(-9.138, 2);
    expect(coordinatesFromGoogleUrl("https://google.com/maps/place/A/@52,13/")).toEqual({
      status: "needsLookup",
    });
    const cafe = s2CellCenter("0x54b8c77d187a3975");
    expect(cafe?.lat).toBeGreaterThan(40);
    expect(cafe?.lat).toBeLessThan(60);
    expect(cafe?.lng).toBeGreaterThan(-130);
    expect(cafe?.lng).toBeLessThan(-50);
  });
  it.each(["0,0", "91,13", "52,181"])("rejects invalid coordinates %s", (pair) =>
    expect(coordinatesFromGoogleUrl(`https://google.com/?q=${pair}`)).toEqual({
      status: "needsLookup",
    }),
  );
  it("parses current saved JSON and ignores reviews and placeholder comments", () => {
    const value = current();
    value.features.push({
      ...value.features[0],
      properties: { ...value.features[0].properties, ...{ five_star_rating_published: 5 } },
    });
    const result = parse("Saved Places.json", JSON.stringify(value));
    expect(result[0].systemList).toBe("$starredPlaces");
    expect(result[0].places).toHaveLength(1);
    expect(result[0].places[0]).toMatchObject({ name: "Cafe", address: "Street 1", lat: 52.5 });
    const unknown = current([0, 0]);
    Object.assign(unknown.features[0].properties, {
      location: undefined,
      Comment: "No location information is available for this saved place",
    });
    expect(parse("places.json", JSON.stringify(unknown))[0].places[0]).toMatchObject({
      name: "Berlin",
      status: "approximate",
      note: undefined,
    });
  });
  it("parses old saved JSON coordinates and property names", () => {
    const value = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: {
            Title: "Old cafe",
            "Google Maps URL": "https://google.com/maps/place/Cafe",
            Location: {
              Address: "Old road",
              "Business Name": "Cafe",
              "Geo Coordinates": { Latitude: "48.1", Longitude: "11.2" },
            },
          },
        },
      ],
    };
    expect(parse("old.json", JSON.stringify(value))[0].places[0]).toMatchObject({
      name: "Old cafe",
      lat: 48.1,
      lng: 11.2,
      status: "exact",
    });
  });
  it("parses KML HTML, ExtendedData, and prefixed bookmark metadata without splitting folders", () => {
    const text =
      '<kml xmlns:mwm="urn:any"><Document><name>Hikes</name><Folder><Placemark><name>Peak</name><description><![CDATA[<p>Hello</p><p>world &amp; friends</p><script>bad()</script>]]></description><ExtendedData><Data name="Address"><value>Hill road</value></Data></ExtendedData><Point><coordinates>11,48,0</coordinates></Point></Placemark><Placemark><ExtendedData><mwm:name>Cabin</mwm:name><mwm:description>Rest</mwm:description></ExtendedData><Point><coordinates>12,49</coordinates></Point></Placemark></Folder></Document></kml>';
    const result = parse("bookmarks.kml", text);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Hikes");
    expect(result[0].places).toEqual([
      expect.objectContaining({
        name: "Peak",
        address: "Hill road",
        note: "Hello\nworld & friends",
      }),
      expect.objectContaining({ name: "Cabin", note: "Rest" }),
    ]);
  });
  it("reports a network-link-only KML distinctly", () =>
    expect(() =>
      parse(
        "linked.kml",
        "<kml><NetworkLink><Link><href>https://example.test/data</href></Link></NetworkLink></kml>",
      ),
    ).toThrow("networkLink"));
  it("parses every KML in KMZ", async () => {
    const kml = (name: string) =>
      strToU8(
        `<kml><Document><name>${name}</name><Placemark><name>Place</name><Point><coordinates>13,52</coordinates></Point></Placemark></Document></kml>`,
      );
    const data = zipSync({ "doc.kml": kml("One"), "nested/second.kml": kml("Two") });
    const result = await parseImportFiles([new File([data], "bookmarks.kmz")]);
    expect(result.lists.map((l) => l.name)).toEqual(["One", "Two"]);
  });
  it("splits GPX waypoint groups and preserves OsmAnd addresses, ignoring tracks", () => {
    const result = parse(
      "favourites.gpx",
      '<gpx xmlns:osmand="https://osmand.net/docs/technical/osmand-file-formats/osmand-gpx"><metadata><name>Favourites</name></metadata><wpt lat="52" lon="13"><name>Home</name><desc>Note</desc><type>Private</type><extensions><osmand:address>Street 1</osmand:address></extensions></wpt><wpt lat="53" lon="14"><name>Office</name><cmt>Comment</cmt><type>Work</type></wpt><trk><trkseg><trkpt lat="54" lon="15"/></trkseg></trk></gpx>',
    );
    expect(result.map((l) => l.name)).toEqual(["Private", "Work"]);
    expect(result[0].places[0]).toMatchObject({ address: "Street 1", note: "Note" });
    expect(result[1].places[0].note).toBe("Comment");
    expect(() =>
      parse("track.gpx", '<gpx><trk><trkseg><trkpt lat="52" lon="13"/></trkseg></trk></gpx>'),
    ).toThrow("empty");
    expect(
      parse(
        "one.gpx",
        '<gpx><metadata><name>Trip</name></metadata><wpt lat="52" lon="13"><name>Home</name><type>A</type></wpt></gpx>',
      )[0].name,
    ).toBe("Trip");
  });
  it("parses generic GeoJSON points and lat/lon CSV", () => {
    expect(
      parse(
        "points.geojson",
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [13, 52] },
              properties: { label: "Here", description: "Note", address: "Street" },
            },
            {
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: [
                  [13, 52],
                  [14, 53],
                ],
              },
              properties: {},
            },
          ],
        }),
      )[0].places,
    ).toEqual([
      expect.objectContaining({ name: "Here", note: "Note", address: "Street", status: "exact" }),
    ]);
    expect(
      parse(
        "points.csv",
        'Title,Latitude,Longitude,Comment,Address\n"Here, yes",52,13,Note,Street',
      )[0].places[0],
    ).toMatchObject({ name: "Here, yes", lat: 52, lng: 13, note: "Note", address: "Street" });
  });
  it("detects localized Takeout entries by content and ignores reviews and other data", async () => {
    const data = zipSync({
      "Takeout/Gespeichert/Want to go.csv": strToU8(
        "Title,Note,URL,Comment\nCafe,,https://google.com/?q=52%2C13,",
      ),
      "Takeout/Meine Orte/Orte.json": strToU8(JSON.stringify(current())),
      "Takeout/Maps/Reviews.json": strToU8(
        JSON.stringify({
          ...current(),
          features: current().features.map((f) => ({
            ...f,
            properties: { ...f.properties, "Star Rating": 5 },
          })),
        }),
      ),
      "unrelated.csv": strToU8("a,b\n1,2"),
      "photos/image.jpg": new Uint8Array([1]),
    });
    const result = await parseImportFiles([
      new File([data], "Takeout.zip"),
      new File(["oops"], "bad.json"),
      new File([""], "empty.csv"),
      new File(["<gpx>"], "broken.gpx"),
      new File([""], "unknown.txt"),
    ]);
    expect(result.lists).toHaveLength(2);
    expect(result.lists[0].systemList).toBe("$wantToGo");
    expect(result.errors.map((e) => e.code)).toEqual([
      "malformed",
      "empty",
      "malformed",
      "unsupported",
    ]);
  });
  it("does not turn missing coordinate components into zero", () => {
    expect(() =>
      parse(
        "missing.kml",
        "<kml><Placemark><name>Missing latitude</name><Point><coordinates>13,</coordinates></Point></Placemark></kml>",
      ),
    ).toThrow("empty");
    const input = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: {
            Title: "Missing longitude",
            "Google Maps URL": "https://google.com/maps/place/Missing",
            Location: { Latitude: "52", Longitude: "" },
          },
        },
      ],
    };
    expect(parse("missing.json", JSON.stringify(input))[0].places[0]).toMatchObject({
      status: "needsLookup",
    });
  });
  it("preserves notes when reimporting an exported GeoJSON list", () => {
    const input = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [13, 52] },
          properties: { name: "Cafe", note: "My saved note" },
        },
      ],
    };
    expect(parse("export.geojson", JSON.stringify(input))[0].places[0].note).toBe("My saved note");
  });
  it("reports an empty archive without a malformed-file error", async () => {
    const result = await parseImportFiles([new File([zipSync({})], "empty.zip")]);
    expect(result.errors).toEqual([{ file: "empty.zip", code: "empty" }]);
  });
  it("truncates notes without splitting surrogate pairs", () => {
    const note = `${"a".repeat(1999)}😀`;
    expect(
      parse("notes.csv", `Title,Note,URL,Comment\nCafe,${note},https://google.com/?q=52%2C13,`)[0]
        .places[0].note,
    ).toBe("a".repeat(1999));
  });
});

const captured = {
  lat: [
    {
      sourceId: "original",
      name: "Original publisher",
      attributionText: '<a href="https://example.test/license">Required notice</a>',
    },
  ],
  lng: [],
};
const exportedPlace = {
  name: 'Café & <bar> "name"',
  lat: 52,
  lng: 13,
  address: 'Road & <lane> "20"',
  note: "Keep & <literal> > \"quotes\" and 'apostrophes'\n\nSecond line",
  fieldContributors: captured,
};
describe("OpenMapX export round trips", () => {
  it.each([
    ["geojson", () => JSON.stringify(placesToGeoJson([exportedPlace]))],
    ["gpx", () => placesToGpx([exportedPlace])],
    ["kml", () => placesToKml([exportedPlace])],
  ] as const)(
    "preserves names, clean notes, addresses and validated captures in %s",
    (format, output) => {
      expect(parse(`export.${format}`, output())[0].places[0]).toEqual({
        ...exportedPlace,
        status: "exact",
      });
    },
  );
  it.each(["gpx", "kml"])(
    "keeps edited descriptions when the generated suffix is no longer exact in %s",
    (format) => {
      const output = format === "gpx" ? placesToGpx([exportedPlace]) : placesToKml([exportedPlace]);
      const tag = format === "gpx" ? "desc" : "description";
      const edited = output.replace(`</${tag}>`, `\nUser addition</${tag}>`);
      expect(parse(`export.${format}`, edited)[0].places[0].note).toContain("Required notice");
      expect(parse(`export.${format}`, edited)[0].places[0].note).toContain("User addition");
    },
  );
  it.each(["gpx", "kml"])(
    "does not strip generated text followed by extra whitespace in %s",
    (format) => {
      const output = format === "gpx" ? placesToGpx([exportedPlace]) : placesToKml([exportedPlace]);
      const tag = format === "gpx" ? "desc" : "description";
      const edited = output.replace(`</${tag}>`, `  </${tag}>`);
      expect(parse(`export.${format}`, edited)[0].places[0].note).toContain("Required notice");
    },
  );
  it.each(["gpx", "kml"])("round trips an address without captures in %s", (format) => {
    const place = { name: "Mine", lat: 52, lng: 13, address: "My address", note: "My note" };
    const output = format === "gpx" ? placesToGpx([place]) : placesToKml([place]);
    expect(parse(`export.${format}`, output)[0].places[0]).toMatchObject(place);
  });
  it.each([
    [
      "gpx",
      '<gpx xmlns:osmand="https://osmand.net"><wpt lat="52" lon="13"><name>Place</name><desc>My note\nMy address</desc><extensions><osmand:address>My address</osmand:address></extensions></wpt></gpx>',
    ],
    [
      "kml",
      "<kml><Placemark><name>Place</name><address>My address</address><description>My note\nMy address</description><Point><coordinates>13,52</coordinates></Point></Placemark></kml>",
    ],
  ])("does not strip an unmarked third-party description in %s", (format, output) => {
    expect(parse(`external.${format}`, output)[0].places[0].note).toBe("My note\nMy address");
  });
  it("matches GPX extension namespaces rather than prefixes and ignores unvalidated metadata", () => {
    const output = placesToGpx([exportedPlace])
      .replaceAll("omx:", "other:")
      .replace("xmlns:omx=", "xmlns:other=");
    expect(parse("renamed.gpx", output)[0].places[0].fieldContributors).toEqual(captured);
    const spoof = output.replaceAll(
      "https://openmapx.org/ns/saved-place/1",
      "https://untrusted.test/ns",
    );
    expect(parse("spoof.gpx", spoof)[0].places[0].fieldContributors).toBeUndefined();
  });
  it.each([
    [
      "geojson",
      JSON.stringify({
        type: "Feature",
        geometry: { type: "Point", coordinates: [13, 52] },
        properties: {
          name: "Place",
          fieldContributors: { lat: [{}] },
          _mapAttributions: captured.lat,
        },
      }),
    ],
    [
      "gpx",
      '<gpx xmlns:omx="https://openmapx.org/ns/saved-place/1"><wpt lat="52" lon="13"><name>Place</name><extensions><omx:fieldContributors>{"lat":[{}]}</omx:fieldContributors></extensions></wpt></gpx>',
    ],
    [
      "kml",
      '<kml><Placemark><name>Place</name><ExtendedData><Data name="fieldContributors"><value>{"lat":[{}]}</value></Data></ExtendedData><Point><coordinates>13,52</coordinates></Point></Placemark></kml>',
    ],
  ])("silently drops invalid captures but retains the place in %s", (format, output) => {
    const place = parse(`bad.${format}`, output)[0].places[0];
    expect(place.name).toBe("Place");
    expect(place.fieldContributors).toBeUndefined();
  });
});
