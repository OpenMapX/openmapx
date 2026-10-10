export { routeEnergyKwh, tempDerate } from "./consumption"; // client-side route energy
export { COMMON_EV_NETWORKS } from "./networks";
export { planCharges } from "./plan";
export type { VehicleListEntry } from "./presets";
export {
  getVehiclePreset,
  listVehicles,
  VEHICLE_DATASET_VERSION,
  VEHICLE_PRESETS,
} from "./presets";
export {
  type ChargePlan,
  ChargerSourcesUnavailableError,
  type EvVehicleSpec,
  type MatrixCell,
  type PlanCallbacks,
  type PlanInput,
  type PlannedStop,
  type PlanWarning,
  type SessionCost,
} from "./types";
