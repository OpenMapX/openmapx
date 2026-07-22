// Vehicle specs from open-ev-data/open-ev-data-dataset
// (https://github.com/open-ev-data/open-ev-data-dataset), CDLA-Permissive-2.0,
// distilled by `pnpm gen-ev-vehicles` into ./vehicles.generated.ts.
// Values are approximate typical figures for stop-placement, not warranties —
// real-world consumption varies with speed, weather, load and driving style.
import type { EvVehicleSpec } from "./types";
import { DATASET_VERSION, GENERATED_VEHICLES } from "./vehicles.generated";

/** Upstream open-ev-data release the table was generated from. */
export const VEHICLE_DATASET_VERSION = DATASET_VERSION;

export const VEHICLE_PRESETS: Record<string, EvVehicleSpec> = Object.fromEntries(
  GENERATED_VEHICLES.map((vehicle) => [
    vehicle.id,
    {
      batteryKwh: vehicle.batteryKwh,
      baseWhPerKm: vehicle.baseWhPerKm,
      massTonnes: vehicle.massTonnes,
      maxDcKw: vehicle.maxDcKw,
      maxAcKw: vehicle.maxAcKw,
      vehicleTaperSocPct: vehicle.vehicleTaperSocPct,
      connectors: vehicle.connectors,
    } satisfies EvVehicleSpec,
  ]),
);

/** One entry of the vehicle picker: display name plus the make it groups under. */
export interface VehicleListEntry {
  id: string;
  label: string;
  make: string;
}

const VEHICLE_LIST: VehicleListEntry[] = GENERATED_VEHICLES.map((vehicle) => ({
  id: vehicle.id,
  label: vehicle.label,
  make: vehicle.make,
}));

/**
 * Every selectable vehicle with its display name, sorted by make then label.
 * The make-first order keeps each make's options contiguous, which is what a
 * grouped picker needs to render one header per make.
 */
export function listVehicles(): VehicleListEntry[] {
  return VEHICLE_LIST;
}

export function getVehiclePreset(id: string): EvVehicleSpec | null {
  return VEHICLE_PRESETS[id] ?? null;
}
