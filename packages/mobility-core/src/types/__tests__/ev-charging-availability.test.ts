import { describe, expect, it } from "vitest";
import type { EvChargingStation, EvseAvailability } from "../ev-charging.js";

describe("EvChargingStation availability", () => {
  it("carries a station-level availability rollup and isLive flag", () => {
    const availability: EvseAvailability = {
      available: 3,
      total: 6,
      updatedAt: "2026-07-20T10:00:00Z",
    };
    const station: EvChargingStation = {
      id: "swiss-sfoe:x",
      name: "X",
      coordinates: [8, 47],
      sources: ["switzerland-ev"],
      connectors: [],
      availability,
      isLive: true,
    };
    expect(station.availability?.available).toBe(3);
    expect(station.isLive).toBe(true);
  });
});
