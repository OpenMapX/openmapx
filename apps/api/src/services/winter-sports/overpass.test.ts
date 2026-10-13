import { expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  overpassQuery: query,
}));

import { fetchWinterSportsFeatures } from "./overpass";

it("keeps independently acquired piste and area credits on their own records", async () => {
  const a = { sourceId: "osm-a", name: "Main archive" },
    b = { sourceId: "osm-b", name: "Area archive" };
  const nodes = [
    { type: "node", id: 1, lat: 50, lon: 8 },
    { type: "node", id: 2, lat: 50.01, lon: 8 },
    { type: "node", id: 3, lat: 50.01, lon: 8.01 },
  ];
  query
    .mockResolvedValueOnce({
      contributors: [a],
      elements: [
        ...nodes,
        { type: "way", id: 10, nodes: [1, 2], tags: { "piste:type": "downhill", name: "Piste" } },
      ],
    })
    .mockResolvedValueOnce({
      contributors: [b],
      elements: [
        ...nodes,
        {
          type: "way",
          id: 20,
          nodes: [1, 2, 3, 1],
          tags: { landuse: "winter_sports", name: "Area" },
        },
      ],
    });
  const result = await fetchWinterSportsFeatures(50, 8, 50.1, 8.1);
  expect(result.pistes[0].contributors).toEqual([a]);
  expect(result.areas[0].contributors).toEqual([b]);
  a.name = "Changed";
  b.name = "Changed";
  expect(result.pistes[0].contributors?.[0].name).toBe("Main archive");
  expect(result.areas[0].contributors?.[0].name).toBe("Area archive");
});
