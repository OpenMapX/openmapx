import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOverpassQuery = vi.hoisted(() => vi.fn());
vi.mock("./overpass", () => ({
  overpassQuery: mockOverpassQuery,
}));

const { searchByOsmTags } = await import("./overpass.service");

const bbox = { south: 52.5, west: 13.4, north: 52.6, east: 13.5 };

describe("searchByOsmTags", () => {
  beforeEach(() => {
    mockOverpassQuery.mockReset();
    mockOverpassQuery.mockResolvedValue({ elements: [] });
  });

  it("ANDs multi-tag preset tag-sets onto a single element selector", async () => {
    await searchByOsmTags({ waterway: "stream", intermittent: "yes" }, bbox);
    const query = mockOverpassQuery.mock.calls[0][0] as string;
    expect(query).toContain('node["waterway"="stream"]["intermittent"="yes"]');
    expect(query).toContain('way["waterway"="stream"]["intermittent"="yes"]');
    // Must NOT split into separate union members (which would be OR)
    expect(query).not.toMatch(/node\["waterway"="stream"\]\(.*\);\s*node\["intermittent"="yes"\]/);
  });

  it("renders wildcard '*' as a key-existence predicate, not literal equality", async () => {
    await searchByOsmTags({ shop: "*" }, bbox);
    const query = mockOverpassQuery.mock.calls[0][0] as string;
    expect(query).toContain('node["shop"](');
    expect(query).toContain('way["shop"](');
    expect(query).not.toContain('"shop"="*"');
  });

  it("emits an empty union for an empty tag-set (defensive — won't match every node in bbox)", async () => {
    await searchByOsmTags({}, bbox);
    const query = mockOverpassQuery.mock.calls[0][0] as string;
    expect(query).toMatch(/\(\s*\);/);
    expect(query).not.toContain("node[");
    expect(query).not.toContain("way[");
  });

  it("includes the bbox in every selector", async () => {
    await searchByOsmTags({ amenity: "fuel" }, bbox);
    const query = mockOverpassQuery.mock.calls[0][0] as string;
    expect(query).toContain("(52.5,13.4,52.6,13.5)");
  });
});
