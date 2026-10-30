import { describe, expect, it } from "vitest";
import {
  garageCreateVehicleSchema,
  garageOperations,
  garageParkedSchema,
  garageSaveParkedSchema,
  garageUpdateParkedSchema,
  garageUpdateVehicleSchema,
  garageVehicleCreatedSchema,
  garageVehicleSchema,
} from "./garage";

const at = "2026-10-23T00:00:00.000Z";
const vehicle = {
  id: "car",
  name: "Car",
  kind: "car",
  powertrain: "petrol",
  isDefault: true,
  presetId: null,
  ev: null,
  fuelConsumptionLPer100Km: 6,
};
describe("garage contracts", () => {
  it("distinguishes creation receipts from persisted records and excludes owner metadata", () => {
    expect(garageVehicleCreatedSchema.safeParse(vehicle).success).toBe(true);
    expect(garageVehicleSchema.safeParse(vehicle).success).toBe(false);
    expect(
      garageVehicleSchema.safeParse({ ...vehicle, createdAt: at, updatedAt: at }).success,
    ).toBe(true);
    expect(
      garageVehicleSchema.safeParse({ ...vehicle, createdAt: at, updatedAt: at, userId: "owner" })
        .success,
    ).toBe(false);
  });
  it("preserves omission in partial intent without applying creation defaults", () => {
    expect(garageUpdateVehicleSchema.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
    expect(garageUpdateVehicleSchema.parse({ isDefault: false })).toEqual({ isDefault: false });
    expect(garageUpdateParkedSchema.parse({ expiresAt: null })).toEqual({ expiresAt: null });
    expect(garageUpdateParkedSchema.safeParse({ vehicleId: "other" }).success).toBe(false);
  });
  it("rejects invalid primitives and unknown connector values before writing", () => {
    expect(garageSaveParkedSchema.safeParse({ lat: "52", lng: 13, source: "manual" }).success).toBe(
      false,
    );
    expect(
      garageCreateVehicleSchema.safeParse({
        name: "Car",
        kind: "car",
        powertrain: "petrol",
        isDefault: "yes",
      }).success,
    ).toBe(false);
    expect(
      garageCreateVehicleSchema.safeParse({
        name: "EV",
        kind: "car",
        powertrain: "electric",
        ev: { batteryKwh: 60, baseWhPerKm: 180, maxDcKw: 100, connectors: ["unsupported"] },
      }).success,
    ).toBe(false);
  });
  it("accepts historical expiry reads independently of the write-only future horizon", () => {
    expect(
      garageParkedSchema.safeParse({
        id: "parked",
        vehicleId: null,
        lat: 52,
        lng: 13,
        address: null,
        note: null,
        expiresAt: "2000-01-01T00:00:00.000Z",
        source: "manual",
        accuracyMeters: null,
        savedAt: at,
        updatedAt: at,
      }).success,
    ).toBe(true);
  });
  it("declares all eight operations as session-owned", () => {
    expect(Object.keys(garageOperations)).toHaveLength(8);
    expect(Object.values(garageOperations).every((operation) => operation.auth === "session")).toBe(
      true,
    );
  });
});
