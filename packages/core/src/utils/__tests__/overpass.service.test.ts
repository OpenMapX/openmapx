import { describe, expect, it } from "vitest";
import { buildCategoryWithAttributesQuery } from "../overpass.service";

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
