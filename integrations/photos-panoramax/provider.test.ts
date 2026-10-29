import { afterEach, describe, expect, it, vi } from "vitest";
import { panoramaxPhotoProvider } from "./provider";

const item = {
  type: "Feature",
  id: "photo-1",
  geometry: { type: "Point", coordinates: [2.3521, 48.8573] },
  properties: { datetime: "2025-09-23T13:33:04Z", license: "CC-BY-SA-4.0" },
  assets: { sd: { href: "https://example.test/photo.jpg" } },
  links: [{ rel: "license", href: "https://creativecommons.org/licenses/by-sa/4.0/" }],
};

afterEach(() => vi.unstubAllGlobals());

describe("Panoramax gallery creator receipts", () => {
  it.each([
    {
      name: "producer after the host",
      providers: [
        { name: "Hosting instance", roles: ["host"] },
        { name: " Creator ", roles: ["producer"] },
      ],
      producer: "Other account",
      author: "Creator",
    },
    {
      name: "string fallback when producer name is blank",
      providers: [{ name: "  ", roles: ["producer"] }],
      producer: " Fallback creator ",
      author: "Fallback creator",
    },
    {
      name: "host without creator evidence",
      providers: [{ name: "Hosting instance", roles: ["host"] }],
      producer: undefined,
      author: undefined,
    },
    { name: "blank creator", providers: [], producer: "  ", author: undefined },
  ])("captures $name without inventing a publisher", async ({ providers, producer, author }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          type: "FeatureCollection",
          features: [
            {
              ...item,
              providers,
              properties: { ...item.properties, "geovisio:producer": producer },
            },
          ],
        }),
      ),
    );
    const [photo] = await panoramaxPhotoProvider.search({ lat: 48.8573, lng: 2.3521 });
    expect(photo.author).toBe(author);
    expect(photo.contributors?.[0].publisher).toEqual(
      author ? { name: author, url: undefined } : undefined,
    );
    expect(photo.pageUrl).toBe("https://panoramax.xyz/#focus=pic&pic=photo-1");
  });
});
