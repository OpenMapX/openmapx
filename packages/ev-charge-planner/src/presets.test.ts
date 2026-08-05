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
    const sorted = [...list].sort(
      (a, b) => a.make.localeCompare(b.make, "en") || a.label.localeCompare(b.label, "en"),
    );
    expect(list.map((v) => v.id)).toEqual(sorted.map((v) => v.id));
  });

  it("gives every vehicle a non-empty make", () => {
    for (const vehicle of listVehicles()) {
      expect(vehicle.make, vehicle.id).toBeTruthy();
    }
  });

  // The picker groups by make, and MUI renders a second header for a make whose
  // options are interrupted by another make's — so the runs must not interleave.
  it("keeps every make's options contiguous", () => {
    const spans = new Map<string, { first: number; last: number }>();
    listVehicles().forEach((vehicle, index) => {
      const span = spans.get(vehicle.make);
      if (span) span.last = index;
      else spans.set(vehicle.make, { first: index, last: index });
    });
    for (const [make, span] of spans) {
      expect(span.last - span.first + 1, make).toBe(
        listVehicles().filter((v) => v.make === make).length,
      );
    }
  });

  it("has no duplicate display labels", () => {
    const labels = listVehicles().map((v) => v.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("looks a preset up by id", () => {
    expect(getVehiclePreset(listVehicles()[0].id)).toBeTruthy();
    expect(getVehiclePreset("nope")).toBeNull();
  });

  it("gives Teslas a connector that station data can match", () => {
    const tesla = listVehicles().find((v) => v.label.startsWith("Tesla "));
    expect(tesla).toBeTruthy();
    if (!tesla) throw new Error("expected a Tesla preset in the vehicle list");
    const spec = getVehiclePreset(tesla.id);
    expect(spec?.connectors).toContain("tesla_ccs");
  });
});
