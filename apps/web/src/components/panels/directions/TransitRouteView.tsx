"use client";

import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { TripItinerary, TripLeg } from "@openmapx/core";
import { formatDistance, formatDuration, useVehicleJourney } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { RemarkChip } from "@/components/panels/transit/RemarkChip";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { formatTime } from "@/lib/formatTime";
import { TEAL } from "@/lib/theme";

function LegBadge({ leg }: { leg: TripLeg }) {
  if (leg.mode === "walking") {
    return <DirectionsWalkIcon sx={{ fontSize: 16, color: "text.secondary" }} />;
  }
  if (leg.route) {
    return (
      <RouteBadge
        shortName={leg.route.shortName}
        color={leg.route.color}
        mode={leg.mode}
        size="small"
      />
    );
  }
  return <DirectionsBusIcon sx={{ fontSize: 16, color: "text.secondary" }} />;
}

function LegRemarks({ tripId }: { tripId: string }) {
  const { data: journey } = useVehicleJourney(tripId);
  if (!journey?.remarks?.length) return null;
  return (
    <Box sx={{ mt: 0.5, display: "flex", flexDirection: "column", gap: 0.25 }}>
      {journey.remarks.map((remark, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static ordered remark list
        <RemarkChip key={i} remark={remark} inline />
      ))}
    </Box>
  );
}

function TransitLiveBadge({ tripId }: { tripId: string }) {
  const tc = useTranslations("common");
  const { data: journey } = useVehicleJourney(tripId);
  const hasRealtime = journey?.stops?.some((s) => s.delaySeconds !== undefined);
  if (!hasRealtime) return null;
  return (
    <Box
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.4,
        px: 0.75,
        py: 0.25,
        borderRadius: 99,
        bgcolor: `${TEAL}1a`,
      }}
    >
      <Box sx={{ width: 5, height: 5, borderRadius: "50%", bgcolor: "#4caf50", flexShrink: 0 }} />
      <Typography variant="caption" fontWeight={600} sx={{ color: TEAL, fontSize: 10 }}>
        {tc("live")}
      </Typography>
    </Box>
  );
}

function LiveStopTime({
  scheduledTime,
  tripId,
  stopId,
}: {
  scheduledTime: string;
  tripId?: string;
  stopId?: string;
}) {
  const locale = useLocale();
  const { data: journey } = useVehicleJourney(tripId ?? null);
  const stop = stopId ? journey?.stops.find((s) => s.stopId === stopId) : undefined;
  const delayMin = stop ? Math.round((stop.delaySeconds ?? 0) / 60) : 0;
  const hasDelay = delayMin > 0;

  const displayTime =
    hasDelay && stop
      ? formatTime(
          stop.expectedDeparture ??
            stop.expectedArrival ??
            stop.scheduledDeparture ??
            stop.scheduledArrival ??
            scheduledTime,
          locale,
        )
      : scheduledTime;

  return (
    <>
      <Typography variant="caption" color={hasDelay ? "error.main" : "text.secondary"}>
        {displayTime}
      </Typography>
      {hasDelay && (
        <Typography
          variant="caption"
          fontWeight={600}
          sx={{ display: "block", color: "error.main", fontSize: "0.7rem" }}
        >
          +{delayMin}m
        </Typography>
      )}
    </>
  );
}

export function TransitItineraryCard({
  itinerary,
  active,
  onSelect,
  onDetails,
}: {
  itinerary: TripItinerary;
  active: boolean;
  onSelect: () => void;
  onDetails: () => void;
}) {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const locale = useLocale();
  const startTime = new Date(itinerary.startTime).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const endTime = new Date(itinerary.endTime).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <Box
      onClick={onSelect}
      sx={{
        px: 2,
        py: 1.5,
        cursor: "pointer",
        borderLeft: active ? `4px solid ${TEAL}` : "4px solid transparent",
        bgcolor: active ? "rgba(0,123,139,0.04)" : "transparent",
        "&:hover": { bgcolor: active ? "rgba(0,123,139,0.07)" : "action.hover" },
        transition: "background-color 0.15s",
      }}
    >
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <DirectionsTransitIcon sx={{ fontSize: 18, color: active ? TEAL : "text.disabled" }} />
          <Typography variant="body2" fontWeight={600}>
            {startTime} – {endTime}
          </Typography>
        </Box>
        <Typography variant="body2" fontWeight={600} color={active ? TEAL : "text.primary"}>
          {formatDuration(itinerary.duration)}
        </Typography>
      </Box>

      {/* Leg summary */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.75, flexWrap: "wrap" }}>
        {itinerary.legs.map((leg, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable id
          <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            {i > 0 && <ChevronRightIcon sx={{ fontSize: 14, color: "text.disabled" }} />}
            <LegBadge leg={leg} />
          </Box>
        ))}
      </Box>

      {itinerary.transfers > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
          {t("transfers", { count: itinerary.transfers })}
          {itinerary.walkDistance > 0 &&
            ` · ${t("walkDistance", { distance: formatDistance(itinerary.walkDistance) })}`}
        </Typography>
      )}

      {active && (
        <Box sx={{ mt: 0.5, ml: -1.5 }}>
          <Typography
            component="span"
            variant="caption"
            sx={{
              color: TEAL,
              cursor: "pointer",
              fontWeight: 500,
              px: 1.5,
              py: 0.75,
              borderRadius: 99,
              "&:hover": { bgcolor: `${TEAL}18` },
              transition: "background-color 0.15s",
            }}
            onClick={(e) => {
              e.stopPropagation();
              onDetails();
            }}
          >
            {tc("details")}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

// Re-export internal helpers needed by TransitDetailsView
export { LegBadge, LegRemarks, TransitLiveBadge, LiveStopTime };
