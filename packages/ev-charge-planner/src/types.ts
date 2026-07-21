export type { EvVehicleSpec } from "@openmapx/core";

// PlanInput / ChargePlan / PlannedStop / warning types are added in Task 6.
import type { ConnectorStandard, EvVehicleSpec, LngLat, Route } from "@openmapx/core";
import type { EvChargingStation } from "@openmapx/mobility-core/ev-charging";

export interface MatrixCell {
  seconds: number;
  km: number;
}
export interface PlanCallbacks {
  /** Chargers within a bounded window bbox around a point. */
  requestCorridorChargers(centre: LngLat, radiusKm: number): Promise<EvChargingStation[]>;
  /** Time/distance matrix. Returns rows[s][t]; null cell = unreachable. */
  requestMatrix(sources: LngLat[], targets: LngLat[]): Promise<(MatrixCell | null)[][]>;
}
export interface PlanInput {
  route: Route;
  vehicle: EvVehicleSpec;
  socStartKwh: number;
  socArrivalMinKwh: number;
  socTargetKwh: number; // user preference (may exceed taper)
  ambientTempC: number;
  hasElevation: boolean;
  nowMs: number; // request time (Date.now()) — for live-availability freshness/ETA gating
  preferredNetworkKeys?: Set<string>; // D9 — normalizeOperator keys to favour (default: none)
  avoidedNetworkKeys?: Set<string>; // D9 — normalizeOperator keys to de-prioritise
  exclusiveNetworkKeys?: Set<string>; // D9 — hard whitelist (set = only these operators)
  costWeight?: number; // D10 — 0 = ignore price, 1 = default weight (from preferCheaper)
}
export type PlanWarning =
  | { kind: "unreachable"; afterStopIndex: number }
  | { kind: "tight-margin"; legIndex: number }
  | { kind: "no-charger-data" }
  | { kind: "no-allowed-network"; afterStopIndex: number }; // D9 exclusive filter left nothing
export interface PlannedStop {
  station: EvChargingStation;
  connector: ConnectorStandard;
  powerKw: number;
  coordinates: LngLat;
  arriveSocKwh: number;
  departSocKwh: number;
  chargeSeconds: number;
  addedKwh: number;
  estimatedCost?: { amount: number; currency: string }; // D10
}
export interface ChargePlan {
  stops: PlannedStop[];
  warnings: PlanWarning[];
  totalChargeSeconds: number;
  totalEnergyKwh: number;
}
