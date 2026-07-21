import type { EvVehicleSpec, LngLat } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { routeEnergyKwh, tempDerate } from "./consumption.js";

const vehicle: EvVehicleSpec = {
  batteryKwh: 75,
  baseWhPerKm: 160,
  massTonnes: 2,
  maxDcKw: 150,
  maxAcKw: 11,
  vehicleTaperSocPct: 80,
  connectors: ["ccs2"],
};

// 100 km flat route, no elevation: 100 * 160 Wh = 16 kWh at 20°C.
function flatRoute(km: number) {
  const geometry: LngLat[] = [
    [0, 0],
    [km / 111, 0],
  ];
  return {
    distance: km * 1000,
    duration: km * 40,
    geometry,
    legs: [],
    steps: [],
    mode: "driving" as const,
  };
}

describe("routeEnergyKwh", () => {
  it("computes flat consumption from baseWhPerKm", () => {
    const { totalKwh } = routeEnergyKwh(flatRoute(100), vehicle, { ambientTempC: 20 });
    expect(totalKwh).toBeCloseTo(16, 1);
  });

  it("adds climb energy and applies regen on descent", () => {
    const climb = { ...flatRoute(10), elevation: [0, 500], elevationInterval: 10_000 };
    const descend = { ...flatRoute(10), elevation: [500, 0], elevationInterval: 10_000 };
    const up = routeEnergyKwh(climb, vehicle, { ambientTempC: 20 }).totalKwh;
    const down = routeEnergyKwh(descend, vehicle, { ambientTempC: 20 }).totalKwh;
    expect(up).toBeGreaterThan(down);
  });

  it("applies a safety derate when elevation is absent", () => {
    const withDerate = routeEnergyKwh(flatRoute(100), vehicle, {
      ambientTempC: 20,
      elevationAbsentDerate: 1.1,
    });
    expect(withDerate.totalKwh).toBeCloseTo(17.6, 1); // 16 * 1.1
  });

  it("tempDerate is ~1 at 20C and >1 in the cold", () => {
    expect(tempDerate(20)).toBeCloseTo(1, 2);
    expect(tempDerate(-10)).toBeGreaterThan(1.2);
  });
});
