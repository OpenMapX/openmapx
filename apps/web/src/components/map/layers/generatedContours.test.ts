import { afterEach, describe, expect, it, vi } from "vitest";
import { contourDemTileUrl } from "./generatedContours";

afterEach(() => vi.restoreAllMocks());

describe("contour DEM tile URL", () => {
  it("uses the configured local tile template without a TileJSON request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await contourDemTileUrl("/dem/{z}/{x}/{y}.webp", "/dem/tiles.json")).toBe(
      "/dem/{z}/{x}/{y}.webp",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("derives the template from custom TileJSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ tiles: ["/dem/{z}/{x}/{y}.webp"] }),
    );
    expect(await contourDemTileUrl("", "/dem/tiles.json")).toBe("/dem/{z}/{x}/{y}.webp");
  });
});
