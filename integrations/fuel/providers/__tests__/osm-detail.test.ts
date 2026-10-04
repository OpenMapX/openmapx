import { overpassQuerySafe } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { fuelProvider } from "../provider.js";

vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return { ...actual, overpassQuerySafe: vi.fn() };
});

describe("fuel OSM detail without a preceding search", () => {
  it.each(["node", "way", "relation"] as const)(
    "loads %s identity and coordinates",
    async (type) => {
      vi.mocked(overpassQuerySafe).mockResolvedValue({
        elements: [
          {
            type,
            id: 180629116,
            lat: 50.78,
            lon: 6.09,
            center: { lat: 50.78, lon: 6.09 },
            tags: {
              amenity: "fuel",
              name: "Shell",
              brand: "Shell",
              "brand:wikidata": "Q110716465",
            },
          },
        ],
      } as never);

      const detail = (await fuelProvider.getDetail(`osm:${type}/180629116`)).data;

      expect(detail).toMatchObject({
        id: `osm:${type}/180629116`,
        name: "Shell",
        coordinates: [6.09, 50.78],
        branding: { name: "Shell" },
        sections: [],
      });
      expect(detail?.branding?.logoUrl).toContain("commons.wikimedia.org");
    },
  );

  it("returns no detail for a non-fuel OSM element", async () => {
    vi.mocked(overpassQuerySafe).mockResolvedValue({
      elements: [{ type: "node", id: 234, lat: 50, lon: 6, tags: { amenity: "cafe" } }],
    } as never);
    expect((await fuelProvider.getDetail("osm:node/234")).data).toBeNull();
  });

  it("returns no detail when Overpass has no element", async () => {
    vi.mocked(overpassQuerySafe).mockResolvedValue({ elements: [] } as never);
    expect((await fuelProvider.getDetail("osm:way/345")).data).toBeNull();
  });

  it("returns no detail for a way without a center", async () => {
    vi.mocked(overpassQuerySafe).mockResolvedValue({
      elements: [{ type: "way", id: 456, tags: { amenity: "fuel" } }],
    });
    expect((await fuelProvider.getDetail("osm:way/456")).data).toBeNull();
  });

  it.each(["osm:way/1);node(2", "osm:way/9007199254740992"])(
    "rejects an invalid OSM identity %s without querying",
    async (id) => {
      vi.mocked(overpassQuerySafe).mockClear();
      expect((await fuelProvider.getDetail(id)).data).toBeNull();
      expect(overpassQuerySafe).not.toHaveBeenCalled();
    },
  );
});
