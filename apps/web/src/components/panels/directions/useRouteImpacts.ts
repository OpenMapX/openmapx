"use client";

import {
  compareRouteAlternatives,
  compatibleImpactVehicles,
  type LngLat,
  type PersonalVehicle,
  type Route,
  resolveImpactVehicle,
  useCountryFromCoordinates,
} from "@openmapx/core";
import { useCallback, useMemo, useState } from "react";
import { useAmbientFuelPrices } from "@/lib/fuel/useAmbientFuelPrices";
import type { RouteImpactAssumptions } from "./RouteImpactDetailsDialog";

interface Options {
  routes: Route[];
  destination: LngLat | null;
  vehicles: PersonalVehicle[] | undefined;
  homeElectricityPrice: number | null;
  homeElectricityCurrency: string;
}

export function useRouteImpacts({
  routes,
  destination,
  vehicles,
  homeElectricityPrice,
  homeElectricityCurrency,
}: Options) {
  const [assumptions, setAssumptions] = useState<RouteImpactAssumptions>({});
  const updateAssumptions = useCallback((update: RouteImpactAssumptions) => {
    setAssumptions((current) => ({ ...current, ...update }));
  }, []);

  const routeMode = routes[0]?.mode;
  const compatibleVehicles = useMemo(
    () => compatibleImpactVehicles(routeMode, vehicles),
    [routeMode, vehicles],
  );
  const selectedVehicle = useMemo(() => {
    return resolveImpactVehicle(routeMode, vehicles, assumptions.vehicleId);
  }, [assumptions.vehicleId, routeMode, vehicles]);
  const unavailableReason =
    selectedVehicle?.powertrain === "plugin_hybrid"
      ? ("plugin_hybrid_inputs_missing" as const)
      : selectedVehicle?.powertrain === "other" && selectedVehicle.kind !== "bicycle"
        ? ("unsupported_powertrain" as const)
        : null;

  const isRoadRoute = routes.some(
    (route) => route.mode === "driving" || route.mode === "motorcycle",
  );
  const needsFuel =
    isRoadRoute &&
    unavailableReason === null &&
    selectedVehicle?.kind !== "bicycle" &&
    selectedVehicle?.powertrain !== "electric";
  const { data: destinationCountry } = useCountryFromCoordinates(
    destination,
    routes.length > 0 && isRoadRoute,
  );
  const { prices: ambientPrices } = useAmbientFuelPrices(destination, needsFuel);
  const ambientFuelQuote =
    selectedVehicle?.powertrain === "diesel" ? ambientPrices?.diesel : ambientPrices?.petrol;

  const customFuelPrice = assumptions.fuelPricePerLiter ?? null;
  const fuelPrice = customFuelPrice ?? ambientFuelQuote?.pricePerLiter ?? null;
  const customElectricityPrice = assumptions.electricityPricePerKwh ?? null;
  const electricityPrice = customElectricityPrice ?? homeElectricityPrice;
  const usesElectricity = selectedVehicle?.powertrain === "electric";
  const currency =
    usesElectricity && (customElectricityPrice !== null || homeElectricityPrice !== null)
      ? homeElectricityCurrency
      : (ambientFuelQuote?.currency ?? null);

  const impacts = useMemo(() => {
    if (unavailableReason || routeMode === "walking" || routeMode === "cycling") return [];
    return compareRouteAlternatives(routes, selectedVehicle, {
      countryCode: destinationCountry,
      currency,
      occupancy: assumptions.occupancy,
      fuelPricePerLiter: fuelPrice,
      fuelPriceSource:
        customFuelPrice !== null ? "Custom fuel price" : ambientFuelQuote?.provenance.citation,
      fuelPriceProvenanceKind:
        customFuelPrice !== null ? "user_override" : ambientFuelQuote?.provenance.kind,
      fuelPriceTimestamp:
        customFuelPrice !== null ? undefined : ambientFuelQuote?.provenance.timestamp,
      fuelPriceSourceUrl:
        customFuelPrice !== null ? undefined : ambientFuelQuote?.provenance.sourceUrl,
      electricityPricePerKwh: electricityPrice,
      electricityPriceSource:
        customElectricityPrice !== null
          ? "Custom electricity price"
          : homeElectricityPrice !== null
            ? "Home electricity tariff"
            : null,
      electricityPriceProvenanceKind: electricityPrice === null ? undefined : "user_override",
    });
  }, [
    ambientFuelQuote,
    assumptions.occupancy,
    currency,
    customElectricityPrice,
    customFuelPrice,
    destinationCountry,
    electricityPrice,
    fuelPrice,
    homeElectricityPrice,
    routes,
    routeMode,
    selectedVehicle,
    unavailableReason,
  ]);

  return { impacts, unavailableReason, compatibleVehicles, updateAssumptions };
}
