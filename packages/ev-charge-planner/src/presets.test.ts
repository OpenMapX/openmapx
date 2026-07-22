import { describe, expect, it } from "vitest";
import { getVehiclePreset, listVehicles, VEHICLE_PRESETS } from "./presets";

describe("vehicle presets", () => {
  it("ships the full generated dataset", () => {
    expect(Object.keys(VEHICLE_PRESETS).length).toBeGreaterThan(900);
  });

  it("every preset is physically plausible", () => {
    for (const [id, spec] of Object.entries(VEHICLE_PRESETS)) {
      expect(spec.batteryKwh, id).toBeGreaterThan(5);
      expect(spec.batteryKwh, id).toBeLessThan(250);
      expect(spec.baseWhPerKm, id).toBeGreaterThan(80);
      expect(spec.baseWhPerKm, id).toBeLessThan(600);
      expect(spec.maxDcKw, id).toBeGreaterThan(0);
      expect(spec.maxAcKw, id).toBeGreaterThanOrEqual(0);
      expect(spec.massTonnes, id).toBeGreaterThan(0.5);
      expect(spec.massTonnes, id).toBeLessThan(5);
      expect(spec.connectors.length, id).toBeGreaterThan(0);
    }
  });

  it("lists vehicles with labels, sorted and unique", () => {
    const list = listVehicles();
    expect(list.length).toBe(Object.keys(VEHICLE_PRESETS).length);
    expect(new Set(list.map((v) => v.id)).size).toBe(list.length);
    const labels = list.map((v) => v.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("looks a preset up by id", () => {
    expect(getVehiclePreset(listVehicles()[0].id)).toBeTruthy();
    expect(getVehiclePreset("nope")).toBeNull();
  });

  it("gives Teslas a connector that station data can match", () => {
    const tesla = listVehicles().find((v) => v.label.startsWith("Tesla "));
    expect(tesla).toBeTruthy();
    const spec = getVehiclePreset(tesla!.id);
    expect(spec?.connectors).toContain("tesla_ccs");
  });
});
