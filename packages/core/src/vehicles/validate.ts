import type { ConnectorStandard, EvVehicleSpec } from "../types/ev";
import {
  PARKED_SOURCES,
  type ParkedDraft,
  type ParkedSource,
  VEHICLE_KINDS,
  VEHICLE_POWERTRAINS,
  type VehicleDraft,
  type VehicleKind,
  type VehiclePowertrain,
} from "./types";

/** A garage is a personal shortlist, not an inventory; the cap keeps one user's rows bounded. */
export const MAX_VEHICLES_PER_USER = 12;

/** A parking meter nobody returns to within a month is a note, not a timer. */
export const MAX_EXPIRY_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_NAME_LENGTH = 60;
const MAX_NOTE_LENGTH = 500;
const MAX_ADDRESS_LENGTH = 300;
const MAX_FUEL_L_PER_100KM = 60;

export type NormalizeResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function record(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function optionalText(value: unknown, max: number): { ok: true; value: string | null } | null {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  return trimmed.length > max ? null : { ok: true, value: trimmed };
}

/** A spec is usable only when every number the planner divides by is positive. */
export function normalizeEvSpec(input: unknown): EvVehicleSpec | null {
  const spec = record(input);
  if (!spec) return null;
  if (!positive(spec.batteryKwh) || !positive(spec.baseWhPerKm) || !positive(spec.maxDcKw)) {
    return null;
  }
  const connectors = Array.isArray(spec.connectors)
    ? spec.connectors.filter((c): c is ConnectorStandard => typeof c === "string" && c !== "")
    : [];
  if (connectors.length === 0) return null;
  const maxAcKw =
    typeof spec.maxAcKw === "number" && Number.isFinite(spec.maxAcKw) && spec.maxAcKw >= 0
      ? spec.maxAcKw
      : 0;
  return {
    batteryKwh: spec.batteryKwh,
    baseWhPerKm: spec.baseWhPerKm,
    massTonnes: positive(spec.massTonnes) ? spec.massTonnes : 2,
    maxDcKw: spec.maxDcKw,
    maxAcKw,
    vehicleTaperSocPct: positive(spec.vehicleTaperSocPct) ? spec.vehicleTaperSocPct : 80,
    connectors,
  };
}

function isElectric(powertrain: VehiclePowertrain): boolean {
  return powertrain === "electric" || powertrain === "plugin_hybrid";
}

export function normalizeVehicleDraft(input: unknown): NormalizeResult<VehicleDraft> {
  const raw = record(input);
  if (!raw) return { ok: false, reason: "not an object" };

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name === "") return { ok: false, reason: "name is required" };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: "name is too long" };

  if (!VEHICLE_KINDS.includes(raw.kind as VehicleKind)) {
    return { ok: false, reason: "unknown kind" };
  }
  if (!VEHICLE_POWERTRAINS.includes(raw.powertrain as VehiclePowertrain)) {
    return { ok: false, reason: "unknown powertrain" };
  }
  const kind = raw.kind as VehicleKind;
  const powertrain = raw.powertrain as VehiclePowertrain;

  // Carrying an EV spec on a petrol car would let the planner treat it as
  // electric the moment somebody read the field without checking the powertrain.
  const ev = isElectric(powertrain) ? normalizeEvSpec(raw.ev) : null;
  if (isElectric(powertrain) && !ev) {
    return { ok: false, reason: "an electric vehicle needs a complete battery spec" };
  }

  let fuelConsumptionLPer100Km: number | null = null;
  if (raw.fuelConsumptionLPer100Km !== null && raw.fuelConsumptionLPer100Km !== undefined) {
    if (kind === "bicycle" || powertrain === "electric") {
      return { ok: false, reason: "this vehicle does not burn fuel" };
    }
    if (
      !positive(raw.fuelConsumptionLPer100Km) ||
      raw.fuelConsumptionLPer100Km > MAX_FUEL_L_PER_100KM
    ) {
      return { ok: false, reason: "fuel consumption is out of range" };
    }
    fuelConsumptionLPer100Km = raw.fuelConsumptionLPer100Km;
  }

  const presetId = optionalText(raw.presetId, MAX_NAME_LENGTH);
  if (!presetId) return { ok: false, reason: "invalid presetId" };

  return {
    ok: true,
    value: {
      name,
      kind,
      powertrain,
      isDefault: raw.isDefault === true,
      presetId: presetId.value,
      ev,
      fuelConsumptionLPer100Km,
    },
  };
}

export function normalizeParkedDraft(input: unknown): NormalizeResult<ParkedDraft> {
  const raw = record(input);
  if (!raw) return { ok: false, reason: "not an object" };

  const { lat, lng } = raw;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { ok: false, reason: "latitude is out of range" };
  }
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { ok: false, reason: "longitude is out of range" };
  }

  if (!PARKED_SOURCES.includes(raw.source as ParkedSource)) {
    return { ok: false, reason: "unknown source" };
  }

  const address = optionalText(raw.address, MAX_ADDRESS_LENGTH);
  if (!address) return { ok: false, reason: "address is too long" };
  const note = optionalText(raw.note, MAX_NOTE_LENGTH);
  if (!note) return { ok: false, reason: "note is too long" };
  const vehicleId = optionalText(raw.vehicleId, MAX_NAME_LENGTH);
  if (!vehicleId) return { ok: false, reason: "invalid vehicleId" };

  let expiresAt: string | null = null;
  if (raw.expiresAt !== null && raw.expiresAt !== undefined && raw.expiresAt !== "") {
    if (typeof raw.expiresAt !== "string") return { ok: false, reason: "invalid expiry" };
    const at = Date.parse(raw.expiresAt);
    if (Number.isNaN(at)) return { ok: false, reason: "invalid expiry" };
    if (at - Date.now() > MAX_EXPIRY_AHEAD_MS) {
      return { ok: false, reason: "expiry is too far ahead" };
    }
    expiresAt = new Date(at).toISOString();
  }

  const accuracyMeters =
    typeof raw.accuracyMeters === "number" &&
    Number.isFinite(raw.accuracyMeters) &&
    raw.accuracyMeters >= 0
      ? raw.accuracyMeters
      : null;

  return {
    ok: true,
    value: {
      vehicleId: vehicleId.value,
      lat,
      lng,
      address: address.value,
      note: note.value,
      expiresAt,
      source: raw.source as ParkedSource,
      accuracyMeters,
    },
  };
}
