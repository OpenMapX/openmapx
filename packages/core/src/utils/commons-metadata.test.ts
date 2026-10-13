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
    expect(
      isDisplayablePhoto({
        ...photo,
        author: "Artist",
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      } as PlacePhoto),
    ).toBe(visible);
  });
});

describe("parseCommonsPage author attribution", () => {
  it("ignores nested hidden author content and retains quote-aware visible links", () => {
    const photo = parseCommonsPage({
      title: "File:Visible.jpg",
      imageinfo: [
        {
          url: "https://upload.wikimedia.org/wikipedia/commons/visible.jpg",
          mime: "image/jpeg",
          extmetadata: {
            LicenseShortName: { value: "Public domain" },
            Artist: {
              value:
                '<span style="display: none;"><span>Unknown</span><a href="https://hidden.example">Hidden</a></span><a title="A > B" href = "/wiki/User:Visible">Visible &copy; Co</a>',
            },
          },
        },
      ],
    });
    expect(photo?.author).toBe("Visible © Co");
    expect(photo?.authorUrl).toBe("https://commons.wikimedia.org/wiki/User:Visible");
    expect(photo?.attributionLinks).toEqual([]);
  });

  it("retains safe unquoted notice URLs but rejects entity-encoded executable links", () => {
    const photo = parseCommonsPage({
      title: "File:Notice.jpg",
      imageinfo: [
        {
          url: "https://upload.wikimedia.org/wikipedia/commons/notice.jpg",
          mime: "image/jpeg",
          extmetadata: {
            LicenseShortName: { value: "Public domain" },
            Permission: {
              value:
                '<a href=//permission.example/record>Permission &copy; owner</a> <a href="java&#x73;cript:bad()">unsafe link</a>',
            },
          },
        },
      ],
    });
    expect(photo?.attributionText).toBe("Permission © owner unsafe link");
    expect(photo?.attributionLinks).toEqual([
      { label: "Permission © owner", url: "https://permission.example/record" },
    ]);
  });

  it("preserves visible artist spans and links", () => {
    const photo = parseCommonsPage({
      title: "File:Photo.jpg",
      imageinfo: [
        {
          url: "https://upload.wikimedia.org/wikipedia/commons/photo.jpg",
          mime: "image/jpeg",
          extmetadata: {
            LicenseShortName: { value: "Public domain" },
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
            LicenseShortName: { value: "Public domain" },
            Artist: { value: 'Unknown author<span style="display: none;">Unknown author</span>' },
          },
        },
      ],
    });
    expect(photo?.author).toBe("Unknown author");
  });
});

describe("Commons per-file receipt completeness", () => {
  const page = {
    title: "File:Photo.jpg",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Photo.jpg",
        mime: "image/jpeg",
        extmetadata: {
          Artist: { value: '<a href="/wiki/User:Creator">Creator</a>' },
          LicenseShortName: { value: "CC BY-SA 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" },
          Credit: {
            value: 'Required credit <a href="https://example.org/credit">original source</a>',
          },
        },
      },
    ],
  };
  it("captures the file's immutable licence, author and notice before any cache", () => {
    const photo = parseCommonsPage(page);
    expect(photo?.source).toBe("wikimedia-commons");
    expect(photo?.contributors).toEqual([
      expect.objectContaining({
        sourceId: "wikimedia-commons",
        name: "Wikimedia Commons",
        spdxLicense: "CC BY-SA 4.0",
        publisher: { name: "Creator", url: "https://commons.wikimedia.org/wiki/User:Creator" },
        attributionText: expect.stringContaining("Required credit"),
        url: expect.stringContaining("File:Photo.jpg"),
      }),
    ]);
    expect(photo?.contributors?.[0].attributionText).toContain(
      'href="https://creativecommons.org/licenses/by-sa/4.0/"',
    );
    expect(photo?.contributors?.[0].attributionText).toContain(
      'href="https://commons.wikimedia.org/wiki/File:Photo.jpg"',
    );
    expect(photo?.attributionLinks).toContainEqual({
      label: "original source",
      url: "https://example.org/credit",
    });
  });
  it.each(["Artist", "LicenseShortName", "LicenseUrl"])(
    "defers a licensed file missing %s",
    (field) => {
      const copy = structuredClone(page);
      delete (copy.imageinfo[0].extmetadata as Record<string, unknown>)[field];
      expect(parseCommonsPage(copy)).toBeUndefined();
    },
  );
  it("rejects metadata-less cached Commons bytes regardless of the old source label", () => {
    expect(isDisplayablePhoto({ url: page.imageinfo[0].url, source: "wikipedia" })).toBe(false);
  });
  it("retains a complete cached file with its original receipt", () => {
    const photo = parseCommonsPage(page);
    if (!photo) throw new Error("complete metadata should parse");
    expect(isDisplayablePhoto(JSON.parse(JSON.stringify(photo)))).toBe(true);
  });
  it("accepts an explicitly public-domain file without inventing an artist or licence URL", () => {
    const copy = structuredClone(page);
    copy.imageinfo[0].extmetadata.LicenseShortName.value = "Public domain";
    delete (copy.imageinfo[0].extmetadata as Record<string, unknown>).Artist;
    delete (copy.imageinfo[0].extmetadata as Record<string, unknown>).LicenseUrl;
    expect(parseCommonsPage(copy)?.license).toBe("Public domain");
  });
});

