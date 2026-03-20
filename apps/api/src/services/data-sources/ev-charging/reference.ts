import type { DataSourceFilterDef } from "@openmapx/core";
import { TTL, withCache } from "../../../utils/cache.js";
import { getOcmReferenceData } from "./ocm.js";

/**
 * Returns filter definitions for the EV charging data source.
 * OCM reference data is cached for 48 hours.
 */
export async function getEvChargingFilters(): Promise<DataSourceFilterDef[]> {
  try {
    const refData = await withCache("cache:ds:ev:refdata", TTL.dataSources.evReference, () =>
      getOcmReferenceData(),
    );

    const connectorOptions = refData.ConnectionTypes.filter(
      (ct) => !ct.IsDiscontinued && !ct.IsObsolete,
    ).map((ct) => ({
      id: ct.ID,
      label: ct.Title,
    }));

    const usageOptions = refData.UsageTypes.map((ut) => ({
      id: ut.ID,
      label: ut.Title,
    }));

    const statusOptions = refData.StatusTypes.filter((st) => st.IsUserSelectable !== false).map(
      (st) => ({
        id: st.ID,
        label: st.Title,
      }),
    );

    return [
      {
        id: "connectorType",
        label: "Connector Type",
        type: "multi-select",
        options: connectorOptions,
      },
      {
        id: "speed",
        label: "Charging Speed",
        type: "multi-select",
        options: [
          { id: "slow", label: "Slow (\u226422 kW)" },
          { id: "fast", label: "Fast (\u2264100 kW)" },
          { id: "ultra-rapid", label: "Ultra-Rapid (>100 kW)" },
        ],
      },
      {
        id: "usageType",
        label: "Access Type",
        type: "multi-select",
        options: usageOptions,
      },
      {
        id: "status",
        label: "Status",
        type: "multi-select",
        options: statusOptions,
      },
    ];
  } catch {
    // Fallback filters without OCM reference data (e.g. no API key)
    return [
      {
        id: "connectorType",
        label: "Connector Type",
        type: "multi-select",
        options: [],
      },
      {
        id: "speed",
        label: "Charging Speed",
        type: "multi-select",
        options: [
          { id: "slow", label: "Slow (\u226422 kW)" },
          { id: "fast", label: "Fast (\u2264100 kW)" },
          { id: "ultra-rapid", label: "Ultra-Rapid (>100 kW)" },
        ],
      },
      {
        id: "usageType",
        label: "Access Type",
        type: "multi-select",
        options: [],
      },
      {
        id: "status",
        label: "Status",
        type: "multi-select",
        options: [],
      },
    ];
  }
}
