import { describe, expect, it } from "vitest";
import { panoramaxAuthor, panoramaxPictureAssetUrl } from "./panoramax-metadata";

describe("Panoramax creator metadata", () => {
  it("accepts an immutable STAC receipt without crediting the host", () => {
    const item = {
      providers: [
        { name: "Host", roles: ["host"] },
        { name: " Creator ", roles: ["producer"] },
      ],
      properties: { "geovisio:producer": "Other account" },
    } as const;
    expect(panoramaxAuthor(item)).toBe("Creator");
    expect(item.providers[1].name).toBe(" Creator ");
  });

  it.each([
    { properties: { "geovisio:producer": " Fallback creator " }, author: "Fallback creator" },
    { properties: { "geovisio:producer": "  " }, author: undefined },
    { properties: undefined, author: undefined },
  ])("keeps unknown creators unknown and trims a supplied string", ({ properties, author }) => {
    expect(panoramaxAuthor({ properties })).toBe(author);
  });
});

describe("Panoramax picture asset URLs", () => {
  const ID = "7462790e-3e1c-4ee5-b6b3-b544421afd84";

  it("addresses the catalogue's own per-picture endpoint", () => {
    expect(panoramaxPictureAssetUrl("https://api.panoramax.xyz/api", ID, "sd")).toBe(
      `https://api.panoramax.xyz/api/pictures/${ID}/sd.jpg`,
    );
    expect(panoramaxPictureAssetUrl("https://api.panoramax.xyz/api/", ID.toUpperCase(), "hd")).toBe(
      `https://api.panoramax.xyz/api/pictures/${ID}/hd.jpg`,
    );
  });

  it.each([undefined, "", "photo-1", `${ID}/../../admin`])(
    "builds nothing for an id that is not a picture UUID: %s",
    (id) => {
      expect(
        panoramaxPictureAssetUrl("https://api.panoramax.xyz/api", id, "thumb"),
      ).toBeUndefined();
    },
  );
});
