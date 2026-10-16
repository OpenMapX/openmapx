import type { LngLat } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { routePillAnchors } from "./routePillAnchors";

const viewport = { width: 1280, height: 800, insets: { left: 0, right: 0, top: 0, bottom: 0 } };

describe("dense route-pill geometry", () => {
  it("projects each vertex once and avoids full-route distance scans for each candidate", () => {
    const routes = [0, 1, 2].map((routeIndex) => ({
      routeIndex,
      width: 100,
      geometry: Array.from(
        { length: 50_000 },
        (_, i): LngLat => [(i / 49_999) * 1000, 200 + routeIndex * 100],
      ),
    }));
    let projections = 0;
    let coordinateReads = 0;
    const result = routePillAnchors(
      routes,
      0,
      ([x, y]) => {
        projections++;
        return {
          get x() {
            coordinateReads++;
            return x;
          },
          get y() {
            coordinateReads++;
            return y;
          },
        };
      },
      viewport,
    );
    expect(result).toHaveLength(3);
    for (const anchor of result) {
      expect(anchor.coordinate[0]).toBeCloseTo(529, 6);
      expect(anchor.coordinate[1]).toBe(200 + anchor.routeIndex * 100);
    }
    expect(projections).toBeLessThanOrEqual(150_000 + 3 * 39);
    // Instrument real projection outputs rather than a particular distance
    // primitive: a brute-force squared-distance scan must regress this too.
    expect(coordinateReads).toBeLessThan(5_000_000);
  });

  it("preserves exact bent geometry, clipping and suppression independently of vertex density", () => {
    const points: LngLat[][] = [
      [
        [-200, 200],
        [500, 200],
        [500, 700],
        [1500, 700],
      ],
      [
        [-200, 210],
        [510, 210],
        [510, 710],
        [1500, 710],
      ],
      [
        [-200, 400],
        [300, 400],
        [300, 600],
        [1500, 600],
      ],
    ];
    const dense = points.map((line) =>
      line.flatMap((a, i) => {
        const b = line[i + 1];
        if (!b) return [a];
        return Array.from(
          { length: 2000 },
          (_, step): LngLat => [
            a[0] + ((b[0] - a[0]) * step) / 2000,
            a[1] + ((b[1] - a[1]) * step) / 2000,
          ],
        );
      }),
    );
    const select = (geometry: LngLat[][]) =>
      routePillAnchors(
        geometry.map((line, routeIndex) => ({ routeIndex, width: 100, geometry: line })),
        0,
        ([x, y]) => ({ x, y }),
        viewport,
      );
    const sparseResult = select(points);
    const denseResult = select(dense);
    expect(denseResult.map((anchor) => anchor.routeIndex)).toEqual([0, 2]);
    expect(sparseResult.map((anchor) => anchor.routeIndex)).toEqual([0, 2]);
    for (let i = 0; i < denseResult.length; i++) {
      expect(denseResult[i].coordinate[0]).toBeCloseTo(sparseResult[i].coordinate[0], 6);
      expect(denseResult[i].coordinate[1]).toBeCloseTo(sparseResult[i].coordinate[1], 6);
    }
  });
});
