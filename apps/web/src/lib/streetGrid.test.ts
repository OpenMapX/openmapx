import type { MapGeoJSONFeature } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { createFakeMap } from "@/test";
import {
  ALIGN_MIN_WEIGHT_PX,
  ALIGN_MIN_ZOOM,
  alignmentCacheKey,
  computeStreetGridAlignment,
  roadLineLayerIds,
  sampleRoadSegments,
  visibleSampleBox,
} from "./streetGrid";

const roadLayers = [
  { id: "highway-minor", type: "line", "source-layer": "transportation" },
  { id: "highway-name-minor", type: "symbol", "source-layer": "transportation_name" },
  { id: "road_secondary", type: "line", "source-layer": "transportation" },
  { id: "water", type: "fill", "source-layer": "water" },
];

function line(cls: string, coords: [number, number][], id?: number): MapGeoJSONFeature {
  return {
    type: "Feature",
    id,
    properties: { class: cls },
    geometry: { type: "LineString", coordinates: coords },
  } as unknown as MapGeoJSONFeature;
}

function totalWeight(samples: { weight: number }[]): number {
  return samples.reduce((sum, sample) => sum + sample.weight, 0);
}

function gridMap(angleDeg: number, zoom = 15) {
  const fake = createFakeMap({
    zoom,
    baseLayers: roadLayers as never,
    project: ([lng, lat]) => ({ x: lng * 100000, y: -lat * 100000 }),
  });
  const rad = (angleDeg * Math.PI) / 180;
  const features: MapGeoJSONFeature[] = [];
  for (let i = 0; i < 10; i += 1) {
    const dx = Math.sin(rad) * 0.01;
    const dy = Math.cos(rad) * 0.01;
    features.push(
      line("minor", [
        [i * 0.001, 0],
        [i * 0.001 + dx, dy],
      ]),
    );
    features.push(
      line("tertiary", [
        [0, i * 0.001],
        [dy, i * 0.001 - dx],
      ]),
    );
  }
  fake.setRenderedFeatures("highway-minor", features);
  return fake;
}

