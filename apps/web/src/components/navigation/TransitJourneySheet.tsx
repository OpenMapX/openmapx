"use client";

import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { type TransitProgress, useVehicleJourney } from "@openmapx/core";
import type { TripItinerary, TripLeg, VehicleJourneyStop } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { sliceJourneyToLeg } from "@/lib/navigation/legJourneyStops";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";
import { PlatformBadge } from "./PlatformBadge";

/** Best available time for a stop: realtime departure/arrival, else scheduled. */
function stopTime(stop: VehicleJourneyStop): string | undefined {
  return (
    stop.expectedDeparture ??
    stop.expectedArrival ??
    stop.scheduledDeparture ??
    stop.scheduledArrival
  );
}

function StopTimeline({ stops, nextIdx }: { stops: VehicleJourneyStop[]; nextIdx: number }) {
  const fmt = useDateTimeFormat();
  const t = useTranslations("navigation");
  return (
    <Box sx={{ px: 2, py: 0.5 }}>
      {stops.map((stop, i) => {
        const isFirst = i === 0;
        const isLast = i === stops.length - 1;
        const isNext = i === nextIdx;
        const passed = i < nextIdx;
        const emphasized = isFirst || isLast || isNext;
        const delayMin = Math.round((stop.delaySeconds ?? 0) / 60);
        const time = stopTime(stop);
        const dotColor = isNext ? "primary.main" : passed ? "text.disabled" : "text.secondary";
        return (
          <Box
            // biome-ignore lint/suspicious/noArrayIndexKey: stops are ordered by sequence
            key={i}
            sx={{ display: "flex", gap: 1, alignItems: "stretch", opacity: passed ? 0.5 : 1 }}
          >
            <Box sx={{ width: 52, textAlign: "right", flexShrink: 0, pt: "1px" }}>
              <Typography
                variant="caption"
                sx={{
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: emphasized ? 700 : 400,
                  color: delayMin > 0 ? "error.main" : "text.primary",
                }}
              >
                {time ? fmt.time(time) : ""}
              </Typography>
              {delayMin > 0 && !stop.canceled && (
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    color: "error.main",
                    fontWeight: 600,
                    fontSize: "0.6rem",
                  }}
                >
                  +{delayMin}m
                </Typography>
              )}
            </Box>
            <Box
              sx={{
                position: "relative",
                width: 16,
                flexShrink: 0,
                display: "flex",
                justifyContent: "center",
              }}
            >
              <Box
                sx={{
                  position: "absolute",
                  width: 2,
                  bgcolor: "divider",
                  top: isFirst ? "9px" : 0,
                  bottom: isLast ? "calc(100% - 9px)" : 0,
                }}
              />
              <Box
                sx={{
                  position: "absolute",
                  top: "4px",
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  border: "2px solid",
                  borderColor: dotColor,
                  bgcolor: emphasized ? dotColor : "background.paper",
                }}
              />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0, py: 0.35 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
                <Typography
                  variant="body2"
                  noWrap
                  sx={{
                    fontWeight: emphasized ? 600 : 400,
                    textDecoration: stop.canceled ? "line-through" : "none",
                    color: stop.canceled ? "error.main" : "text.primary",
                  }}
                >
                  {stop.name}
                </Typography>
                {stop.alerts && stop.alerts.length > 0 && (
                  <Tooltip title={stop.alerts[0].title} placement="top" arrow>
                    <WarningAmberIcon sx={{ fontSize: 15, color: "#E65100", flexShrink: 0 }} />
                  </Tooltip>
                )}
              </Box>
              {stop.canceled && (
                <Typography variant="caption" sx={{ color: "error.main", fontWeight: 600 }}>
                  {t("stopSkipped")}
                </Typography>
              )}
              {stop.platform && !stop.canceled && (
                <Box sx={{ mt: 0.25 }}>
                  <PlatformBadge code={stop.platform} />
                </Box>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** One compact row per upcoming leg, shown under the current-ride timeline. */
function UpcomingLegRow({ leg }: { leg: TripLeg }) {
  const fmt = useDateTimeFormat();
  const t = useTranslations("navigation");
  const isWalk = leg.mode === "walking" || !leg.route;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 0.75 }}>
      <Box sx={{ width: 52, textAlign: "right", flexShrink: 0 }}>
        <Typography variant="caption" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {leg.startTime ? fmt.time(leg.startTime) : ""}
        </Typography>
      </Box>
      {isWalk ? (
        <DirectionsWalkIcon sx={{ fontSize: 20, color: "text.secondary", flexShrink: 0 }} />
      ) : (
        leg.route && (
          <RouteBadge
            shortName={leg.route.shortName}
            color={leg.route.color}
            textColor={leg.route.textColor}
            mode={leg.mode}
          />
        )
      )}
      <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
        {isWalk ? t("walkTo", { place: leg.to.name }) : leg.to.name}
      </Typography>
      {leg.from.platformCode && !isWalk && <PlatformBadge code={leg.from.platformCode} />}
    </Box>
  );
}

/**
 * Expanded content of the transit nav swipe sheet: the live stop-by-stop
 * timeline of the current ride (next stop highlighted, passed stops dimmed,
 * per-stop delays) followed by the remaining legs of the journey. Reuses the
 * shared leg-slice util so it matches the itinerary detail view.
 */
export function TransitJourneySheet({
  itinerary,
  currentLegIndex,
  transitProgress: _transitProgress,
}: {
  itinerary: TripItinerary;
  currentLegIndex: number;
  transitProgress: TransitProgress | null;
}) {
  const t = useTranslations("navigation");
  const legs = itinerary.legs;
  const currentLeg = legs[currentLegIndex];
  const isTransitLeg = !!currentLeg && currentLeg.mode !== "walking" && !!currentLeg.route;
  const { data: journey } = useVehicleJourney(isTransitLeg ? (currentLeg?.tripId ?? null) : null);

  const legStops = journey?.stops
    ? sliceJourneyToLeg(journey.stops, currentLeg?.from.stopId, currentLeg?.to.stopId)
    : [];
  // Next stop = first one the vehicle has not yet departed; clamp to the alight.
  const firstUpcoming = legStops.findIndex((s) => !s.departed);
  const nextIdx = firstUpcoming === -1 ? Math.max(0, legStops.length - 1) : firstUpcoming;

  const upcomingLegs = legs.slice(currentLegIndex + 1);

  return (
    <Box sx={{ maxHeight: "56vh", overflowY: "auto" }}>
      {legStops.length > 0 && <StopTimeline stops={legStops} nextIdx={nextIdx} />}
      {upcomingLegs.length > 0 && (
        <>
          <Typography
            variant="overline"
            sx={{ display: "block", px: 2, pt: 1, color: "text.secondary" }}
          >
            {t("restOfJourney")}
          </Typography>
          {upcomingLegs.map((leg, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: legs are a fixed ordered plan
            <UpcomingLegRow key={i} leg={leg} />
          ))}
        </>
      )}
    </Box>
  );
}
