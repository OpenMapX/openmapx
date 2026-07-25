import { describe, expect, it } from "vitest";
import { dedupeAttributionHtml } from "./mapAttributionStore";

describe("dedupeAttributionHtml", () => {
  it("collapses a credit contributed by several layers", () => {
    const osm = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    expect(dedupeAttributionHtml([osm, "© MapTiler", osm])).toEqual([osm, "© MapTiler"]);
  });

  it("keeps the longest form when one credit contains another", () => {
    expect(dedupeAttributionHtml(["© OSM", "Map data © OSM contributors"])).toEqual([
      "Map data © OSM contributors",
    ]);
  });

  it("drops empty entries and preserves registration order otherwise", () => {
    expect(dedupeAttributionHtml(["© A", "", "© B"])).toEqual(["© A", "© B"]);
  });
});
