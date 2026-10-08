import type { ConnectorStandard } from "../types/ev";

const STANDARDS: Record<string, ConnectorStandard> = {
  IEC_62196_T2: "type2",
  IEC_62196_T2_COMBO: "ccs2",
  IEC_62196_T1: "type1",
  IEC_62196_T1_COMBO: "ccs1",
  CHADEMO: "chademo",
  SAE_J3400: "nacs",
  TESLA_S: "nacs",
  IEC_62196_T3A: "type3",
  IEC_62196_T3C: "type3",
  GBT_AC: "gbt_ac",
  GBT_DC: "gbt_dc",
};

/**
 * The vehicle connector a charging connector of this OCPI standard plugs into,
 * or undefined for standards no vehicle profile lists.
 */
export function connectorStandardOf(standard: string): ConnectorStandard | undefined {
  return Object.hasOwn(STANDARDS, standard) ? STANDARDS[standard] : undefined;
}
