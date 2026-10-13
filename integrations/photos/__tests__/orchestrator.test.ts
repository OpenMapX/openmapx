import type { LoadedIntegration } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOsmImagePhotoProvider,
  getPhotoProviders,
  searchHeroPhotos,
} from "../orchestrator.js";
import type { PhotoProvider } from "../types.js";

afterEach(() => vi.restoreAllMocks());

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
  it("reports failed providers in strict lookup while retaining another provider's photo", async () => {
    const photo = {
      url: "https://upload.wikimedia.org/a.jpg",
      source: "wikimedia",
      author: "Artist",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      pageUrl: "https://commons.wikimedia.org/wiki/File:A.jpg",
    };
    const error = Object.assign(new Error("throttled"), { status: 429, retryAfterMs: 7000 });
    const failed = {
      ...photoProvider("failed"),
      searchByTags: vi.fn(async () => {
        throw error;
      }),
    };
    const successful = { ...photoProvider("success"), searchByTags: vi.fn(async () => [photo]) };
    const errors: unknown[] = [];
    const photos = await searchHeroPhotos(
      { wikimedia_commons: "File:Photo.jpg" },
      [failed, successful],
      { strict: true, onError: (reason) => errors.push(reason) },
    );
    expect(photos).toEqual([photo]);
    expect(errors).toEqual([error]);
  });
  it("resolves OSM Commons filenames through per-file metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          query: {
            pages: {
              1: {
                title: "File:Example.jpg",
                imageinfo: [
                  {
                    url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.jpg",
                    mime: "image/jpeg",
                    extmetadata: {
                      Artist: { value: "Creator" },
                      LicenseShortName: { value: "CC BY 4.0" },
                      LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
                    },
                  },
                ],
              },
            },
          },
        }),
      ),
    );
    const photos = await searchHeroPhotos(
      { image: "https://example.com/place.jpg", "image:0": "File:Example.jpg" },
      [
        createOsmImagePhotoProvider({
          http: {
            get: async () => ({
              query: {
                pages: {
                  1: {
                    title: "File:Example.jpg",
                    imageinfo: [
                      {
                        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.jpg",
                        mime: "image/jpeg",
                        extmetadata: {
                          Artist: { value: "Creator" },
                          LicenseShortName: { value: "CC BY 4.0" },
                          LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
                        },
                      },
                    ],
                  },
                },
              },
            }),
          },
        } as never),
      ],
    );
    expect(photos).toHaveLength(2);
    expect(photos[0]).toEqual({ url: "https://example.com/place.jpg", source: "osm" });
    expect(photos[1]).toMatchObject({
      source: "wikimedia-commons",
      author: "Creator",
      license: "CC BY 4.0",
      contributors: [expect.objectContaining({ sourceId: "wikimedia-commons" })],
    });
  });
  it("does not display a Commons filename when metadata acquisition fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("busy", { status: 503 }));
    expect(await searchHeroPhotos({ image: "File:Missing.jpg" }, [])).toEqual([]);
  });
});
