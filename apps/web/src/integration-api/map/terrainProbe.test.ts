import type { Map as MaplibreMap } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import { mapTerrainProbe } from "./terrainProbe";

function fakeMap(options: {
  terrain: boolean;
  demState?: "loaded" | "loading" | "none";
  drawn?: number;
}) {
  const getElevationAndDEMStateForLngLat = vi.fn(() => ({
    elevation: 0,
    demState: options.demState ?? "loaded",
  }));
  const getDrawnElevationForLngLat = vi.fn(() => options.drawn);
  const map = {
    getTerrain: () => (options.terrain ? { source: "dem" } : null),
    getZoom: () => 16.7,
    terrain: options.terrain
      ? { getElevationAndDEMStateForLngLat, getDrawnElevationForLngLat }
      : undefined,
  };
  return { map: map as unknown as MaplibreMap, getElevationAndDEMStateForLngLat };
}

describe("mapTerrainProbe", () => {
  it("is disabled and samples nothing without terrain", () => {
    const probe = mapTerrainProbe(fakeMap({ terrain: false }).map);
    expect(probe.enabled()).toBe(false);
    expect(probe.sample([13.4, 52.5])).toEqual({ state: "none" });
  });

  it("reports the DEM state at the floored zoom and the drawn tile's own height", () => {
    const { map, getElevationAndDEMStateForLngLat } = fakeMap({ terrain: true, drawn: 42 });
    const probe = mapTerrainProbe(map);
    expect(probe.enabled()).toBe(true);
    expect(probe.sample([13.4, 52.5])).toEqual({ state: "loaded", drawn: 42 });
    expect(getElevationAndDEMStateForLngLat).toHaveBeenCalledWith(
      expect.objectContaining({ lng: 13.4, lat: 52.5 }),
      16,
    );
  });

  it("omits the height while only a parent tile is drawn", () => {
    const probe = mapTerrainProbe(fakeMap({ terrain: true, demState: "loading" }).map);
    expect(probe.sample([13.4, 52.5])).toEqual({ state: "loading" });
  });
});
