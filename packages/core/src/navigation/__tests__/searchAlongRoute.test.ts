import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import { poiAlongRoute, routeAheadBounds } from "../searchAlongRoute";

// Due-east route; 0.001° ≈ 111 m at the equator.
const geometry: LngLat[] = [
  [0, 0],
  [0.001, 0],
  [0.002, 0],
  [0.003, 0],
];

const poi = (id: string, lng: number, lat: number) => ({ id, coordinates: [lng, lat] as LngLat });

describe("poiAlongRoute", () => {
  it("keeps POIs ahead and within the corridor, sorted by along-distance", () => {
    const places = [
      poi("near-far", 0.0025, 0.0001), // ~278 m along, ~11 m off — ahead
      poi("near-close", 0.0015, 0.0001), // ~167 m along, ~11 m off — ahead, nearer
    ];
    const out = poiAlongRoute(places, geometry, 0, { speedMps: 14 });
    expect(out.map((o) => o.place.id)).toEqual(["near-close", "near-far"]);
    expect(out[0].deviationMeters).toBeLessThan(20);
    expect(out[0].detourMeters).toBeCloseTo(2 * out[0].deviationMeters, 5);
  });

  it("drops POIs behind the current position", () => {
    const places = [poi("behind", 0.0005, 0)];
    expect(poiAlongRoute(places, geometry, 200, {})).toEqual([]);
  });

  it("drops POIs outside the corridor", () => {
    const places = [poi("far-off", 0.0015, 0.05)]; // ~5.5 km north of the line
    expect(poiAlongRoute(places, geometry, 0, { corridorMeters: 1200 })).toEqual([]);
  });

  it("respects the look-ahead window", () => {
    const places = [poi("way-ahead", 0.0025, 0)]; // ~278 m along
    expect(poiAlongRoute(places, geometry, 0, { lookaheadMeters: 100 })).toEqual([]);
  });
});

describe("routeAheadBounds", () => {
  it("bounds the vertices within the look-ahead window", () => {
    // From 0 m, look ahead 250 m → includes vertices at 0, ~111, ~222 m (lng 0, 0.001, 0.002).
    const b = routeAheadBounds(geometry, 0, 250);
    expect(b).not.toBeNull();
    expect(b?.west).toBeCloseTo(0, 6);
    expect(b?.east).toBeCloseTo(0.002, 6);
  });

  it("returns null when nothing is in range", () => {
    expect(routeAheadBounds(geometry, 100_000, 1000)).toBeNull();
  });
});
