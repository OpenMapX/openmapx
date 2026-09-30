"use client";

import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloudOutlinedIcon from "@mui/icons-material/CloudOutlined";
import EnergySavingsLeafIcon from "@mui/icons-material/EnergySavingsLeaf";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PaymentsOutlinedIcon from "@mui/icons-material/PaymentsOutlined";
import TollOutlinedIcon from "@mui/icons-material/TollOutlined";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { RouteImpact } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { formatCo2Emission } from "@/lib/formatCo2";

export interface RouteImpactBadgeProps {
  impact: RouteImpact;
  onClick?: () => void;
}

export interface ImpactCostLabels {
  tollAmountUnknown: string;
  fareUnavailable: string;
  costUnavailable: string;
  totalCost?: string;
  /** Names the known part of an incomplete road cost, e.g. "Fuel cost". */
  energyCost?: string;
  additionalCostUnknown?: string;
}

const DEFAULT_COST_LABELS: ImpactCostLabels = {
  tollAmountUnknown: "Tolls apply (amount unknown)",
  fareUnavailable: "Fare unavailable",
  costUnavailable: "Cost unavailable",
  totalCost: "Total cost",
  energyCost: "Fuel cost",
  additionalCostUnknown: "Additional costs unknown",
};

export function formatImpactCost(
  cost: RouteImpact["cost"],
  locale: string,
  labels: ImpactCostLabels = DEFAULT_COST_LABELS,
): string {
  const { amount, caveat } = formatImpactCostParts(cost, locale, labels);
  return caveat ? `${amount} · ${caveat}` : amount;
}

function formatImpactCostParts(
  cost: RouteImpact["cost"],
  locale: string,
  labels: ImpactCostLabels,
): { amount: string; caveat?: string } {
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: cost.currency,
    });
  } catch {
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "EUR",
    });
  }

  if (cost.costType === "transit" && cost.transitFare === null) {
    return { amount: labels.fareUnavailable };
  }

  if (cost.costCompleteness === "complete" && cost.totalCost !== null) {
    return {
      amount: `${labels.totalCost ?? DEFAULT_COST_LABELS.totalCost} ~${formatter.format(cost.totalCost)}`,
    };
  }

  if (cost.costCompleteness === "partial" && cost.knownCost !== null) {
    // The amount names what it covers, so a caveat is only added for a cost
    // known to be missing: tolls on a route that uses a toll road, or another
    // unknown component. An engine that cannot tell about tolls adds nothing.
    const caveat =
      cost.tollStatus === "tolls_unknown"
        ? labels.tollAmountUnknown
        : cost.tollStatus === "unknown"
          ? undefined
          : (labels.additionalCostUnknown ?? DEFAULT_COST_LABELS.additionalCostUnknown);
    return {
      amount: `${labels.energyCost ?? DEFAULT_COST_LABELS.energyCost} ~${formatter.format(cost.knownCost)}`,
      ...(caveat && { caveat }),
    };
  }

  return { amount: labels.costUnavailable };
}

export function RouteImpactBadge({ impact, onClick }: RouteImpactBadgeProps) {
  const t = useTranslations("directions");
  const locale = useLocale();

  const costLabels = {
    tollAmountUnknown: t("tollsUnknown"),
    fareUnavailable: t("fareUnavailable"),
    costUnavailable: t("costUnavailable"),
    totalCost: t("totalCost"),
    energyCost: impact.energy.electricityKwh !== null ? t("electricityCost") : t("fuelCost"),
    additionalCostUnknown: t("additionalCostUnknown"),
  };
  const costParts = formatImpactCostParts(impact.cost, locale, costLabels);
  const formattedCost = formatImpactCost(impact.cost, locale, costLabels);
  const formattedCo2 = formatCo2Emission(impact.emissions.totalGrams, locale);

  const summary = formattedCo2
    ? t("impactSummary", { cost: formattedCost, co2: formattedCo2 })
    : formattedCost;

  const isEcoChoice = Boolean(impact.comparison?.isLowestEmissions);
  const ecoLabel = t("ecoChoice");

  const ariaLabel = isEcoChoice ? `${ecoLabel}, ${summary}` : summary;

  const badgeContent = (
    <Box
      data-testid="impact-summary-text"
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 0.25,
        minWidth: 0,
      }}
    >
      {isEcoChoice && (
        <Box
          data-testid="eco-choice-chip"
          sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, color: "success.main" }}
        >
          <EnergySavingsLeafIcon aria-hidden="true" sx={{ fontSize: 16 }} />
          <Typography variant="caption" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
            {ecoLabel}
          </Typography>
        </Box>
      )}
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          columnGap: 1.5,
          rowGap: 0.25,
          minWidth: 0,
        }}
      >
        <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
          <PaymentsOutlinedIcon
            aria-hidden="true"
            sx={{ fontSize: 16, color: "text.secondary", flexShrink: 0 }}
          />
          <Typography
            variant="caption"
            sx={{
              fontWeight: 500,
              color: "text.secondary",
              lineHeight: 1.3,
              overflowWrap: "anywhere",
            }}
          >
            {costParts.amount}
          </Typography>
        </Box>
        {formattedCo2 && (
          <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
            <CloudOutlinedIcon
              aria-hidden="true"
              sx={{ fontSize: 16, color: "text.secondary", flexShrink: 0 }}
            />
            <Typography
              variant="caption"
              sx={{ fontWeight: 500, color: "text.secondary", lineHeight: 1.3 }}
            >
              {formattedCo2}
            </Typography>
          </Box>
        )}
      </Box>
      {costParts.caveat && (
        <Box
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0.5,
            minWidth: 0,
            color: "text.secondary",
          }}
        >
          {impact.cost.tollStatus === "no_tolls" ? (
            <InfoOutlinedIcon aria-hidden="true" sx={{ fontSize: 16, flexShrink: 0 }} />
          ) : (
            <TollOutlinedIcon aria-hidden="true" sx={{ fontSize: 16, flexShrink: 0 }} />
          )}
          <Typography variant="caption" sx={{ lineHeight: 1.3, overflowWrap: "anywhere" }}>
            {costParts.caveat}
          </Typography>
        </Box>
      )}
    </Box>
  );

  const layoutSx = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 0.25,
    maxWidth: "100%",
    minWidth: 0,
    textAlign: "start",
  } as const;

  return (
    <Box sx={{ display: "inline-flex", maxWidth: "100%" }}>
      {onClick ? (
        <ButtonBase
          onClick={onClick}
          aria-label={ariaLabel}
          data-testid="route-impact-badge"
          focusRipple
          sx={{
            ...layoutSx,
            py: 0.25,
            borderRadius: 1,
            cursor: "pointer",
            "@media (pointer: coarse)": { minHeight: 48, minWidth: 48 },
            "&:hover": { bgcolor: "action.hover" },
            "&:focus-visible, &.Mui-focusVisible": {
              outline: "2px solid",
              outlineColor: "primary.main",
              outlineOffset: 2,
            },
          }}
        >
          {badgeContent}
          <ChevronRightIcon
            aria-hidden="true"
            sx={{ fontSize: 16, color: "text.secondary", flexShrink: 0 }}
          />
        </ButtonBase>
      ) : (
        <Box data-testid="route-impact-badge" role="status" aria-label={ariaLabel} sx={layoutSx}>
          {badgeContent}
        </Box>
      )}
    </Box>
  );
}
