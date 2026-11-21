import { describe, expect, it } from "vitest";
import {
  buildCategoryWithAttributesQuery,
  escapeOverpassRegex,
  mapOverpassElements,
} from "../overpass.service";

const bbox = { south: 48.85, west: 2.33, north: 48.87, east: 2.37 };

describe("buildCategoryWithAttributesQuery", () => {
  it("emits node and way selectors with ANDed attributes", () => {
    const query = buildCategoryWithAttributesQuery(
      [
        { key: "amenity", value: "cafe" },
        { key: "amenity", value: "restaurant" },
      ],
      { outdoor_seating: "yes", wheelchair: "yes" },
      bbox,
    );
    expect(query).toContain(
      'node["amenity"="cafe"]["outdoor_seating"="yes"]["wheelchair"="yes"](48.85,2.33,48.87,2.37);',
    );
    expect(query).toContain(
      'way["amenity"="restaurant"]["outdoor_seating"="yes"]["wheelchair"="yes"](48.85,2.33,48.87,2.37);',
    );
  });

  it("uses regex match for cuisine attribute", () => {
    const query = buildCategoryWithAttributesQuery(
      [{ key: "amenity", value: "cafe" }],
      { cuisine: "italian" },
      bbox,
    );
    expect(query).toContain('["cuisine"~"italian"]');
  });

  it("omits attribute predicates when attributes is empty", () => {
    const query = buildCategoryWithAttributesQuery([{ key: "amenity", value: "cafe" }], {}, bbox);
    expect(query).toContain('node["amenity"="cafe"](48.85,2.33,48.87,2.37);');
    expect(query).not.toMatch(/\["amenity"="cafe"\]\[/);
  });

  it("escapes double-quote in exact-match attribute values so the QL is not broken", () => {
    const query = buildCategoryWithAttributesQuery(
      [{ key: "amenity", value: "cafe" }],
      { wheelchair: 'ye"s' },
      bbox,
    );
    expect(query).not.toMatch(/"ye"s"/);
    expect(query).toContain('["wheelchair"="ye\\"s"]');
  });

  it("escapes regex metacharacters in cuisine values", () => {
    const query = buildCategoryWithAttributesQuery(
      [{ key: "amenity", value: "restaurant" }],
      { cuisine: "italian.fusion" },
      bbox,
    );
    expect(query).not.toMatch(/~"italian\.fusion"/);
    expect(query).toContain('["cuisine"~"italian\\.fusion"]');
  });
});

describe("escapeOverpassRegex (shared, strict escaper)", () => {
  it("escapes pipe so a user-supplied value with | becomes a literal match, not alternation", () => {
    expect(escapeOverpassRegex("yes|only")).toBe("yes\\|only");
  });

  it("escapes other metacharacters", () => {
    expect(escapeOverpassRegex("a.b*c+d?")).toBe("a\\.b\\*c\\+d\\?");
    expect(escapeOverpassRegex('say "hi"')).toBe('say \\"hi\\"');
  });
});

describe("mapOverpassElements station names", () => {
  const node = (id: number, tags: Record<string, string>) =>
    ({ type: "node", id, lat: 48.7, lon: 9.1, tags }) as const;
  const names = (tags: Record<string, string>) =>
    mapOverpassElements([node(1, tags)]).map((place) => place.name);

  it.each([
    [{ amenity: "charging_station", brand: "EnBW", operator: "EnBW AG", network: "x" }, ["EnBW"]],
    [{ amenity: "charging_station", operator: "Stadtwerke", network: "Ladenetz" }, ["Stadtwerke"]],
    [{ amenity: "charging_station", network: "Ladenetz" }, ["Ladenetz"]],
    [{ amenity: "charging_station", name: "Parkhaus Mitte", brand: "EnBW" }, ["Parkhaus Mitte"]],
    [{ amenity: "fuel", brand: "Aral", operator: "BP" }, ["Aral"]],
    [{ amenity: "fuel", operator: "Raiffeisen" }, ["Raiffeisen"]],
    [{ amenity: "fuel", network: "Ladenetz" }, []],
    [{ amenity: "charging_station" }, []],
    [{ amenity: "cafe", brand: "Starbucks" }, []],
  ])("names %o as %o", (tags, expected) => {
    expect(names(tags)).toEqual(expected);
  });
});
