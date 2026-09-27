import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGooglePhotosLink, searchHeroPhotos } from "./orchestrator";

afterEach(() => vi.restoreAllMocks());

function htmlResponse(imageUrl: string): Response {
  return new Response(
    `<html><head><meta property="og:image" content="${imageUrl}"></head></html>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );
}

describe("resolveGooglePhotosLink trust boundaries", () => {
  it("publishes direct and provider photos before a slow share preview settles", async () => {
    const response = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    const direct = "https://commons.wikimedia.org/wiki/Special:FilePath/Ready.jpg?width=1200";
    const providerPhoto = { url: "https://upload.wikimedia.org/provider.jpg", source: "wikimedia" };
    const seen: string[] = [];
    const provider = {
      id: "wikimedia",
      name: "Wikimedia",
      search: async () => [],
      searchByTags: async () => [providerPhoto],
    };
    const work = searchHeroPhotos(
      {
        image: "https://photos.google.com/share/slow",
        "image:1": "File:Ready.jpg",
        wikimedia_commons: "File:Provider.jpg",
      },
      [provider],
      { strict: true, onPhotos: (photos) => seen.push(...photos.map((photo) => photo.url)) },
    );
    try {
      await vi.waitFor(() =>
        expect(seen).toEqual(expect.arrayContaining([direct, providerPhoto.url])),
      );
    } finally {
      response.resolve(new Response("<html></html>", { status: 200 }));
      await work;
    }
  });
  it("reports a strict preview rate limit instead of confirming photo absence", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("busy", { status: 429, headers: { "Retry-After": "6" } }),
    );
    const errors: unknown[] = [];
    const photos = await searchHeroPhotos({ image: "https://photos.google.com/share/abc" }, [], {
      strict: true,
      onError: (error) => errors.push(error),
    });
    expect(photos).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ status: 429, retryAfterMs: 6000 })]);
  });

  it("cancels a rejected preview body without hiding its rate limit", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 429, headers: { "Retry-After": "6" } }),
    );
    const errors: unknown[] = [];
    const started = Date.now();
    await searchHeroPhotos({ image: "https://photos.google.com/share/rejected" }, [], {
      strict: true,
      onError: (error) => errors.push(error),
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(errors).toEqual([expect.objectContaining({ status: 429, retryAfterMs: 6000 })]);
  });
  it.each([
    "https://evil.attacker.test/image.jpg",
    "http://lh3.googleusercontent.com/image.jpg",
    "https://lh2.googleusercontent.com/image.jpg",
    "javascript:alert(1)",
  ])("rejects an unsafe og:image URL %s", async (imageUrl) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse(imageUrl));

    await expect(resolveGooglePhotosLink("https://photos.google.com/share/abc")).resolves.toEqual(
      [],
    );
  });

  it("rejects a short-link redirect that only mentions photos.google.com in its query", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.attacker.test/?next=photos.google.com/share/abc" },
      }),
    );

    await expect(resolveGooglePhotosLink("https://photos.app.goo.gl/abc")).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts only an HTTPS Google image host from safe share-page redirects", async () => {
    const imageUrl =
      "https://lh4.googleusercontent.com/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789=w800";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://photos.google.com/share/abc" },
        }),
      )
      .mockResolvedValueOnce(htmlResponse(imageUrl));

    await expect(resolveGooglePhotosLink("https://photos.app.goo.gl/abc")).resolves.toEqual([
      imageUrl.replace(/=w800$/, "=w2048"),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({ redirect: "manual" });
  });
});
