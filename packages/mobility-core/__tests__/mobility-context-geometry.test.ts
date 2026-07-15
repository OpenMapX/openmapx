import { describe, expect, it } from "vitest";
import {
  classifyMobilityRules,
  normalizeAndClipMobilityGeometry,
} from "../src/mobility-context-geometry.js";

const bbox = { west: 0, south: 0, east: 10, north: 10 };

describe("mobility context geometry", () => {
  it("clips polygons deterministically while preserving holes", () => {
    const geometry = normalizeAndClipMobilityGeometry(
      {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-2, -2],
              [12, -2],
              [12, 12],
              [-2, 12],
              [-2, -2],
            ],
            [
              [2, 2],
              [4, 2],
              [4, 4],
              [2, 4],
              [2, 2],
            ],
          ],
        ],
      },
      bbox,
    );
    expect(geometry?.type).toBe("MultiPolygon");
    expect(geometry?.coordinates[0]).toHaveLength(2);
    expect(geometry?.coordinates[0]?.[0]?.[0]).toEqual([0, 0]);
  });

  it("rejects malformed geometry without affecting other features", () => {
    expect(
      normalizeAndClipMobilityGeometry(
        {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, "bad"],
              [1, 1],
              [0, 0],
            ],
          ],
        },
        bbox,
      ),
    ).toBeNull();
  });

  it("applies restriction precedence before explicit slow zones", () => {
    expect(
      classifyMobilityRules([
        {
          rideStartAllowed: true,
          rideEndAllowed: false,
          rideThroughAllowed: true,
          stationParking: true,
          maximumSpeedKph: 10,
        },
      ]),
    ).toEqual({ zoneClass: "no_parking", maximumSpeedKph: 10 });
    expect(
      classifyMobilityRules([
        {
          rideStartAllowed: true,
          rideEndAllowed: true,
          rideThroughAllowed: true,
          maximumSpeedKph: 10,
        },
      ]),
    ).toEqual({ zoneClass: "slow_zone", maximumSpeedKph: 10 });
  });
});