describe("streetGrid", () => {
  it("discovers transportation line layers for either basemap flavour", () => {
    const fake = createFakeMap({ baseLayers: roadLayers as never });
    expect(roadLineLayerIds(fake.map)).toEqual(["highway-minor", "road_secondary"]);
  });

  it("samples the central 70 % of the visible viewport, inset per axis", () => {
    const fake = createFakeMap({ containerWidth: 1000, containerHeight: 800 });
    fake.map.setPadding({ top: 0, bottom: 200, left: 200, right: 0 });
    expect(visibleSampleBox(fake.map)).toEqual([
      [320, 90],
      [880, 510],
    ]);
  });

  it("measures segments by on-screen pixel length and skips unwanted classes", () => {
    const fake = createFakeMap({
      baseLayers: roadLayers as never,
      project: ([lng, lat]) => ({ x: lng * 1000, y: -lat * 1000 }),
    });
    fake.setRenderedFeatures("highway-minor", [
      line("minor", [
        [0, 0],
        [0, 1],
      ]),
      line("service", [
        [0, 0],
        [1, 0],
      ]),
      line("rail", [
        [0, 0],
        [1, 0],
      ]),
    ]);
    const samples = sampleRoadSegments(fake.map);
    expect(samples).toHaveLength(1);
    expect(samples[0].weight).toBeCloseTo(1000, 3);
    expect(samples[0].bearing).toBeCloseTo(0, 3);
  });

  it("scales equally long segments by their road class", () => {
    const fake = createFakeMap({
      baseLayers: roadLayers as never,
      project: ([lng, lat]) => ({ x: lng * 1000, y: -lat * 1000 }),
    });
    fake.setRenderedFeatures("highway-minor", [
      line("secondary", [
        [0, 0],
        [0, 1],
      ]),
      line("motorway", [
        [1, 0],
        [1, 1],
      ]),
    ]);
    expect(sampleRoadSegments(fake.map).map((sample) => sample.weight)).toEqual([900, 300]);
  });

  it("counts a feature drawn by several layers once", () => {
    const fake = createFakeMap({
      baseLayers: roadLayers as never,
      project: ([lng, lat]) => ({ x: lng * 1000, y: -lat * 1000 }),
    });
    const road = line(
      "minor",
      [
        [0, 0],
        [0, 1],
      ],
      42,
    );
    // A style draws one road from several layers: casing, fill, bridge variant.
    fake.setRenderedFeatures("highway-minor", [road]);
    fake.setRenderedFeatures("road_secondary", [road]);
    expect(sampleRoadSegments(fake.map)).toHaveLength(1);
  });

  it("aligns to the nearest grid bearing when a confident grid is present", () => {
    const fake = gridMap(30);
    expect(computeStreetGridAlignment(fake.map)).toEqual({ status: "ok", bearing: 30 });
  });

  it("reports aligned inside the dead band, zoomed-out below the gate, and no-grid without roads", () => {
    const aligned = gridMap(30);
    aligned.state.bearing = 31;
    expect(computeStreetGridAlignment(aligned.map)).toEqual({ status: "aligned" });
    expect(computeStreetGridAlignment(gridMap(30, ALIGN_MIN_ZOOM - 1).map)).toEqual({
      status: "zoomed-out",
    });
    const empty = createFakeMap({ zoom: 15, baseLayers: roadLayers as never });
    expect(computeStreetGridAlignment(empty.map)).toEqual({ status: "no-grid" });
  });

  it("refuses a confident direction carried by too few road pixels", () => {
    const fake = createFakeMap({
      zoom: 15,
      baseLayers: roadLayers as never,
      project: ([lng, lat]) => ({ x: lng * 1000, y: -lat * 1000 }),
    });
    const rad = (20 * Math.PI) / 180;
    fake.setRenderedFeatures(
      "highway-minor",
      Array.from({ length: 10 }, (_, i) =>
        line("minor", [
          [i * 0.01, 0],
          [i * 0.01 + Math.sin(rad) * 0.05, Math.cos(rad) * 0.05],
        ]),
      ),
    );
    const weight = totalWeight(sampleRoadSegments(fake.map));
    expect(weight).toBeGreaterThan(0);
    expect(weight).toBeLessThan(ALIGN_MIN_WEIGHT_PX);
    expect(computeStreetGridAlignment(fake.map)).toEqual({ status: "no-grid" });
  });

  it("refuses a roundabout that fills the viewport without an axis", () => {
    const fake = createFakeMap({
      zoom: 15,
      baseLayers: roadLayers as never,
      project: ([lng, lat]) => ({ x: lng * 100000, y: -lat * 100000 }),
    });
    const steps = 36;
    const ring: [number, number][] = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = (i / steps) * Math.PI * 2;
      ring.push([Math.sin(t) * 0.005, Math.cos(t) * 0.005]);
    }
    fake.setRenderedFeatures("highway-minor", [line("minor", ring)]);
    const samples = sampleRoadSegments(fake.map);
    // Plenty of samples, plenty of weight: only the resultant length rejects them.
    expect(samples).toHaveLength(steps);
    expect(totalWeight(samples)).toBeGreaterThan(ALIGN_MIN_WEIGHT_PX);
    expect(computeStreetGridAlignment(fake.map)).toEqual({ status: "no-grid" });
  });

  it("survives a style teardown race", () => {
    const fake = gridMap(30);
    (fake.map as unknown as { getStyle: () => unknown }).getStyle = () => {
      throw new Error("style removed");
    };
    expect(computeStreetGridAlignment(fake.map)).toEqual({ status: "no-grid" });
  });

  it("keys the memo on style, zoom bucket, rounded center and bearing", () => {
    const fake = createFakeMap({
      zoom: 15.13,
      bearing: 10.3,
      center: { lng: 8.12345678, lat: 50.1 },
    });
    expect(alignmentCacheKey(fake.map, 2)).toBe("2:15.25:8.1235:50.1000:10.5");
  });
});