it("preserves credit text entities and every artist's required link", () => {
  const photo = parseCommonsPage({
    title: "File:Artists.jpg",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Artists.jpg",
        mime: "image/jpeg",
        extmetadata: {
          Artist: {
            value:
              '<a href="/wiki/User:One">One &amp; Co</a> and <a href="https://example.org/two">Two</a>',
          },
          LicenseShortName: { value: "CC BY 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
        },
      },
    ],
  });
  expect(photo?.author).toBe("One & Co and Two");
  expect(photo?.attributionLinks).toContainEqual({ label: "Two", url: "https://example.org/two" });
  expect(photo?.contributors?.[0].attributionText).toContain('href="https://example.org/two"');
});

it("retains the metadata's custom attribution and permission links", () => {
  const photo = parseCommonsPage({
    title: "File:Custom.jpg",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Custom.jpg",
        mime: "image/jpeg",
        extmetadata: {
          Artist: { value: "Artist" },
          Credit: { value: "Discarded default credit" },
          Attribution: {
            value: 'Custom required credit <a href="https://example.org/custom">licensor</a>',
          },
          Permission: { value: 'See <a href="https://example.org/permission">permission</a>' },
          LicenseShortName: { value: "CC BY 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
        },
      },
    ],
  });
  expect(photo?.attributionText).toContain("Custom required credit licensor");
  expect(photo?.attributionText).not.toContain("Discarded default credit");
  expect(photo?.attributionLinks).toContainEqual({
    label: "permission",
    url: "https://example.org/permission",
  });
});

it("rejects explicitly non-free metadata and requires attribution for booleanish True", () => {
  const page = {
    title: "File:Logo.svg",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Logo.svg",
        mime: "image/svg+xml",
        extmetadata: {
          LicenseShortName: { value: "Public domain" },
          AttributionRequired: { value: "True" },
        },
      },
    ],
  };
  expect(parseCommonsPage(page)).toBeUndefined();
  expect(
    parseCommonsPage({
      ...page,
      imageinfo: [
        {
          ...page.imageinfo[0],
          extmetadata: {
            Artist: { value: "Artist" },
            LicenseShortName: { value: "CC BY 4.0" },
            LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
            NonFree: { value: "True" },
          },
        },
      ],
    }),
  ).toBeUndefined();
});

it("decodes author and required notice href entities before capturing URLs", () => {
  const photo = parseCommonsPage({
    title: "File:Links.jpg",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Links.jpg",
        mime: "image/jpeg",
        extmetadata: {
          Artist: { value: '<a href="https://creator.example/?id=7&amp;view=full">Creator</a>' },
          Permission: {
            value: '<a href="https://permission.example/?id=7&amp;view=full">permission record</a>',
          },
          LicenseShortName: { value: "CC BY 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
        },
      },
    ],
  });
  expect(photo?.authorUrl).toBe("https://creator.example/?id=7&view=full");
  expect(photo?.attributionLinks).toContainEqual({
    label: "permission record",
    url: "https://permission.example/?id=7&view=full",
  });
});

it("does not acquire metadata for an already aborted non-strict lookup", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  controller.abort();
  try {
    expect((await fetchCommonsMetadata(["Photo.jpg"], { signal: controller.signal })).size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
