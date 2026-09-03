"use client";

import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { type ImpactAssumption, type RouteImpact, safeHref } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";

function formatProvenanceDate(timestamp: string, locale: string): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return timestamp;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(parsed));
  } catch {
    return timestamp;
  }
}

function assumptionKey(assumption: ImpactAssumption): string {
  return JSON.stringify(assumption);
}

export function RouteImpactProvenance({ impact }: { impact: RouteImpact }) {
  const t = useTranslations("directions");
  const locale = useLocale();
  const usesElectricity =
    impact.energy.electricityKwh !== null && impact.energy.fuelLiters === null;

  const formatAssumption = (assumption: ImpactAssumption): string => {
    switch (assumption.kind) {
      case "unit_price":
        return t("assumptionUnitPrice", assumption);
      case "active_mobility_zero":
        return t("assumptionActiveMobilityZero");
      case "transit_fallback":
        return t("assumptionTransitFallback", assumption);
      case "provider_per_passenger":
        return t("assumptionProviderPerPassenger");
      case "base_electric_consumption":
        return t("assumptionBaseElectricConsumption", assumption);
      case "ambient_temperature":
        return t("assumptionAmbientTemperature", assumption);
      case "charging_efficiency":
        return t("assumptionChargingEfficiency", assumption);
      case "elevation":
        return assumption.regenPercent === undefined
          ? t("assumptionElevation", assumption)
          : t("assumptionElevationRegen", {
              ...assumption,
              regenPercent: assumption.regenPercent,
            });
      case "flat_terrain":
        return t("assumptionFlatTerrain");
      case "grid_intensity":
        return t("assumptionGridIntensity", assumption);
      case "zero_tailpipe":
        return t("assumptionZeroTailpipe");
      case "base_fuel_consumption":
        return t("assumptionBaseFuelConsumption", assumption);
      case "tailpipe_factor":
        return t("assumptionTailpipeFactor", assumption);
      case "upstream_factor":
        return t("assumptionUpstreamFactor", assumption);
      case "fuel_price_sample":
        return t("assumptionFuelPriceSample", assumption);
    }
  };

  const assumptions = (items: ImpactAssumption[]) =>
    items.length > 0 ? (
      <Box component="ul" sx={{ pl: 2.5, mt: 0.5, mb: 0 }}>
        {items.map((item) => (
          <Typography
            key={assumptionKey(item)}
            component="li"
            variant="caption"
            color="text.secondary"
          >
            {formatAssumption(item)}
          </Typography>
        ))}
      </Box>
    ) : null;

  const citation = (text: string, sourceUrl?: string) =>
    sourceUrl ? (
      <Link href={safeHref(sourceUrl)} target="_blank" rel="noopener noreferrer">
        {text}
      </Link>
    ) : (
      text
    );

  const priceProvenance = impact.cost.energyCostProvenance;
  const priceCitation =
    priceProvenance.kind === "provider"
      ? t("provenanceProvider", { source: priceProvenance.citation })
      : priceProvenance.kind === "user_override"
        ? t("provenanceOverride")
        : t("provenanceDefaulted", { source: priceProvenance.citation });

  return (
    <Box
      sx={{ display: "flex", flexDirection: "column", gap: 2.5, pt: 1 }}
      data-testid="provenance-tab-content"
    >
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
          {usesElectricity ? t("electricityCost") : t("fuelCost")}
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 500 }} data-testid="fuel-provenance-citation">
          {citation(priceCitation, priceProvenance.sourceUrl)}
        </Typography>
        {impact.cost.energyCostProvenance.timestamp && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block" }}
            data-testid="fuel-provenance-timestamp"
          >
            {formatProvenanceDate(impact.cost.energyCostProvenance.timestamp, locale)}
          </Typography>
        )}
        {assumptions(impact.cost.energyCostProvenance.assumptions)}
      </Box>

      <Divider />

      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
          {usesElectricity ? t("gridCarbonIntensity") : t("emissionFactors")}
        </Typography>
        <Typography
          variant="body2"
          sx={{ fontWeight: 500 }}
          data-testid="emissions-provenance-citation"
        >
          {citation(impact.emissions.provenance.citation, impact.emissions.provenance.sourceUrl)}
        </Typography>
        {impact.emissions.provenance.timestamp && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block" }}
            data-testid="emissions-provenance-timestamp"
          >
            {formatProvenanceDate(impact.emissions.provenance.timestamp, locale)}
          </Typography>
        )}
        {assumptions(impact.emissions.provenance.assumptions)}
      </Box>

      <Divider />

      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
          {t("energyConsumed")}
        </Typography>
        <Typography
          variant="body2"
          sx={{ fontWeight: 500 }}
          data-testid="energy-provenance-citation"
        >
          {citation(impact.energy.provenance.citation, impact.energy.provenance.sourceUrl)}
        </Typography>
        {assumptions(impact.energy.provenance.assumptions)}
      </Box>
    </Box>
  );
}
