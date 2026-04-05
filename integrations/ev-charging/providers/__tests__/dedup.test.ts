import type { DataSourceResult } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { deduplicateByCoordinates } from "../dedup.js";

function makeResult(
  overrides: Partial<DataSourceResult> & Pick<DataSourceResult, "id" | "coordinates">,
): DataSourceResult {
  return {
    name: "Charger",
    source: "ocm",
    variant: "available",
    ...overrides,
  };
}

describe("deduplicateByCoordinates", () => {
  it("returns empty array for empty input", () => {
    expect(deduplicateByCoordinates([])).toEqual([]);
  });

  it("returns a single result unchanged", () => {
    const result = makeResult({ id: "ocm-1", coordinates: [13.377, 52.52] });
    const deduped = deduplicateByCoordinates([result]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("ocm-1");
  });

  it("deduplicates two results in the same grid cell (~11m)", () => {
    // Both round to the same 4dp key: lat Math.round(525200.1)=525200, lng Math.round(133770.1)=133770
    // and lat Math.round(525200.3)=525200, lng Math.round(133770.3)=133770
    const ocm = makeResult({
      id: "ocm-1",
      coordinates: [13.37701, 52.52001],
      source: "ocm",
    });
    const osm = makeResult({
      id: "osm-1",
      coordinates: [13.37703, 52.52003],
      source: "osm",
    });
    const deduped = deduplicateByCoordinates([ocm, osm]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("ocm-1");
    expect(deduped[0].source).toBe("ocm");
  });

  it("keeps results in different grid cells", () => {
    const a = makeResult({
      id: "ocm-1",
      coordinates: [13.377, 52.52],
    });
    const b = makeResult({
      id: "ocm-2",
      coordinates: [13.389, 52.531],
    });
    const deduped = deduplicateByCoordinates([a, b]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].id).toBe("ocm-1");
    expect(deduped[1].id).toBe("ocm-2");
  });

  it("first-seen wins — OCM before OSM gives OCM priority", () => {
    const ocm = makeResult({
      id: "ocm-1",
      coordinates: [13.377, 52.52],
      source: "ocm",
      name: "OCM Charger",
    });
    const osm = makeResult({
      id: "osm-1",
      coordinates: [13.37704, 52.52003],
      source: "osm",
      name: "OSM Charger",
    });
    const deduped = deduplicateByCoordinates([ocm, osm]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("ocm-1");
    expect(deduped[0].source).toBe("ocm");
    expect(deduped[0].name).toBe("OCM Charger");
  });

  it("OSM wins if it appears first", () => {
    const osm = makeResult({
      id: "osm-1",
      coordinates: [13.377, 52.52],
      source: "osm",
    });
    const ocm = makeResult({
      id: "ocm-1",
      coordinates: [13.37704, 52.52003],
      source: "ocm",
    });
    const deduped = deduplicateByCoordinates([osm, ocm]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("osm-1");
    expect(deduped[0].source).toBe("osm");
  });

  it("uses Math.round on lat*10000 and lng*10000 for grid key", () => {
    // lat=52.52005 → round(525200.5) = 525201 (rounds up)
    // lat=52.52014 → round(525201.4) = 525201 (same bucket)
    const a = makeResult({
      id: "a",
      coordinates: [13.377, 52.52005],
    });
    const b = makeResult({
      id: "b",
      coordinates: [13.377, 52.52014],
    });
    const deduped = deduplicateByCoordinates([a, b]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("a");
  });

  it("handles multiple groups, keeping one per cell", () => {
    const results = [
      makeResult({ id: "ocm-1", coordinates: [13.377, 52.52], source: "ocm" }),
      makeResult({ id: "osm-1", coordinates: [13.37704, 52.52003], source: "osm" }),
      makeResult({ id: "ocm-2", coordinates: [13.4, 52.55], source: "ocm" }),
      makeResult({ id: "osm-2", coordinates: [13.40004, 52.55003], source: "osm" }),
      makeResult({ id: "ocm-3", coordinates: [14.0, 51.0], source: "ocm" }),
    ];
    const deduped = deduplicateByCoordinates(results);
    expect(deduped).toHaveLength(3);
    expect(deduped[0].id).toBe("ocm-1");
    expect(deduped[1].id).toBe("ocm-2");
    expect(deduped[2].id).toBe("ocm-3");
  });

  it("treats coordinates that round to different cells as distinct", () => {
    // lat=52.52004 → round(525200.4) = 525200
    // lat=52.52006 → round(525200.6) = 525201  (different bucket)
    const a = makeResult({ id: "a", coordinates: [13.377, 52.52004] });
    const b = makeResult({ id: "b", coordinates: [13.377, 52.52006] });
    const deduped = deduplicateByCoordinates([a, b]);
    expect(deduped).toHaveLength(2);
  });

  it("preserves all fields on the surviving result", () => {
    const result = makeResult({
      id: "ocm-42",
      coordinates: [13.377, 52.52],
      source: "ocm",
      name: "EV Station Berlin",
      variant: "operational",
      status: "operational",
      summary: "22kW AC",
      operator: "Ionity",
      sortValues: { power: 22 },
    });
    const deduped = deduplicateByCoordinates([result]);
    expect(deduped[0].id).toBe("ocm-42");
    expect(deduped[0].name).toBe("EV Station Berlin");
    expect(deduped[0].source).toBe("ocm");
    expect(deduped[0].variant).toBe("operational");
    expect(deduped[0].status).toBe("operational");
    expect(deduped[0].summary).toBe("22kW AC");
    expect(deduped[0].operator).toBe("Ionity");
    expect(deduped[0].sortValues).toEqual({ power: 22 });
    expect(deduped[0].coordinates).toEqual([13.377, 52.52]);
  });
});
