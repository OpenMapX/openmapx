import { describe, expect, it, vi } from "vitest";

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    searchByFilter: vi.fn().mockResolvedValue([]),
  };
});

describe("overpassProvider", () => {
  it("delegates searchByFilter to core searchByFilter", async () => {
    const mockResults = [{ id: "n1", name: "Café Test", coordinates: { lng: 13.4, lat: 52.5 } }];
    const coreMod = await import("@openmapx/core");
    vi.mocked(coreMod.searchByFilter).mockResolvedValue(mockResults as never);

    const { overpassProvider } = await import("../index");
    const filter = {
      selectors: [{ tags: [{ key: "amenity", value: "cafe" }] }],
    };
    const bbox = { west: 13.0, south: 52.0, east: 14.0, north: 53.0 };

    const result = await overpassProvider.searchByFilter?.(filter as never, bbox);
    expect(coreMod.searchByFilter).toHaveBeenCalledWith(filter, bbox);
    expect(result).toBe(mockResults);
  });
});
