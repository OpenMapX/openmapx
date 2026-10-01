import type { Place } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { hotelSearchBox } from "./PlaceCitySections";

function city(coordinates: [number, number], boundingBox?: Place["boundingBox"]): Place {
  return { id: "osm:relation/1", name: "City", coordinates, boundingBox } as Place;
}

describe("hotelSearchBox", () => {
  it("looks in a large city's centre, not across its whole boundary", () => {
    // Rome's boundary runs from the sea to the hills.
    const box = hotelSearchBox(city([12.4828, 41.8931], [12.2344, 41.6556, 12.8558, 42.141]));
    expect(box.south).toBeCloseTo(41.8631);
    expect(box.north).toBeCloseTo(41.9231);
    expect(box.west).toBeCloseTo(12.4528);
    expect(box.east).toBeCloseTo(12.5128);
  });

  it("keeps a small town within its boundary", () => {
    const box = hotelSearchBox(city([10.0, 50.0], [9.99, 49.995, 10.01, 50.005]));
    expect(box).toEqual({ south: 49.995, north: 50.005, west: 9.99, east: 10.01 });
  });

  it("uses the centre alone without a boundary, or with one that misses the point", () => {
    expect(hotelSearchBox(city([10, 50])).north).toBeCloseTo(50.03);
    expect(hotelSearchBox(city([10, 50], [11, 51, 12, 52])).south).toBeCloseTo(49.97);
  });
});
