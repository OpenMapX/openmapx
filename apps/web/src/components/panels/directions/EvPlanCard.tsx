"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { EvChargeStop, EvDirectionsResult } from "@openmapx/core";
import { formatDuration } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { runtimeAttributionToAttribution } from "@/lib/attributionForProviders";
import { TEAL } from "@/lib/theme";

export function EvPlanCard({
  result,
  onRetryWithoutNetworkRestriction,
}: {
  result: EvDirectionsResult;
  /** Re-requests the plan with `exclusiveNetworks: false` — the "no-allowed-network" recovery action. */
  onRetryWithoutNetworkRestriction?: () => void;
}) {
  const t = useTranslations("directions.ev");
  const locale = useLocale();

  const hasUnreachable = result.warnings.some(
    (w) => w.kind === "unreachable" || w.kind === "no-charger-data",
  );
  const hasNoAllowedNetwork = result.warnings.some((w) => w.kind === "no-allowed-network");
  const hasTightMargin = result.warnings.some((w) => w.kind === "tight-margin");

  const totalSeconds = result.totals.driveSeconds + result.totals.chargeSeconds;
  const estimatedCost = result.totals.estimatedCost;
  const costFmt = estimatedCost
    ? new Intl.NumberFormat(locale, {
        style: "currency",
        currency: estimatedCost.currency,
      }).format(estimatedCost.amount)
    : null;
  const otherCurrenciesFmt = estimatedCost?.otherCurrencies?.map(({ currency, amount }) =>
    new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount),
  );

  return (
    <Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2, px: 2, py: 1.5 }}>
        <Box>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
            {t("totalDrive")}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {formatDuration(result.totals.driveSeconds)}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
            {t("totalCharge")}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {formatDuration(result.totals.chargeSeconds)}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
            {t("totalTime")}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600, color: TEAL }}>
            {formatDuration(totalSeconds)}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
            {t("totalEnergy")}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {`${result.totals.energyKwh.toFixed(1)} kWh`}
          </Typography>
        </Box>
        {estimatedCost && costFmt && (
          <Tooltip
            title={t("tripCostBreakdown", {
              homeKwh: estimatedCost.homeKwh.toFixed(1),
              publicKwh: estimatedCost.publicKwh.toFixed(1),
            })}
            arrow
          >
            <Box>
              <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
                {t("tripCost")}
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {costFmt}
                {otherCurrenciesFmt?.length ? ` + ${otherCurrenciesFmt.join(" + ")}` : ""}
              </Typography>
            </Box>
          </Tooltip>
        )}
      </Box>

      <Divider />

      {hasUnreachable && (
        <Alert severity="warning" sx={{ mx: 2, my: 1.5 }}>
          {t("unreachable")}
        </Alert>
      )}

      {hasNoAllowedNetwork && (
        <Alert
          severity="warning"
          sx={{ mx: 2, my: 1.5 }}
          action={
            onRetryWithoutNetworkRestriction ? (
              <Button color="inherit" size="small" onClick={onRetryWithoutNetworkRestriction}>
                {t("routeWithoutRestriction")}
              </Button>
            ) : undefined
          }
        >
          {t("noAllowedNetwork")}
        </Alert>
      )}

      {hasTightMargin && !hasUnreachable && !hasNoAllowedNetwork && (
        <Alert severity="warning" sx={{ mx: 2, my: 1.5 }}>
          {t("tightMargin")}
        </Alert>
      )}

      {result.stops.length > 0 && (
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
            {t("stopsHeading")}
          </Typography>
          {result.stops.map((stop, i) => (
            <EvPlanStopRow key={stop.station.id} stop={stop} index={i} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function EvPlanStopRow({ stop, index }: { stop: EvChargeStop; index: number }) {
  const t = useTranslations("directions.ev");
  const locale = useLocale();
  const connectorLabel = t(`connector.${stop.connector}`);
  const costFmt = stop.estimatedCost
    ? new Intl.NumberFormat(locale, {
        style: "currency",
        currency: stop.estimatedCost.currency,
      }).format(stop.estimatedCost.amount)
    : null;
  const attributions = stop.attributions.map(runtimeAttributionToAttribution);

  return (
    <Box sx={{ py: 1, borderTop: index > 0 ? "1px solid" : "none", borderColor: "divider" }}>
      <Box
        sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
            {stop.station.name}
          </Typography>
          {stop.isPreferredNetwork && (
            <Chip
              label={t("onYourNetwork")}
              size="small"
              sx={{ height: 18, fontSize: "0.6875rem" }}
            />
          )}
        </Box>
        <Typography variant="body2" sx={{ fontWeight: 600, color: TEAL, flexShrink: 0 }}>
          {`${stop.powerKw} kW`}
        </Typography>
      </Box>
      {stop.operator && (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {stop.operator}
        </Typography>
      )}
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, mt: 0.5 }}>
        <Chip
          label={connectorLabel}
          size="small"
          variant="outlined"
          sx={{ height: 20, fontSize: "0.6875rem" }}
        />
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("stopArriveDepart", {
            arrive: Math.round(stop.arriveSocPct),
            depart: Math.round(stop.departSocPct),
          })}
        </Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {formatDuration(stop.chargeSeconds)}
        </Typography>
        {stop.availability && (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("availability", {
              available: stop.availability.available,
              total: stop.availability.total,
            })}
          </Typography>
        )}
      </Box>
      {(costFmt || stop.tariffSummary) && (
        <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mt: 0.25 }}>
          {costFmt}
          {costFmt && stop.tariffSummary ? " · " : ""}
          {stop.tariffSummary}
        </Typography>
      )}
      {attributions.length > 0 && (
        <Box sx={{ mt: 0.25 }}>
          <AttributionStrip attributions={attributions} variant="inline" />
        </Box>
      )}
    </Box>
  );
}
