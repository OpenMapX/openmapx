import { describe, expect, it, vi } from "vitest";

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    searchByFilter: vi.fn().mockResolvedValue([]),
  };
});

describe("overpassProvider", () => {
  it("exposes searchByFilter as a function", async () => {
    const { overpassProvider } = await import("../index");
    expect(typeof overpassProvider.searchByFilter).toBe("function");
  });

  it("delegates searchByFilter to core searchByFilter", async () => {
    const mockResults = [{ id: "n1", name: "Café Test", coordinates: { lng: 13.4, lat: 52.5 } }];
    const coreMod = await import("@openmapx/core");
    vi.mocked(coreMod.searchByFilter).mockResolvedValue(mockResults as never);

    const { overpassProvider } = await import("../index");
    const filter = {
      selectors: [{ tags: [{ key: "amenity", value: "cafe" }] }],
    };
    const bbox = { minLng: 13.0, minLat: 52.0, maxLng: 14.0, maxLat: 53.0 };

    const result = await overpassProvider.searchByFilter?.(filter as never, bbox);
    expect(coreMod.searchByFilter).toHaveBeenCalledWith(filter, bbox);
    expect(result).toBe(mockResults);
  });
});
