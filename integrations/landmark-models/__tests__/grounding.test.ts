import { nth } from "@openmapx/integration-framework/testing";
import type { Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import { groundHeight, type TerrainProbe } from "../web/grounding";

const ANCHOR: [number, number] = [-122.4058, 37.8024];
const FOOTPRINT: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [-122.406, 37.8022],
      [-122.4056, 37.8022],
      [-122.4056, 37.8026],
      [-122.406, 37.8026],
      [-122.406, 37.8022],
    ],
  ],
};

function probe(
  heights: (lngLat: [number, number]) => { state: "loaded" | "loading" | "none"; drawn?: number },
  enabled = true,
): TerrainProbe {
  return { enabled: () => enabled, sample: heights };
}

describe("groundHeight", () => {
  it("returns 0 with terrain off", () => {
    const off = probe(() => ({ state: "loaded", drawn: 50 }), false);
    expect(groundHeight({ anchor: ANCHOR, grounding: "anchor" }, FOOTPRINT, off)).toBe(0);
  });

  it("waits while demState is loading", () => {
    // A raw elevation query would answer 0 here; the probe exposes the state.
    const loading = probe(() => ({ state: "loading" }));
    expect(groundHeight({ anchor: ANCHOR, grounding: "anchor" }, FOOTPRINT, loading)).toBe(
      "pending",
    );
  });

  it("uses the anchor for anchor grounding", () => {
    const sloped = probe(([lng]) => ({ state: "loaded", drawn: lng > -122.4058 ? 80 : 60 }));
    expect(groundHeight({ anchor: ANCHOR, grounding: "anchor" }, FOOTPRINT, sloped)).toBe(60);
  });

  it("uses the lowest of anchor and footprint for footprint-minimum", () => {
    const sloped = probe(([lng]) => ({ state: "loaded", drawn: 70 + (lng + 122.406) * 10_000 }));
    expect(
      groundHeight({ anchor: ANCHOR, grounding: "footprint-minimum" }, FOOTPRINT, sloped),
    ).toBeCloseTo(70, 6);
  });

  it("does not sample a footprint position without two coordinates", () => {
    const sampled: [number, number][] = [];
    const flat = probe((lngLat) => {
      sampled.push(lngLat);
      return { state: "loaded", drawn: 5 };
    });
    const footprint: Polygon = {
      type: "Polygon",
      coordinates: [[[-122.406, 37.8022], [-122.4056], [-122.4056, 37.8026], [-122.406, 37.8022]]],
    };
    expect(groundHeight({ anchor: ANCHOR, grounding: "footprint-minimum" }, footprint, flat)).toBe(
      5,
    );
    expect(sampled).toEqual([ANCHOR, [-122.406, 37.8022], [-122.4056, 37.8026]]);
  });

  it("moves from a parent value to the own-tile value", () => {
    let ownTileLoaded = false;
    const terrain = probe(() =>
      ownTileLoaded ? { state: "loaded", drawn: 42 } : { state: "loaded" },
    );
    expect(groundHeight({ anchor: ANCHOR, grounding: "anchor" }, undefined, terrain)).toBe(
      "pending",
    );
    ownTileLoaded = true;
    expect(groundHeight({ anchor: ANCHOR, grounding: "anchor" }, undefined, terrain)).toBe(42);
  });

  it("samples at most 16 footprint vertices", () => {
    const ring = Array.from({ length: 100 }, (_, i) => {
      const angle = (i / 100) * Math.PI * 2;
      return [ANCHOR[0] + Math.cos(angle) * 0.001, ANCHOR[1] + Math.sin(angle) * 0.001];
    });
    ring.push(nth(ring, 0));
    let samples = 0;
    const counting = probe(() => {
      samples += 1;
      return { state: "loaded", drawn: 1 };
    });
    groundHeight(
      { anchor: ANCHOR, grounding: "footprint-minimum" },
      { type: "Polygon", coordinates: [ring] },
      counting,
    );
    expect(samples).toBeLessThanOrEqual(17);
  });
});
