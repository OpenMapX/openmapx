import { describe, expect, it } from "vitest";
import { resolveDistanceReference, resultDistanceMetres } from "../resultReference";

const bbox = { west: 13.3, south: 52.4, east: 13.5, north: 52.6 };

describe("result distance reference", () => {
  it("uses a named supplied origin ahead of the captured area", () => {
    expect(
      resolveDistanceReference({
        anchor: { name: "Station", coordinates: [13.35, 52.45] },
        userLocation: [13.45, 52.55],
        searchBbox: bbox,
      }),
    ).toEqual({
      kind: "search_origin",
      coordinates: [13.35, 52.45],
      name: "Station",
    });
  });

  it("uses a valid known user location ahead of the captured area", () => {
    expect(
      resolveDistanceReference({ anchor: null, userLocation: [13.45, 52.55], searchBbox: bbox }),
    ).toEqual({ kind: "user_location", coordinates: [13.45, 52.55] });
    expect(
      resolveDistanceReference({
        anchor: null,
        userLocation: [Number.NaN, 52.55],
        searchBbox: bbox,
      }),
    ).toEqual({ kind: "search_area_center", coordinates: [13.4, 52.5] });
  });

  it("uses an NLP coordinate origin ahead of a known user location", () => {
    expect(
      resolveDistanceReference({
        anchor: null,
        searchOrigin: { coordinates: [13.35, 52.45] },
        userLocation: [13.45, 52.55],
        searchBbox: bbox,
      }),
    ).toEqual({ kind: "search_origin", coordinates: [13.35, 52.45] });
  });

  it("uses only the captured search box, which changes on a new search", () => {
    expect(resolveDistanceReference({ anchor: null, searchBbox: bbox })).toEqual({
      kind: "search_area_center",
      coordinates: [13.4, 52.5],
    });
    expect(
      resolveDistanceReference({ anchor: null, searchBbox: { ...bbox, east: 13.7 } })
        ?.coordinates[0],
    ).toBe(13.5);
  });

  it("omits distances for absent or invalid coordinates", () => {
    const reference = resolveDistanceReference({ anchor: null, searchBbox: bbox });
    expect(resultDistanceMetres(reference, [181, 52.5])).toBeNull();
    expect(resultDistanceMetres(reference, [Number.NaN, 52.5])).toBeNull();
    expect(resultDistanceMetres(null, [13.4, 52.5])).toBeNull();
  });
});
