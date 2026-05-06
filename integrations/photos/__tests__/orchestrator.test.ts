import type { LoadedIntegration, PlacePhoto } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { getPhotoProviders, searchHeroPhotos } from "../orchestrator.js";
import type { PhotoProvider } from "../types.js";

function photoProvider(id: string): PhotoProvider {
  return {
    id,
    name: id,
    search: vi.fn<PhotoProvider["search"]>().mockResolvedValue([]),
  };
}

function loadedIntegration(
  id: string,
  domains: string[],
  enabled: boolean,
  providers: PhotoProvider[],
): LoadedIntegration {
  return {
    id,
    manifest: { id, domains },
    config: {},
    directory: `/integrations/${id}`,
    isBuiltIn: true,
    enabled,
    providers: new Map([["photos", providers]]),
    strings: {},
    shutdownHandlers: [],
  };
}

describe("getPhotoProviders", () => {
  it("ignores disabled integrations and integrations outside the photos domain", () => {
    const enabledPhoto = photoProvider("enabled-photo");
    const disabledPhoto = photoProvider("disabled-photo");
    const wrongDomain = photoProvider("wrong-domain");

    const providers = getPhotoProviders([
      loadedIntegration("photos-enabled", ["photos"], true, [enabledPhoto]),
      loadedIntegration("photos-disabled", ["photos"], false, [disabledPhoto]),
      loadedIntegration("reviews-only", ["reviews"], true, [wrongDomain]),
    ]);

    expect(providers.map((p) => p.id)).toEqual(["enabled-photo"]);
  });

  it("sorts street-level imagery providers after editorial providers", () => {
    const mapillary = photoProvider("mapillary");
    const flickr = photoProvider("flickr");
    const panoramax = photoProvider("panoramax");
    const wikimedia = photoProvider("wikimedia-commons");

    const providers = getPhotoProviders([
      loadedIntegration("a", ["photos"], true, [mapillary, flickr]),
      loadedIntegration("b", ["photos"], true, [panoramax, wikimedia]),
    ]);

    expect(providers.map((p) => p.id)).toEqual([
      "flickr",
      "wikimedia-commons",
      "mapillary",
      "panoramax",
    ]);
  });
});

describe("searchHeroPhotos", () => {
  it("returns OSM image tag photos without registered providers", async () => {
    const photos = await searchHeroPhotos(
      {
        image: "https://example.com/place.jpg",
        "image:0": "File:Example.jpg",
      },
      [],
    );

    expect(photos).toEqual<PlacePhoto[]>([
      {
        url: "https://example.com/place.jpg",
        attribution: "OpenStreetMap",
        source: "osm",
        pageUrl: undefined,
      },
      {
        url: "https://commons.wikimedia.org/wiki/Special:FilePath/Example.jpg?width=1200",
        attribution: "OpenStreetMap",
        source: "osm",
        pageUrl: undefined,
      },
    ]);
  });
});
