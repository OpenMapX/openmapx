export type { EvVehicleSpec } from "@openmapx/core";

import type { ConnectorStandard, EvVehicleSpec, LngLat, Route, TariffPrice } from "@openmapx/core";
import type { ChargingSite, Evse } from "@openmapx/mobility-core/ev-charging";

export interface MatrixCell {
  seconds: number;
  km: number;
}
/** No charger source answered for a corridor window, so whether it has chargers is unknown. */
export class ChargerSourcesUnavailableError extends Error {
  constructor() {
    super("no charger source answered");
    this.name = "ChargerSourcesUnavailableError";
  }
}

export interface PlanCallbacks {
  /**
   * Charging sites within a bounded window bbox around a point. Rejects with
   * `ChargerSourcesUnavailableError` when no charger source answered for the
   * window, which the plan reports apart from a window that has no chargers;
   * any other rejection fails the plan.
   */
  requestCorridorChargers(centre: LngLat, radiusKm: number): Promise<ChargingSite[]>;
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
  /** Request time: live occupancy only says something about stops reached soon after it. */
  nowMs: number;
  /** When the trip starts (the requested departure, else now): stop arrival times, and so tariffs, count from it. */
  tripStartMs: number;
  preferredNetworkKeys?: Set<string>; // normalizeOperator keys to favour (default: none)
  avoidedNetworkKeys?: Set<string>; // normalizeOperator keys to de-prioritise
  exclusiveNetworkKeys?: Set<string>; // hard whitelist (set = only these operators)
  costWeight?: number; // 0 = ignore price, 1 = default weight (from preferCheaper)
}
export type PlanWarning =
  | { kind: "unreachable"; afterStopIndex: number }
  | { kind: "tight-margin"; legIndex: number }
  | { kind: "no-charger-data" }
  | { kind: "charger-sources-unavailable" }
  | { kind: "no-allowed-network"; afterStopIndex: number }; // the exclusive filter left nothing

/** The modelled price of one charging session, and the tariff it was costed on. */
export interface SessionCost {
  amount: number;
  currency: string;
  tariffId: string;
  /** The costed tariff's main price, e.g. 0.39 EUR per kWh; the client formats it in its locale. */
  price: TariffPrice;
}

export interface PlannedStop {
  site: ChargingSite;
  /** The charge point the session is planned on. */
  evse: Evse;
  connector: ConnectorStandard;
  powerKw: number;
  coordinates: LngLat;
  arriveSocKwh: number;
  departSocKwh: number;
  chargeSeconds: number;
  addedKwh: number;
  estimatedCost?: SessionCost;
}
export interface ChargePlan {
  stops: PlannedStop[];
  warnings: PlanWarning[];
  totalChargeSeconds: number;
  totalEnergyKwh: number;
}
