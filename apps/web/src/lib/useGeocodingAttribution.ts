"use client";

import { buildIntegrationAttribution, combineAttributions, useCapabilities } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useMemo } from "react";

/**
 * Combined attribution HTML for the geocoding providers that are currently
 * available and healthy. Shared by the search dropdown and the place panels so
 * the visible geocoding credit (OSM ODbL / geocoder CC-BY) is built one way and
 * can't drift between the places that surface it.
 */
export function useGeocodingAttribution(): string {
  const registry = useIntegrationRegistry();
  const { services: caps } = useCapabilities();
  return useMemo(() => {
    const geocoders = registry.getByDomain("geocoding").filter((g) => {
      const cap = caps[g.id];
      return cap ? cap.available && cap.healthy : false;
    });
    if (geocoders.length === 0) return "";
    return combineAttributions(
      geocoders.map((g) => buildIntegrationAttribution(g.dataSources)).filter(Boolean),
    );
  }, [registry, caps]);
}
