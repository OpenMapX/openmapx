import { describe, expect, it } from "vitest";
import { normalizeParkedDraft, normalizeVehicleDraft } from "./validate";

const EV = {
  batteryKwh: 64,
  baseWhPerKm: 170,
  massTonnes: 2,
  maxDcKw: 150,
  maxAcKw: 11,
  vehicleTaperSocPct: 80,
  connectors: ["ccs2"],
};

function vehicle(patch: Record<string, unknown> = {}) {
  return {
    name: "Blue Golf",
    kind: "car",
    powertrain: "petrol",
    isDefault: false,
    presetId: null,
    ev: null,
    fuelConsumptionLPer100Km: 6.4,
    ...patch,
  };
}

function parked(patch: Record<string, unknown> = {}) {
  return {
    vehicleId: null,
    lat: 51.55,
    lng: 6.6,
    address: "Am Kuhteich 42",
    note: null,
    expiresAt: null,
    source: "manual",
    accuracyMeters: null,
    ...patch,
  };
}

describe("normalizeVehicleDraft", () => {
  it("accepts a combustion car and trims the name", () => {
    const result = normalizeVehicleDraft(vehicle({ name: "  Blue Golf  " }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Blue Golf");
  });

  it("rejects an empty or over-long name", () => {
    expect(normalizeVehicleDraft(vehicle({ name: "   " })).ok).toBe(false);
    expect(normalizeVehicleDraft(vehicle({ name: "x".repeat(61) })).ok).toBe(false);
  });

  it("requires an ev spec for an electric powertrain", () => {
    expect(normalizeVehicleDraft(vehicle({ powertrain: "electric", ev: null })).ok).toBe(false);
    const ok = normalizeVehicleDraft(
      vehicle({ powertrain: "electric", ev: EV, fuelConsumptionLPer100Km: null }),
    );
    expect(ok.ok).toBe(true);
  });

  it("rejects an ev spec whose connectors are empty", () => {
    const bad = { ...EV, connectors: [] };
    expect(normalizeVehicleDraft(vehicle({ powertrain: "electric", ev: bad })).ok).toBe(false);
  });

  it("drops the ev spec for a non-electric powertrain", () => {
    const result = normalizeVehicleDraft(vehicle({ powertrain: "petrol", ev: EV }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ev).toBeNull();
  });

  it("rejects fuel consumption on a bicycle", () => {
    expect(
      normalizeVehicleDraft(
        vehicle({ kind: "bicycle", powertrain: "other", fuelConsumptionLPer100Km: 5 }),
      ).ok,
    ).toBe(false);
  });

  it("rejects fuel consumption outside (0, 60]", () => {
    expect(normalizeVehicleDraft(vehicle({ fuelConsumptionLPer100Km: 0 })).ok).toBe(false);
    expect(normalizeVehicleDraft(vehicle({ fuelConsumptionLPer100Km: 61 })).ok).toBe(false);
  });

  it("rejects an unknown kind or powertrain", () => {
    expect(normalizeVehicleDraft(vehicle({ kind: "boat" })).ok).toBe(false);
    expect(normalizeVehicleDraft(vehicle({ powertrain: "steam" })).ok).toBe(false);
  });
});

describe("normalizeParkedDraft", () => {
  it("accepts a manual save", () => {
    expect(normalizeParkedDraft(parked()).ok).toBe(true);
  });

  it("rejects out-of-range coordinates", () => {
    expect(normalizeParkedDraft(parked({ lat: 91 })).ok).toBe(false);
    expect(normalizeParkedDraft(parked({ lng: -181 })).ok).toBe(false);
    expect(normalizeParkedDraft(parked({ lat: Number.NaN })).ok).toBe(false);
  });

  it("rejects an over-long note or address", () => {
    expect(normalizeParkedDraft(parked({ note: "x".repeat(501) })).ok).toBe(false);
    expect(normalizeParkedDraft(parked({ address: "x".repeat(301) })).ok).toBe(false);
  });

  it("accepts an expiry within 30 days and rejects one beyond it", () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const far = new Date(Date.now() + 31 * 86_400_000).toISOString();
    expect(normalizeParkedDraft(parked({ expiresAt: soon })).ok).toBe(true);
    expect(normalizeParkedDraft(parked({ expiresAt: far })).ok).toBe(false);
    expect(normalizeParkedDraft(parked({ expiresAt: "not a date" })).ok).toBe(false);
  });

  it("rejects an unknown source", () => {
    expect(normalizeParkedDraft(parked({ source: "guess" })).ok).toBe(false);
  });
});
