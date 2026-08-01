import type { RouteFlowSpan } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { buildBandFeatures, clipSpans } from "./routeFlowBands";

const M = 0.001 / 111.32;
const route = Array.from({ length: 21 }, (_, i) => [8, 50 + 100 * i * M] as [number, number]);
const span = (
  start: number,
  end: number,
  los: RouteFlowSpan["los"] = "queuing",
): RouteFlowSpan => ({
  startMeters: start,
  endMeters: end,
  los,
  confidence: "measured",
});

describe("clipSpans", () => {
  it("keeps every span when nothing has been driven", () => {
    expect(clipSpans([span(100, 400)], 0)).toEqual([span(100, 400)]);
  });

  it("drops a span entirely behind the driver", () => {
    expect(clipSpans([span(100, 400)], 600)).toEqual([]);
  });

  it("trims a span the driver is inside", () => {
    expect(clipSpans([span(100, 400)], 250)).toEqual([{ ...span(100, 400), startMeters: 250 }]);
  });

  it("drops a span the driver has all but left", () => {
    expect(clipSpans([span(100, 400)], 395)).toEqual([]);
  });
});

describe("buildBandFeatures", () => {
  it("slices the route between the span offsets", () => {
    const fc = buildBandFeatures([{ id: "r0", geometry: route, variant: "active" }], {
      r0: [span(400, 800)],
    });
    expect(fc.features).toHaveLength(1);
    const coords = (fc.features[0].geometry as GeoJSON.LineString).coordinates;
    expect(coords[0][1]).toBeGreaterThan(50 + 350 * M);
    expect(coords[coords.length - 1][1]).toBeLessThan(50 + 850 * M);
    expect(fc.features[0].properties).toMatchObject({ variant: "active", los: "queuing" });
  });

  it("carries the measured ratio through for the colour ramp", () => {
    const fc = buildBandFeatures([{ id: "r0", geometry: route, variant: "active" }], {
      r0: [{ ...span(400, 800), speedRatio: 0.3 }],
    });
    expect(fc.features[0].properties?.speedRatio).toBe(0.3);
  });

  it("tags alternate routes so they can be drawn recessed", () => {
    const fc = buildBandFeatures([{ id: "r1", geometry: route, variant: "alt" }], {
      r1: [span(200, 600)],
    });
    expect(fc.features[0].properties?.variant).toBe("alt");
  });

  it("clamps a span that runs past the end of the polyline", () => {
    const fc = buildBandFeatures([{ id: "r0", geometry: route, variant: "active" }], {
      r0: [span(1800, 9000)],
    });
    expect(fc.features).toHaveLength(1);
  });

  it("skips routes with no spans and spans on unknown routes", () => {
    const fc = buildBandFeatures([{ id: "r0", geometry: route, variant: "active" }], {
      r0: [],
      r9: [span(100, 500)],
    });
    expect(fc.features).toEqual([]);
  });

  it("applies the route's own alongMeters before slicing", () => {
    const fc = buildBandFeatures(
      [{ id: "r0", geometry: route, variant: "active", alongMeters: 600 }],
      { r0: [span(400, 800)] },
    );
    const coords = (fc.features[0].geometry as GeoJSON.LineString).coordinates;
    expect(coords[0][1]).toBeGreaterThan(50 + 550 * M);
  });

  it("degrades to nothing drawn, not a throw, when a stale alongMeters outruns the route", () => {
    // Mirrors the reroute race navRouteSplit.ts documents: alongMeters carried
    // over from a previous, longer route pushes the clipped start (and, by
    // clipSpans's own invariant, the span's end too) past what this shorter
    // route measures. Both land past `totalMeters`, so clamping collapses them
    // to the same point and the length check drops the span before it ever
    // reaches lineSliceAlong — no uncaught "Start position is beyond line".
    const fc = buildBandFeatures(
      [{ id: "r0", geometry: route, variant: "active", alongMeters: 2200 }],
      { r0: [span(1500, 2600)] },
    );
    expect(fc.features).toEqual([]);
  });
});
