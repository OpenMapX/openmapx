import { createHash } from "node:crypto";
import { effectiveProviderOrder, type LoadedIntegration } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import type { PhotoProvider } from "@openmapx/provider-kit/photos";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOsmImagePhotoProvider,
  getPhotoProviders,
  searchHeroPhotos,
} from "../orchestrator.js";

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
    loadState: "loaded",
    shutdownHandlers: [],
  };
}

/** A host-like source over `integrations`, as the host's own accessors filter them. */
function hostLike(integrations: LoadedIntegration[], order: readonly string[] = []) {
  const ctx = createMockIntegrationContext({ id: "photos", providerOrder: { photos: order } });
  ctx.getIntegrationsByDomain = (domain) =>
    integrations.filter((entry) => entry.enabled && entry.manifest.domains.includes(domain));
  return ctx;
}

describe("getPhotoProviders", () => {
  it("ignores disabled integrations and integrations outside the photos domain", () => {
    const enabledPhoto = photoProvider("enabled-photo");
    const disabledPhoto = photoProvider("disabled-photo");
    const wrongDomain = photoProvider("wrong-domain");

    const providers = getPhotoProviders(
      hostLike([
        loadedIntegration("photos-enabled", ["photos"], true, [enabledPhoto]),
        loadedIntegration("photos-disabled", ["photos"], false, [disabledPhoto]),
        loadedIntegration("reviews-only", ["reviews"], true, [wrongDomain]),
      ]),
    );

    expect(providers.map((p) => p.id)).toEqual(["enabled-photo"]);
  });

  it("sorts street-level imagery providers after editorial providers", () => {
    const mapillary = photoProvider("mapillary");
    const flickr = photoProvider("flickr");
    const panoramax = photoProvider("panoramax");
    const wikimedia = photoProvider("wikimedia-commons");

    const providers = getPhotoProviders(
      hostLike([
        loadedIntegration("a", ["photos"], true, [mapillary, flickr]),
        loadedIntegration("b", ["photos"], true, [panoramax, wikimedia]),
      ]),
    );

    expect(providers.map((p) => p.id)).toEqual([
      "flickr",
      "wikimedia-commons",
      "mapillary",
      "panoramax",
    ]);
  });

  it("orders photo sources by the operator's list and keeps the deprioritised ones last", () => {
    const integrations = [
      loadedIntegration("photos-mapillary", ["photos"], true, [photoProvider("mapillary")]),
      loadedIntegration("photos-flickr", ["photos"], true, [photoProvider("flickr")]),
      loadedIntegration("photos-panoramax", ["photos"], true, [photoProvider("panoramax")]),
      loadedIntegration("photos-wikimedia", ["photos"], true, [photoProvider("wikimedia")]),
      loadedIntegration("photos-acme", ["photos"], true, [photoProvider("acme")]),
    ];
    const order = ["photos-panoramax", "photos-acme", "ghost"];
    const ctx = hostLike(integrations, order);
    const served = getPhotoProviders(ctx).map((p) => p.id);
    expect(served).toEqual(["panoramax", "acme", "flickr", "wikimedia", "mapillary"]);
    expect(
      effectiveProviderOrder(
        order,
        integrations.filter((entry) => entry.enabled),
        "photos",
      ).map((entry) => entry.integrationId),
    ).toEqual(served.map((id) => `photos-${id}`));
    expect(ctx.getProviderOrderFingerprint("photos")).toBe(
      createHash("sha256")
        .update(JSON.stringify(served.map((id) => [`photos-${id}`, id])))
        .digest("hex")
        .slice(0, 16),
    );
  });

  it("serves the built-in order with the default configuration", () => {
    const integrations = [
      loadedIntegration("photos-mapillary", ["photos"], true, [photoProvider("mapillary")]),
      loadedIntegration("photos", ["photos"], true, [photoProvider("osm-images")]),
      loadedIntegration("photos-panoramax", ["photos"], true, [photoProvider("panoramax")]),
      loadedIntegration("photos-wikimedia", ["photos"], true, [photoProvider("wikimedia")]),
    ];
    expect(getPhotoProviders(hostLike(integrations)).map((p) => p.id)).toEqual([
      "osm-images",
      "wikimedia",
      "mapillary",
      "panoramax",
    ]);
  });

  it("leaves out the providers of a disallowed integration", () => {
    const integrations = [
      loadedIntegration("photos-acme", ["photos"], true, [photoProvider("acme")]),
      loadedIntegration("photos-flickr", ["photos"], true, [photoProvider("flickr")]),
    ];
    expect(
      getPhotoProviders(hostLike(integrations), new Set(["photos-acme"])).map((p) => p.id),
    ).toEqual(["flickr"]);
  });
});

describe("searchHeroPhotos", () => {
  it("reports failed providers in strict lookup while retaining another provider's photo", async () => {
    const photo = {
      url: "https://upload.wikimedia.org/a.jpg",
      source: "wikimedia",
      author: "Artist",
      licensing: licensingFromDeclaration(
        "CC BY 4.0",
        "https://creativecommons.org/licenses/by/4.0/",
      ),
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
      licensing: licensingFromDeclaration("CC BY 4.0", undefined, "Commons file", "imagery"),
      contributors: [expect.objectContaining({ sourceId: "wikimedia-commons" })],
    });
  });
  it("does not display a Commons filename when metadata acquisition fails", async () => {
    const get = vi.fn().mockRejectedValue(new Error("metadata unavailable"));
    const provider = createOsmImagePhotoProvider({ http: { get } } as never);
    expect(await searchHeroPhotos({ image: "File:Missing.jpg" }, [provider])).toEqual([]);
    expect(get).toHaveBeenCalledOnce();
  });
});
