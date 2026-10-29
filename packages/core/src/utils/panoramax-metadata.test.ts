import { describe, expect, it } from "vitest";
import { panoramaxAuthor } from "./panoramax-metadata";

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
