import { describe, expect, it } from "vitest";
import { getVehiclePreset, VEHICLE_PRESETS } from "./presets.js";

describe("vehicle presets", () => {
  it("has at least 15 models with sane fields", () => {
    const ids = Object.keys(VEHICLE_PRESETS);
    expect(ids.length).toBeGreaterThanOrEqual(15);
    for (const spec of Object.values(VEHICLE_PRESETS)) {
      expect(spec.batteryKwh).toBeGreaterThan(10);
      expect(spec.baseWhPerKm).toBeGreaterThan(100);
      expect(spec.maxDcKw).toBeGreaterThanOrEqual(spec.maxAcKw);
      expect(spec.connectors.length).toBeGreaterThan(0);
    }
  });
  it("resolves a known id and rejects unknown", () => {
    expect(getVehiclePreset("vw-id4")).toBeTruthy();
    expect(getVehiclePreset("nope")).toBeNull();
  });
});
