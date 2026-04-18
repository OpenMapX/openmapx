import { describe, expect, it } from "vitest";
import { filterFeedsByCountry, slugify } from "../src/jobs/download-gtfs.js";

describe("download-gtfs helpers", () => {
  it("slugifies feed identifier from URL", () => {
    expect(slugify("https://transitous.org/feeds/de-bvg.zip")).toBe("de-bvg");
    expect(slugify("https://example.com/some/path/feed.zip")).toBe("feed");
  });

  it("filters feeds by country code", () => {
    const feeds = [
      { id: "de-bvg", country: "de", url: "x" },
      { id: "us-mbta", country: "us", url: "y" },
      { id: "ch-sbb", country: "ch", url: "z" },
    ];
    expect(filterFeedsByCountry(feeds, ["de", "ch"]).map((f) => f.id)).toEqual([
      "de-bvg",
      "ch-sbb",
    ]);
  });

  it("returns all feeds when filter is empty", () => {
    const feeds = [
      { id: "a", country: "x", url: "1" },
      { id: "b", country: "y", url: "2" },
    ];
    expect(filterFeedsByCountry(feeds, [])).toEqual(feeds);
  });
});
