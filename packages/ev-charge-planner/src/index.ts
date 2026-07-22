export { routeEnergyKwh, tempDerate } from "./consumption"; // D12 — client-side route energy
export { COMMON_EV_NETWORKS } from "./networks";
export { planCharges } from "./plan";
export type { VehicleListEntry } from "./presets";
export {
  getVehiclePreset,
  listVehicles,
  VEHICLE_DATASET_VERSION,
  VEHICLE_PRESETS,
} from "./presets";
export type {
  ChargePlan,
  EvVehicleSpec,
  MatrixCell,
  PlanCallbacks,
  PlanInput,
  PlannedStop,
  PlanWarning,
} from "./types";
