import { beforeEach, describe, expect, it, vi } from "vitest";

const overpassQuery = vi.fn();
const getPlaceKnowledge = vi.fn();

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  overpassQuery: (...args: unknown[]) => overpassQuery(...args),
}));

vi.mock("../knowledge/index.js", () => ({
  getPlaceKnowledge: (...args: unknown[]) => getPlaceKnowledge(...args),
}));

const { fetchNeighborhoods } = await import("./index.js");

beforeEach(() => {
  overpassQuery.mockReset();
  getPlaceKnowledge.mockReset();
  getPlaceKnowledge.mockResolvedValue({});
});

describe("fetchNeighborhoods", () => {
  it("parses nodes/relations, dedupes by name and resolves centers", async () => {
    overpassQuery.mockResolvedValue({
      elements: [
        { type: "node", id: 1, lat: 51.2, lon: 6.8, tags: { name: "Altstadt", place: "suburb" } },
        // Duplicate name via a relation — should be dropped.
        {
          type: "relation",
          id: 2,
          center: { lat: 51.21, lon: 6.81 },
          tags: { name: "Altstadt", place: "suburb" },
        },
        {
          type: "way",
          id: 3,
          center: { lat: 51.3, lon: 6.9 },
          tags: { name: "Oberkassel", place: "neighbourhood" },
        },
        // No name — skipped.
        { type: "node", id: 4, lat: 51.4, lon: 6.7, tags: { place: "quarter" } },
      ],
    });

    const { neighborhoods } = await fetchNeighborhoods(51, 6, 52, 7);

    expect(neighborhoods).toHaveLength(2);
    const altstadt = neighborhoods.find((n) => n.name === "Altstadt");
    expect(altstadt?.coordinates).toEqual([6.8, 51.2]);
    expect(neighborhoods.map((n) => n.name)).toContain("Oberkassel");
  });

  it("enriches wiki-tagged entries with a first-sentence blurb and photo", async () => {
    overpassQuery.mockResolvedValue({
      elements: [
        {
          type: "node",
          id: 1,
          lat: 51.2,
          lon: 6.8,
          tags: { name: "Altstadt", place: "suburb", wikidata: "Q123" },
        },
      ],
    });
    getPlaceKnowledge.mockResolvedValue({
      wikipediaExtract: "Altstadt is the old town. It has many pubs and a long promenade.",
      wikipediaUrl: "https://en.wikipedia.org/wiki/Altstadt",
      photos: [{ url: "https://img/full.jpg", thumbnailUrl: "https://img/thumb.jpg" }],
    });

    const { neighborhoods } = await fetchNeighborhoods(51, 6, 52, 7);

    expect(neighborhoods[0]).toMatchObject({
      name: "Altstadt",
      description: "Altstadt is the old town.",
      photoUrl: "https://img/thumb.jpg",
      wikipediaUrl: "https://en.wikipedia.org/wiki/Altstadt",
    });
  });

  it("ranks encyclopaedically-referenced neighbourhoods first", async () => {
    overpassQuery.mockResolvedValue({
      elements: [
        { type: "node", id: 1, lat: 51.2, lon: 6.8, tags: { name: "Zzz", place: "suburb" } },
        {
          type: "node",
          id: 2,
          lat: 51.3,
          lon: 6.9,
          tags: { name: "Aaa", place: "suburb", wikipedia: "de:Aaa" },
        },
      ],
    });

    const { neighborhoods } = await fetchNeighborhoods(51, 6, 52, 7);

    expect(neighborhoods[0].name).toBe("Aaa");
    expect(neighborhoods[1].name).toBe("Zzz");
  });

  it("leaves non-wiki entries un-enriched (no knowledge lookup)", async () => {
    overpassQuery.mockResolvedValue({
      elements: [
        { type: "node", id: 1, lat: 51.2, lon: 6.8, tags: { name: "Plain", place: "suburb" } },
      ],
    });

    const { neighborhoods } = await fetchNeighborhoods(51, 6, 52, 7);

    expect(getPlaceKnowledge).not.toHaveBeenCalled();
    expect(neighborhoods[0]).toEqual({ id: "node/1", name: "Plain", coordinates: [6.8, 51.2] });
  });
});
