"use client";

import EnergySavingsLeafIcon from "@mui/icons-material/EnergySavingsLeaf";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import type { RouteImpact } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { formatCo2Emission } from "@/lib/formatCo2";

export interface RouteImpactBadgeProps {
  impact: RouteImpact;
  onClick?: () => void;
}

export interface ImpactCostLabels {
  tollCoverageUnknown: string;
  tollAmountUnknown: string;
  fareUnavailable: string;
  costUnavailable: string;
}

const DEFAULT_COST_LABELS: ImpactCostLabels = {
  tollCoverageUnknown: "Toll cost unknown",
  tollAmountUnknown: "Tolls apply; amount unknown",
  fareUnavailable: "Fare unavailable",
  costUnavailable: "Cost unavailable",
};

export function formatImpactCost(
  cost: RouteImpact["cost"],
  locale: string,
  labels: ImpactCostLabels = DEFAULT_COST_LABELS,
): string {
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
    return labels.fareUnavailable;
  }

  if (cost.totalCost !== null) {
    return `~${formatter.format(cost.totalCost)}`;
  }

  if (cost.knownCost !== null) {
    const unknownLabel =
      cost.tollStatus === "tolls_unknown" ? labels.tollAmountUnknown : labels.tollCoverageUnknown;
    return `~${formatter.format(cost.knownCost)} · ${unknownLabel}`;
  }

  return labels.costUnavailable;
}

export function RouteImpactBadge({ impact, onClick }: RouteImpactBadgeProps) {
  const t = useTranslations("directions");
  const locale = useLocale();

  const formattedCost = formatImpactCost(impact.cost, locale, {
    tollCoverageUnknown: t("tollCostUnknown"),
    tollAmountUnknown: t("tollsUnknown"),
    fareUnavailable: t("fareUnavailable"),
    costUnavailable: t("costUnavailable"),
  });
  const formattedCo2 = formatCo2Emission(impact.emissions.totalGrams, locale);

  const summary = formattedCo2
    ? t("impactSummary", { cost: formattedCost, co2: formattedCo2 })
    : formattedCost;

  const isEcoChoice = Boolean(impact.comparison?.isLowestEmissions);
  const ecoLabel = t("ecoChoice");

  const ariaLabel = isEcoChoice ? `${ecoLabel}, ${summary}` : summary;

  const badgeContent = (
    <>
      {isEcoChoice && (
        <Chip
          size="small"
          icon={<EnergySavingsLeafIcon sx={{ fontSize: "14px !important" }} />}
          label={ecoLabel}
          color="success"
          data-testid="eco-choice-chip"
          sx={{
            height: 24,
            fontSize: "0.75rem",
            fontWeight: 700,
            "& .MuiChip-label": { px: 0.75 },
            "& .MuiChip-icon": { ml: 0.5, mr: -0.25 },
          }}
        />
      )}
      <Typography
        variant="caption"
        sx={{
          fontWeight: 600,
          color: isEcoChoice ? "success.main" : "text.secondary",
          fontSize: "0.8125rem",
          lineHeight: 1,
        }}
        data-testid="impact-summary-text"
      >
        {summary}
      </Typography>
    </>
  );

  return (
    <Box
      sx={{
        display: "inline-flex",
        alignItems: "center",
      }}
    >
      {onClick ? (
        <ButtonBase
          onClick={onClick}
          aria-label={ariaLabel}
          data-testid="route-impact-badge"
          focusRipple
          sx={{
            minHeight: 48,
            minWidth: 48,
            display: "inline-flex",
            alignItems: "center",
            gap: 0.75,
            px: 1.5,
            py: 0.75,
            borderRadius: 999,
            bgcolor: (theme) =>
              theme.palette.mode === "dark" ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.04)",
            "&:hover": {
              bgcolor: (theme) =>
                theme.palette.mode === "dark" ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.08)",
            },
            transition: "background-color 0.15s ease",
            cursor: "pointer",
            border: "1px solid",
            borderColor: (theme) =>
              theme.palette.mode === "dark" ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.08)",
          }}
        >
          {badgeContent}
        </ButtonBase>
      ) : (
        <Box
          data-testid="route-impact-badge"
          role="status"
          aria-label={ariaLabel}
          sx={{
            minHeight: 48,
            minWidth: 48,
            display: "inline-flex",
            alignItems: "center",
            gap: 0.75,
            px: 1.5,
            py: 0.75,
            borderRadius: 999,
            bgcolor: (theme) =>
              theme.palette.mode === "dark" ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.04)",
            border: "1px solid",
            borderColor: (theme) =>
              theme.palette.mode === "dark" ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.08)",
          }}
        >
          {badgeContent}
        </Box>
      )}
    </Box>
  );
}
