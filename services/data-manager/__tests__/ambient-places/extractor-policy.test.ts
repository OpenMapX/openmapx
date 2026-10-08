import { ambientPlaceFromOsm } from "@openmapx/core/ambient-places";
import { describe, expect, it } from "vitest";
import {
  featureToSearchPlace,
  type SearchGeoJsonFeature,
} from "../../src/jobs/search-index/extract.js";
import corpus from "./landmark-corpus.json";

function evaluate(feature: SearchGeoJsonFeature) {
  const row = featureToSearchPlace(feature)!;
  expect(row).not.toBeNull();
  return ambientPlaceFromOsm({
    osm_type: row.osmType,
    osm_id: row.osmId,
    name: row.name,
    lng: row.lng,
    lat: row.lat,
    category: row.category,
    importance: row.importance,
    tags: row.tags,
  })!;
}
describe("real OSM extractor to ambient policy contract", () => {
  it.each(corpus.cases)(
    "keeps source-backed $feature.id at its intended zoom",
    ({ feature, expectedMinZoom }) => {
      if (expectedMinZoom === null) {
        // This existing index is alias/code-focused; source presence alone is
        // not publication coverage. Keep excluded name-only controls explicit.
        expect(featureToSearchPlace(feature)).toBeNull();
        return;
      }
      const place = evaluate(feature);
      expect(place.id).toBe(`osm:${feature.properties["@type"]}/${feature.properties["@id"]}`);
      expect(place.minZoom).toBe(expectedMinZoom);
      expect(place.name).toBe(feature.properties.name);
    },
  );
  it("ranks actual slash categories from the extractor", () => {
    for (const [tags, zoom] of [
      [{ amenity: "hospital" }, 13],
      [{ shop: "bakery" }, 15],
    ] as const) {
      const place = evaluate({
        id: "n9007199254740993",
        properties: { name: "Destination", short_name: "Alias", ...tags },
        geometry: { type: "Point", coordinates: [6.69, 51.2] },
      });
      expect(place.id).toBe("osm:node/9007199254740993");
      expect(place.minZoom).toBe(zoom);
    }
  });
  it("keeps an indoor/part tenant deferred even on a designated cultural building", () => {
    const cathedral = corpus.cases.find((c) => c.feature.properties.name === "Kölner Dom")!.feature;
    for (const tags of [{ indoor: "yes" }, { "building:part": "yes" }]) {
      expect(
        evaluate({ ...cathedral, properties: { ...cathedral.properties, ...tags } }).minZoom,
      ).toBe(18);
    }
  });
});
