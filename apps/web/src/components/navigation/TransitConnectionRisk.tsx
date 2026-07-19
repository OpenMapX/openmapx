"use client";

import DirectionsRunIcon from "@mui/icons-material/DirectionsRun";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useVehicleJourney } from "@openmapx/core";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { connectionRisk } from "@/lib/navigation/connectionRisk";
import type { TransitTransfer } from "@/lib/navigation/transitTransfer";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";
import { liveArrivalDelayMs } from "./TransitNavBottomBar";

/** Earliest alternative departure that leaves after `notBeforeMs`, or null. */
function nextViableAlternative(
  alternatives: TripLeg["alternatives"],
  notBeforeMs: number,
): { startTime: string; routeShortName?: string } | null {
  if (!alternatives) return null;
  const viable = alternatives
    .filter((a) => new Date(a.startTime).getTime() >= notBeforeMs)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  return viable[0] ?? null;
}

/**
 * "Connection at risk" warning shown while riding a transit leg whose onward
 * change is tight or already lost — the realtime arrival vs the next leg's
 * departure minus the transfer walk. Amber when tight, red when likely missed,
 * and it surfaces the next viable alternative departure (from MOTIS leg
 * alternatives) so the rider can react early instead of after the miss.
 */
export function TransitConnectionRisk({
  leg,
  transfer,
}: {
  leg: TripLeg;
  transfer: TransitTransfer;
}) {
  const t = useTranslations("navigation");
  const fmt = useDateTimeFormat();
  const { data: journey } = useVehicleJourney(leg.tripId ?? null);

  const nextLeg = transfer.nextLeg;
  const arrivalMs =
    new Date(leg.endTime).getTime() +
    liveArrivalDelayMs(journey?.stops, leg.to.stopId, leg.endTime);
  const departureMs = new Date(nextLeg.startTime).getTime();
  const risk = connectionRisk({
    currentArrivalMs: arrivalMs,
    nextDepartureMs: departureMs,
    transferWalkSeconds: transfer.walkSeconds,
  });
  if (risk.level === "ok") return null;

  const missed = risk.level === "missed";
  // A viable alternative must leave after we can realistically be at the stop.
  const alt = nextViableAlternative(nextLeg.alternatives, arrivalMs + transfer.walkSeconds * 1000);

  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        gap: 1.25,
        px: 2,
        py: 1,
        borderRadius: 2,
        boxShadow: 2,
        bgcolor: missed ? "error.main" : "warning.main",
        color: missed ? "error.contrastText" : "warning.contrastText",
      }}
    >
      {missed ? (
        <ErrorOutlineIcon sx={{ fontSize: 24, flexShrink: 0 }} />
      ) : (
        <DirectionsRunIcon sx={{ fontSize: 24, flexShrink: 0 }} />
      )}
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
          {missed
            ? t("connectionMissed")
            : t("connectionTight", { minutes: Math.max(0, Math.round(risk.bufferSeconds / 60)) })}
        </Typography>
        {alt && (
          <Typography variant="caption" noWrap>
            {t("connectionAlternative", { time: fmt.time(alt.startTime) })}
            {alt.routeShortName ? ` · ${alt.routeShortName}` : ""}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
