import type { DataSourceResult } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { deduplicateByCoordinates } from "../dedup.js";

function makeResult(
  overrides: Partial<DataSourceResult> & Pick<DataSourceResult, "id" | "coordinates">,
): DataSourceResult {
  return {
    name: "Webcam",
    source: "windy",
    variant: "landscape",
    ...overrides,
  };
}

describe("deduplicateByCoordinates", () => {
  it("returns empty array for empty input", () => {
    expect(deduplicateByCoordinates([])).toEqual([]);
  });

  it("returns a single result unchanged", () => {
    const result = makeResult({ id: "windy:1", coordinates: [13.377, 52.52] });
    const deduped = deduplicateByCoordinates([result]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("windy:1");
  });

  it("deduplicates two results in the same grid cell", () => {
    const windy = makeResult({
      id: "windy:1",
      coordinates: [13.37701, 52.52001],
      source: "windy",
    });
    const osm = makeResult({
      id: "osm-webcam:1",
      coordinates: [13.37703, 52.52003],
      source: "osm-webcam",
    });
    const deduped = deduplicateByCoordinates([windy, osm]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("windy:1");
  });

  it("keeps results in different grid cells", () => {
    const a = makeResult({ id: "windy:1", coordinates: [13.377, 52.52] });
    const b = makeResult({ id: "windy:2", coordinates: [13.389, 52.531] });
    const deduped = deduplicateByCoordinates([a, b]);
    expect(deduped).toHaveLength(2);
  });

  it("first-seen wins - Windy before OSM gives Windy priority", () => {
    const windy = makeResult({
      id: "windy:1",
      coordinates: [13.377, 52.52],
      source: "windy",
      name: "Windy Cam",
    });
    const osm = makeResult({
      id: "osm-webcam:1",
      coordinates: [13.37704, 52.52003],
      source: "osm-webcam",
      name: "OSM Cam",
    });
    const deduped = deduplicateByCoordinates([windy, osm]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].source).toBe("windy");
    expect(deduped[0].name).toBe("Windy Cam");
  });

  it("handles multiple groups", () => {
    const results = [
      makeResult({ id: "windy:1", coordinates: [13.377, 52.52], source: "windy" }),
      makeResult({ id: "osm-webcam:1", coordinates: [13.37704, 52.52003], source: "osm-webcam" }),
      makeResult({ id: "windy:2", coordinates: [13.4, 52.55], source: "windy" }),
      makeResult({ id: "tfl:1", coordinates: [-0.1, 51.5], source: "tfl" }),
    ];
    const deduped = deduplicateByCoordinates(results);
    expect(deduped).toHaveLength(3);
  });
});
