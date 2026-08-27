import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGooglePhotosLink } from "./orchestrator";

afterEach(() => vi.restoreAllMocks());

function htmlResponse(imageUrl: string): Response {
  return new Response(
    `<html><head><meta property="og:image" content="${imageUrl}"></head></html>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );
}

describe("resolveGooglePhotosLink trust boundaries", () => {
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
