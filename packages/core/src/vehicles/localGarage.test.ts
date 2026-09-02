import { beforeEach, describe, expect, it } from "vitest";
import { configureStorage, type StorageAdapter } from "../platform/storage";
import {
  clearLocalGarage,
  hasImportedGarageFor,
  LOCAL_VEHICLES_KEY,
  markGarageImported,
  readLocalParked,
  readLocalVehicles,
  takeLocalGarage,
  writeLocalParked,
  writeLocalVehicles,
} from "./localGarage";

function memoryStorage(): StorageAdapter & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getString: (k) => map.get(k) ?? null,
    setString: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

const VEHICLE = {
  id: "v1",
  name: "Blue Golf",
  kind: "car" as const,
  powertrain: "petrol" as const,
  isDefault: true,
  presetId: null,
  ev: null,
  fuelConsumptionLPer100Km: 6.4,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
};

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  configureStorage(storage);
});

describe("localGarage", () => {
  it("round-trips a vehicle", () => {
    const [saved] = writeLocalVehicles([VEHICLE]);
    expect(saved.name).toBe("Blue Golf");
    expect(readLocalVehicles()).toHaveLength(1);
  });

  it("drops a corrupt row instead of throwing", () => {
    storage.map.set(LOCAL_VEHICLES_KEY, '[{"name":""},{"nope":true}]');
    expect(readLocalVehicles()).toEqual([]);
  });

  it("returns an empty list for unparseable storage", () => {
    storage.map.set(LOCAL_VEHICLES_KEY, "{not json");
    expect(readLocalVehicles()).toEqual([]);
  });

  it("starts empty when nothing has been stored", () => {
    expect(readLocalVehicles()).toEqual([]);
  });

  it("keeps at most one default vehicle", () => {
    const rows = writeLocalVehicles([
      { ...VEHICLE, id: "a", name: "A", isDefault: true },
      { ...VEHICLE, id: "b", name: "B", isDefault: true },
    ]);
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
    expect(rows[0].isDefault).toBe(true);
  });

  it("keeps one parked record per vehicle", () => {
    const rows = writeLocalParked([
      {
        id: "p1",
        vehicleId: "v1",
        lat: 51.5,
        lng: 6.6,
        address: null,
        note: null,
        expiresAt: null,
        source: "manual",
        accuracyMeters: null,
        savedAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-01T10:00:00.000Z",
      },
      {
        id: "p2",
        vehicleId: "v1",
        lat: 51.6,
        lng: 6.7,
        address: null,
        note: null,
        expiresAt: null,
        source: "manual",
        accuracyMeters: null,
        savedAt: "2026-09-01T11:00:00.000Z",
        updatedAt: "2026-09-01T11:00:00.000Z",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("p2");
  });

  it("takes and clears the whole garage", () => {
    writeLocalVehicles([VEHICLE]);
    const taken = takeLocalGarage();
    expect(taken.vehicles).toHaveLength(1);
    clearLocalGarage();
    expect(storage.map.get(LOCAL_VEHICLES_KEY)).toBeFalsy();
    expect(readLocalVehicles()).toEqual([]);
    expect(readLocalParked()).toEqual([]);
  });

  it("records the import per user id", () => {
    expect(hasImportedGarageFor("u1")).toBe(false);
    markGarageImported("u1");
    expect(hasImportedGarageFor("u1")).toBe(true);
    expect(hasImportedGarageFor("u2")).toBe(false);
  });
});
