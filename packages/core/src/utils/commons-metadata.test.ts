import { describe, expect, it, vi } from "vitest";
import type { PlacePhoto } from "../types/place";
import { fetchCommonsMetadata, isDisplayablePhoto, parseCommonsPage } from "./commons-metadata";

describe("fetchCommonsMetadata strict lookup", () => {
  it("surfaces upstream failure while preserving the default empty-map fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("busy", { status: 429, headers: { "Retry-After": "5" } })),
    );
    try {
      await expect(fetchCommonsMetadata(["Photo.jpg"], { strict: true })).rejects.toMatchObject({
        status: 429,
        retryAfterMs: 5000,
      });
      expect((await fetchCommonsMetadata(["Photo.jpg"])).size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("isDisplayablePhoto for legacy Commons entries", () => {
  it.each([
    {
      name: "audio File page with an ordinary thumbnail URL",
      photo: {
        url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Preview.jpg/800px-Preview.jpg",
        pageUrl: "https://commons.wikimedia.org/wiki/File:Recorded_voice.ogg",
        source: "wikimedia",
      },
      visible: false,
    },
    {
      name: "video File page with an ordinary thumbnail URL",
      photo: {
        url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Preview.jpg/800px-Preview.jpg",
        pageUrl: "https://commons.wikimedia.org/wiki/File:Clip.webm",
        source: "wikimedia",
      },
      visible: false,
    },
    {
      name: "file-type icon without a File page",
      photo: {
        url: "https://commons.wikimedia.org/w/resources/assets/file-type-icons/fileicon-ogg.png",
        source: "wikimedia",
      },
      visible: false,
    },
    {
      name: "audio OSM FilePath without a Commons page",
      photo: {
        url: "https://commons.wikimedia.org/wiki/Special:FilePath/De-Aachen.ogg?width=1200",
        source: "osm",
      },
      visible: false,
    },
    {
      name: "real JPEG File page",
      photo: {
        url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Photo.jpg/800px-Photo.jpg",
        pageUrl: "https://commons.wikimedia.org/wiki/File:Photo.jpg",
        source: "wikimedia",
      },
      visible: true,
    },
    {
      name: "real SVG File page",
      photo: {
        url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Emblem.svg/500px-Emblem.svg.png",
        pageUrl: "https://commons.wikimedia.org/wiki/File:Emblem.svg",
        source: "wikimedia",
      },
      visible: true,
    },
  ])("$name", ({ photo, visible }) => {
    expect(isDisplayablePhoto(photo as PlacePhoto)).toBe(visible);
  });
});

describe("parseCommonsPage author attribution", () => {
  it("preserves visible artist spans and links", () => {
    const photo = parseCommonsPage({
      imageinfo: [
        {
          url: "https://upload.wikimedia.org/wikipedia/commons/photo.jpg",
          mime: "image/jpeg",
          extmetadata: {
            Artist: {
              value:
                '<a href="/wiki/User:Artist">Artist</a><span style="display: inline;"> and Artist</span>',
            },
          },
        },
      ],
    });
    expect(photo?.author).toBe("Artist and Artist");
    expect(photo?.authorUrl).toBe("https://commons.wikimedia.org/wiki/User:Artist");
  });

  it("omits the hidden Commons unknown-author marker", () => {
    // Artist from File:Starbucks coffee wordmark.png in the Commons API.
    const photo = parseCommonsPage({
      title: "File:Starbucks coffee wordmark.png",
      imageinfo: [
        {
          url: "https://upload.wikimedia.org/wikipedia/commons/wordmark.png",
          mime: "image/png",
          extmetadata: {
            Artist: { value: 'Unknown author<span style="display: none;">Unknown author</span>' },
          },
        },
      ],
    });
    expect(photo?.author).toBe("Unknown author");
  });
});
