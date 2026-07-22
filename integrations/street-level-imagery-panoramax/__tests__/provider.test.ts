import { describe, expect, it } from "vitest";
import { type StacItem, stacItemToImage, stacLinksToStreetLevelLinks } from "../provider";

const ITEM: StacItem = {
  id: "9f2916af-0000-4000-8000-000000000001",
  geometry: { type: "Point", coordinates: [2.3521, 48.8573] },
  properties: {
    datetime: "2025-09-23T13:33:04+00:00",
    "view:azimuth": 98,
    "pers:interior_orientation": { field_of_view: 360 },
    license: "CC-BY-SA-4.0",
    providers: [{ name: "Some Contributor" }],
  },
  assets: {
    thumb: { href: "https://example.test/thumb.jpg" },
    sd: { href: "https://example.test/sd.jpg" },
    hd: { href: "https://example.test/hd.jpg" },
  },
  collection: "abf97111-0000-4000-8000-000000000002",
  links: [],
};

describe("stacItemToImage", () => {
  it("maps identity, position and provider", () => {
    const image = stacItemToImage(ITEM, "panoramax");
    expect(image.id).toBe(ITEM.id);
    expect(image.providerId).toBe("panoramax");
    expect(image.lngLat).toEqual([2.3521, 48.8573]);
  });

  it("reads the compass heading from view:azimuth", () => {
    expect(stacItemToImage(ITEM, "panoramax").heading).toBe(98);
  });

  it("detects a 360 image from a 360 degree field of view", () => {
    const image = stacItemToImage(ITEM, "panoramax");
    expect(image.isPano).toBe(true);
    expect(image.fovDeg).toBe(360);
  });

  it("treats a missing field of view as a 70 degree flat image", () => {
    const flat: StacItem = {
      ...ITEM,
      properties: { ...ITEM.properties, "pers:interior_orientation": undefined },
    };
    const image = stacItemToImage(flat, "panoramax");
    expect(image.isPano).toBe(false);
    expect(image.fovDeg).toBe(70);
  });

  it("maps assets and sequence", () => {
    const image = stacItemToImage(ITEM, "panoramax");
    expect(image.assets.hd).toBe("https://example.test/hd.jpg");
    expect(image.assets.thumb).toBe("https://example.test/thumb.jpg");
    expect(image.sequenceId).toBe(ITEM.collection);
  });

  it("normalises the SPDX licence for display", () => {
    expect(stacItemToImage(ITEM, "panoramax").license).toBe("CC BY-SA 4.0");
  });

  it("maps the capture timestamp and author", () => {
    const image = stacItemToImage(ITEM, "panoramax");
    expect(image.capturedAt).toBe("2025-09-23T13:33:04+00:00");
    expect(image.author).toBe("Some Contributor");
  });
});

describe("stacLinksToStreetLevelLinks", () => {
  const links = [
    { rel: "self", href: "https://example.test/self" },
    { rel: "license", href: "https://example.test/license" },
    {
      rel: "next",
      id: "0947c64b-0000-4000-8000-000000000003",
      geometry: { type: "Point" as const, coordinates: [2.35216, 48.85728] as [number, number] },
      href: "https://example.test/next",
    },
    {
      rel: "related",
      id: "a0606702-0000-4000-8000-000000000004",
      datetime: "2023-12-13T09:11:11Z",
      geometry: { type: "Point" as const, coordinates: [2.35201, 48.85735] as [number, number] },
      href: "https://example.test/related",
    },
  ];

  it("keeps only navigable relations", () => {
    const result = stacLinksToStreetLevelLinks(links, "panoramax");
    expect(result).toHaveLength(2);
    expect(result.map((l) => l.rel).sort()).toEqual(["next", "related"]);
  });

  it("carries id, position and capture time", () => {
    const related = stacLinksToStreetLevelLinks(links, "panoramax").find(
      (l) => l.rel === "related",
    );
    expect(related?.id).toBe("a0606702-0000-4000-8000-000000000004");
    expect(related?.lngLat).toEqual([2.35201, 48.85735]);
    expect(related?.capturedAt).toBe("2023-12-13T09:11:11Z");
    expect(related?.providerId).toBe("panoramax");
  });

  it("drops navigable relations that carry no id or geometry", () => {
    const result = stacLinksToStreetLevelLinks(
      [{ rel: "next", href: "https://example.test/next" }],
      "panoramax",
    );
    expect(result).toEqual([]);
  });
});
