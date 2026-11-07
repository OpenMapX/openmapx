"use client";

import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { type TransitProgress, useNavigationStore, useVehicleJourney } from "@openmapx/core";
import { selectLegPlatform } from "@openmapx/core/navigation";
import type { TripItinerary, TripLeg, VehicleJourneyStop } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { DepartureTime } from "@/components/panels/transit/DepartureTime";
import { PlatformBadge } from "@/components/panels/transit/PlatformBadge";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import {
  TransitDataStatus,
  TransitQueryNotice,
} from "@/components/panels/transit/TransitDataStatus";
import { useMobileRuntime } from "@/lib/mobile/useMobileRuntime";
import { legTransitTime } from "@/lib/transitTime";
import { useNow } from "@/lib/useNow";
import { TransitBoardingDepartures } from "./TransitBoardingDepartures";
import { TransitStopTimeline } from "./TransitStopTimeline";

/** One compact row per upcoming leg, shown under the current-ride timeline. */
function UpcomingLegRow({ leg, source, now }: { leg: TripLeg; source?: string; now: number }) {
  const t = useTranslations("navigation");
  const tt = useTranslations("transit");
  const captures = useNavigationStore((s) => s.transitCaptures);
  const legs = useNavigationStore((s) => s.itinerary?.legs);
  const platform = selectLegPlatform(leg, legs?.indexOf(leg) ?? -1, captures, "departure");
  const isWalk = leg.mode === "walking" || !leg.route;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 2, py: 1.5 }}>
      <Box sx={{ width: "5.5em", fontSize: ".75rem", textAlign: "right", flexShrink: 0 }}>
        <DepartureTime {...legTransitTime(leg)} variant="caption" canceled={leg.cancelled} />
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
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{
            textDecoration: leg.cancelled ? "line-through" : undefined,
            overflowWrap: "anywhere",
          }}
        >
          {isWalk ? t("walkTo", { place: leg.to.name }) : leg.to.name}
        </Typography>
        {leg.cancelled && (
          <Typography variant="caption" color="error.main" sx={{ fontWeight: 600 }}>
            {tt("canceled")}
          </Typography>
        )}
        {!isWalk && <TransitDataStatus now={now} realtime={leg.realtime} source={source} />}
      </Box>
      {platform.code && !isWalk && (
        <PlatformBadge code={platform.code} scheduledCode={platform.scheduledCode} />
      )}
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
  transitProgress,
  scroll = true,
  showQueryNotice = true,
  showDataStatus = true,
}: {
  itinerary: TripItinerary;
  currentLegIndex: number;
  transitProgress: TransitProgress | null;
  /**
   * Cap standalone content at 56vh and scroll internally. Navigation passes
   * `false` so its mobile sheet or desktop panel owns a single scroll region and
   * the menu below stays reachable instead of adding a nested scrollbar.
   */
  scroll?: boolean;
  /** Navigation already displays the same query warning in its summary. */
  showQueryNotice?: boolean;
  showDataStatus?: boolean;
}) {
  const t = useTranslations("navigation");
  const now = useNow(30_000);
  const legs = itinerary.legs;
  const currentLeg = legs[currentLegIndex];
  const isTransitLeg = !!currentLeg && currentLeg.mode !== "walking" && !!currentLeg.route;
  const { browserAuthority } = useMobileRuntime();
  const journeyQuery = useVehicleJourney(
    browserAuthority && isTransitLeg ? (currentLeg?.tripId ?? null) : null,
  );

  const captures = useNavigationStore((s) => s.transitCaptures);
  const capture = captures.find(
    (c) =>
      c.legIndex === currentLegIndex && c.tripId === currentLeg?.tripId && c.status === "captured",
  );
  const legStops = (capture?.stops ?? []) as VehicleJourneyStop[];

  const upcomingLegs = legs.slice(currentLegIndex + 1);
  const identity = currentLeg
    ? [
        [currentLeg.category, currentLeg.tripShortName].filter(Boolean).join(" ").trim(),
        currentLeg.operatorName,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  // While walking to (or waiting at) the next boarding point, show its live
  // departure board so the rider knows if their service is next.
  const nextTransitLeg = legs.slice(currentLegIndex).find((l) => l.mode !== "walking" && l.route);
  const boardingSoon =
    currentLeg?.mode === "walking" && nextTransitLeg && nextTransitLeg !== currentLeg;

  return (
    <Box sx={scroll ? { maxHeight: "56vh", overflowY: "auto" } : undefined}>
      {boardingSoon && nextTransitLeg?.from.stopId && (
        <TransitBoardingDepartures
          stopId={nextTransitLeg.from.stopId}
          stopName={nextTransitLeg.from.name}
          targetTripId={nextTransitLeg.tripId}
          targetRouteShortName={nextTransitLeg.route?.shortName}
        />
      )}
      {isTransitLeg && (
        <Box
          sx={{
            px: 2,
            pt: 1.5,
            pb: 1.5,
            display: "flex",
            gap: 1.25,
            borderTop: "1px solid",
            borderColor: "divider",
          }}
        >
          <Box sx={{ pt: 0.25 }}>
            <RouteBadge
              shortName={currentLeg.route?.shortName ?? ""}
              color={currentLeg.route?.color}
              textColor={currentLeg.route?.textColor}
              mode={currentLeg.mode}
            />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
              {currentLeg.headsign ?? currentLeg.to.name}
            </Typography>
            {identity && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", overflowWrap: "anywhere", mt: 0.25 }}
              >
                {identity}
              </Typography>
            )}
          </Box>
        </Box>
      )}
      {isTransitLeg && showDataStatus && (
        <Box sx={{ px: 2, py: 0.5, "&:empty": { display: "none" } }}>
          <TransitDataStatus
            now={now}
            realtime={currentLeg.realtime}
            freshness={journeyQuery.freshness}
            source={itinerary.source ?? itinerary.instance}
            queryFailed={journeyQuery.isError}
          />
        </Box>
      )}
      {isTransitLeg && showQueryNotice && (
        <TransitQueryNotice
          failed={journeyQuery.isError}
          partial={journeyQuery.freshness?.isPartial}
          onRetry={
            browserAuthority
              ? () => {
                  void journeyQuery.refetch();
                }
              : undefined
          }
          retrying={journeyQuery.isFetching}
        />
      )}
      {isTransitLeg && legStops.length === 0 && (
        <Typography variant="body2" sx={{ px: 2, py: 1 }}>
          {t("stopCountUnavailable")}
        </Typography>
      )}
      {legStops.length > 0 && (
        <TransitStopTimeline
          key={`${currentLegIndex}:${currentLeg.tripId}`}
          stops={legStops}
          leg={currentLeg}
          progress={transitProgress}
        />
      )}
      {upcomingLegs.length > 0 && (
        <>
          <Typography
            variant="subtitle2"
            sx={{
              display: "block",
              px: 2,
              pt: 1.5,
              pb: 0.5,
              color: "text.secondary",
              borderTop: "1px solid",
              borderColor: "divider",
            }}
          >
            {t("restOfJourney")}
          </Typography>
          {upcomingLegs.map((leg) => (
            <UpcomingLegRow
              key={`${leg.tripId ?? leg.mode}-${leg.startTime}-${leg.from.stopId ?? leg.from.name}-${leg.to.stopId ?? leg.to.name}`}
              leg={leg}
              now={now}
              source={itinerary.source ?? itinerary.instance}
            />
          ))}
        </>
      )}
    </Box>
  );
}
