import { getStorage } from "../platform/storage";
import type { ParkedLocation, PersonalVehicle } from "./types";
import {
  MAX_VEHICLES_PER_USER as MAX_LOCAL_VEHICLES,
  normalizeParkedDraft,
  normalizeVehicleDraft,
} from "./validate";

export const LOCAL_VEHICLES_KEY = "openmapx:garage:vehicles";
export const LOCAL_PARKED_KEY = "openmapx:garage:parked";
export const GARAGE_IMPORTED_KEY = "openmapx:garage:importedFor";

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readJsonArray(key: string): unknown[] {
  const parsed = safeParse(getStorage().getString(key));
  return Array.isArray(parsed) ? parsed : [];
}

function timestamps(row: Record<string, unknown>, fallback: string) {
  const at = (value: unknown) => (typeof value === "string" && value !== "" ? value : fallback);
  return { createdAt: at(row.createdAt), updatedAt: at(row.updatedAt) };
}

/** At most one default, and the first candidate wins so the choice is stable across reads. */
function withSingleDefault(vehicles: PersonalVehicle[]): PersonalVehicle[] {
  let seen = false;
  return vehicles.map((vehicle) => {
    if (vehicle.isDefault && !seen) {
      seen = true;
      return vehicle;
    }
    return vehicle.isDefault ? { ...vehicle, isDefault: false } : vehicle;
  });
}

/** The newest record per vehicle, mirroring the server's unique constraint. */
function oneRecordPerVehicle(parked: ParkedLocation[]): ParkedLocation[] {
  const byVehicle = new Map<string, ParkedLocation>();
  for (const record of parked) {
    const key = record.vehicleId ?? "";
    const existing = byVehicle.get(key);
    if (!existing || Date.parse(record.savedAt) >= Date.parse(existing.savedAt)) {
      byVehicle.set(key, record);
    }
  }
  return [...byVehicle.values()];
}

function parseVehicles(rows: unknown[]): PersonalVehicle[] {
  const out: PersonalVehicle[] = [];
  for (const row of rows) {
    const result = normalizeVehicleDraft(row);
    if (!result.ok) continue;
    const raw = row as Record<string, unknown>;
    const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : crypto.randomUUID();
    out.push({ id, ...result.value, ...timestamps(raw, new Date().toISOString()) });
  }
  return withSingleDefault(out);
}

function parseParked(rows: unknown[]): ParkedLocation[] {
  const out: ParkedLocation[] = [];
  for (const row of rows) {
    const result = normalizeParkedDraft(row);
    if (!result.ok) continue;
    const raw = row as Record<string, unknown>;
    const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : crypto.randomUUID();
    const now = new Date().toISOString();
    const savedAt = typeof raw.savedAt === "string" && raw.savedAt !== "" ? raw.savedAt : now;
    const updatedAt =
      typeof raw.updatedAt === "string" && raw.updatedAt !== "" ? raw.updatedAt : savedAt;
    out.push({ id, ...result.value, savedAt, updatedAt });
  }
  return oneRecordPerVehicle(out);
}

export function readLocalVehicles(): PersonalVehicle[] {
  return parseVehicles(readJsonArray(LOCAL_VEHICLES_KEY));
}

/** Writes the normalized list and returns exactly what a later read will yield. */
export function writeLocalVehicles(vehicles: PersonalVehicle[]): PersonalVehicle[] {
  const normalized = parseVehicles(vehicles).slice(0, MAX_LOCAL_VEHICLES);
  getStorage().setString(LOCAL_VEHICLES_KEY, JSON.stringify(normalized));
  return normalized;
}

export function readLocalParked(): ParkedLocation[] {
  return parseParked(readJsonArray(LOCAL_PARKED_KEY));
}

export function writeLocalParked(parked: ParkedLocation[]): ParkedLocation[] {
  const normalized = parseParked(parked);
  getStorage().setString(LOCAL_PARKED_KEY, JSON.stringify(normalized));
  return normalized;
}

export function takeLocalGarage(): { vehicles: PersonalVehicle[]; parked: ParkedLocation[] } {
  return { vehicles: readLocalVehicles(), parked: readLocalParked() };
}

/** Drops the browser-local garage once its rows live on an account. */
export function clearLocalGarage(): void {
  getStorage().remove(LOCAL_VEHICLES_KEY);
  getStorage().remove(LOCAL_PARKED_KEY);
}

export function hasImportedGarageFor(userId: string): boolean {
  const raw = safeParse(getStorage().getString(GARAGE_IMPORTED_KEY));
  return Array.isArray(raw) && raw.includes(userId);
}

export function markGarageImported(userId: string): void {
  const raw = safeParse(getStorage().getString(GARAGE_IMPORTED_KEY));
  const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  if (ids.includes(userId)) return;
  getStorage().setString(GARAGE_IMPORTED_KEY, JSON.stringify([...ids, userId]));
}
