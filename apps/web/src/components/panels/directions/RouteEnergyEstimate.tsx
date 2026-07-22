"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { Route } from "@openmapx/core";
import { useSettingsStore } from "@openmapx/core";
import { getVehiclePreset, routeEnergyKwh } from "@openmapx/ev-charge-planner";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { CUSTOM_VEHICLE_ID } from "@/lib/buildEvDirectionsRequest";

/**
 * Plain (non-EV-mode) driving route energy/cost estimate. Computed
 * entirely client-side from the already-fetched `Route` via the planner
 * package's `routeEnergyKwh` — no backend call. Renders nothing until the
 * user has picked a vehicle (shared `evVehicleId` setting, same one EV mode
 * uses), so a driver with no EV never sees this line.
 */
export function RouteEnergyEstimate({
  route,
  onEditVehicle,
}: {
  route: Route;
  /** Opens the same vehicle/home-price picker EV mode uses (shared `evVehicleId` setting). */
  onEditVehicle?: () => void;
}) {
  const t = useTranslations("directions.ev");
  const locale = useLocale();
  const vehicleId = useSettingsStore((s) => s.evVehicleId);
  const customVehicle = useSettingsStore((s) => s.evCustomVehicle);
  const homePricePerKwh = useSettingsStore((s) => s.evHomePricePerKwh);
  const homeCurrency = useSettingsStore((s) => s.evHomeCurrency);

  const vehicle =
    vehicleId === CUSTOM_VEHICLE_ID
      ? customVehicle
      : vehicleId
        ? getVehiclePreset(vehicleId)
        : null;

  const energyKwh = useMemo(() => {
    if (!vehicle) return null;
    return routeEnergyKwh(route, vehicle, { ambientTempC: 20, elevationAbsentDerate: 1.1 })
      .totalKwh;
  }, [route, vehicle]);

  if (!vehicle || energyKwh === null) return null;

  const cost = homePricePerKwh != null ? energyKwh * homePricePerKwh : null;
  const currencyFmt = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: homeCurrency || "EUR",
  });

  return (
    <Box
      component={onEditVehicle ? "button" : "div"}
      type={onEditVehicle ? "button" : undefined}
      onClick={onEditVehicle}
      sx={{
        display: "flex",
        alignItems: "baseline",
        gap: 0.5,
        px: 2,
        py: 0.5,
        border: 0,
        bgcolor: "transparent",
        fontFamily: "inherit",
        cursor: onEditVehicle ? "pointer" : "default",
        textAlign: "left",
      }}
    >
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {`≈ ${energyKwh.toFixed(1)} kWh`}
        {cost !== null &&
          ` · ≈ ${currencyFmt.format(cost)} (${currencyFmt.format(homePricePerKwh as number)}/kWh — ${t(
            "editVehicle",
          )})`}
      </Typography>
    </Box>
  );
}
