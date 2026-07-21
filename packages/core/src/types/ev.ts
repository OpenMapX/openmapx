/** Canonical connector standards (OCPI ConnectorType aligned). */
export type ConnectorStandard =
  | "ccs2"
  | "ccs1"
  | "chademo"
  | "type2"
  | "type1"
  | "tesla_ccs"
  | "gbt_ac"
  | "gbt_dc"
  | "type3";

/** Canonical current family. */
export type CurrentStandard = "ac" | "dc";

/**
 * EV vehicle characteristics for charge-planning. Defined in @openmapx/core
 * (the lowest package) so both @openmapx/ev-charge-planner and the core API
 * contract can import it without a cycle (core must not depend on mobility-core).
 */
export interface EvVehicleSpec {
  batteryKwh: number;
  baseWhPerKm: number;
  massTonnes: number;
  maxDcKw: number;
  maxAcKw: number;
  vehicleTaperSocPct: number;
  connectors: ConnectorStandard[];
}
