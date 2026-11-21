"use client";

import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { type TransitProgress, useNavigationStore, useVehicleJourney } from "@openmapx/core";
import { selectLegPlatform } from "@openmapx/core/navigation";
import type { TripItinerary, TripLeg, VehicleJourneyStop } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  itineraryContributors,
  railSegment,
  TransitLegTimeline,
} from "@/components/panels/directions/TransitLegTimeline";
import { DepartureTime } from "@/components/panels/transit/DepartureTime";
import {
  TransitDataStatus,
  TransitQueryNotice,
} from "@/components/panels/transit/TransitDataStatus";
import { RailDot, TimelineRow } from "@/components/ui/TimelineRail";
import { useMobileRuntime } from "@/lib/mobile/useMobileRuntime";
import { useTripEndLabels } from "@/lib/navigation/useTripEndLabels";
import { stopTransitTime } from "@/lib/transitTime";
import { useNow } from "@/lib/useNow";
import { TransitBoardingDepartures } from "./TransitBoardingDepartures";

/**
 * The stops a ride passes between boarding and getting off, on the ride's bar,
 * with the rider's progress: the next stop filled, those passed greyed out.
 */
function RideStops({
  stops,
  nextIdx,
  leg,
}: {
  stops: VehicleJourneyStop[];
  nextIdx: number;
  leg: TripLeg;
}) {
  const t = useTranslations("navigation");
  const segment = railSegment(leg);
  if (!segment) return null;
  return stops.slice(1, -1).map((stop, k) => {
    const i = k + 1;
    const passed = i < nextIdx;
    const isNext = i === nextIdx;
    return (
      <TimelineRow
        // A loop line can pass the same stop twice.
        key={`${stop.stopId}:${i}`}
        through={segment}
        dense
        nodeY={14}
        node={<RailDot color={passed ? "#9E9E9E" : segment.color} size={10} filled={isNext} />}
        time={
          <DepartureTime
            {...stopTransitTime(stop)}
            canceled={stop.canceled}
            variant="caption"
            fontWeight={isNext ? 700 : 400}
            muted={passed}
          />
        }
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
          <Typography
            variant="body2"
            sx={{
              minWidth: 0,
              overflowWrap: "anywhere",
              fontWeight: isNext ? 600 : 400,
              textDecoration: stop.canceled ? "line-through" : "none",
              color: stop.canceled ? "error.main" : passed ? "text.secondary" : "text.primary",
            }}
          >
            {stop.name}
          </Typography>
          {stop.alerts?.[0] && (
            <Tooltip title={stop.alerts[0].title} placement="top" arrow>
              <WarningAmberIcon sx={{ fontSize: 15, color: "warning.main", flexShrink: 0 }} />
            </Tooltip>
          )}
        </Box>
        {stop.canceled && (
          <Typography variant="caption" sx={{ color: "error.main", fontWeight: 600 }}>
            {t("stopSkipped")}
          </Typography>
        )}
      </TimelineRow>
    );
  });
}

/**
 * Expanded content of the transit guidance sheet: the trip as the same
 * timeline its route details show, from the current step on (earlier ones
 * fold away), with live progress through the current ride's stops and the
 * platforms the trip captured. While walking to a stop, its departures follow.
 */
export function TransitJourneySheet({
  itinerary,
  currentLegIndex,
  transitProgress,
  scroll = true,
  showQueryNotice = true,
}: {
  itinerary: TripItinerary;
  currentLegIndex: number;
  transitProgress: TransitProgress | null;
  /**
   * Cap the content at 56vh and scroll internally (mobile swipe-sheet default).
   * Desktop passes `false` so the parent panel owns a single scroll region and
   * the menu below stays reachable instead of adding a nested scrollbar.
   */
  scroll?: boolean;
  /** Navigation already displays the same query warning above the map. */
  showQueryNotice?: boolean;
}) {
  const t = useTranslations("navigation");
  const now = useNow(30_000);
  const labels = useTripEndLabels();
  const [showPrevious, setShowPrevious] = useState(false);
  const legs = itinerary.legs;
  const currentLeg = legs[currentLegIndex];
  const isTransitLeg = !!currentLeg && currentLeg.mode !== "walking" && !!currentLeg.route;
  // The shell follows the trip's live data itself; a second owner here would
  // be the one that stops working underground.
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
  const nextIdx = transitProgress?.phase === "riding" ? (transitProgress.stopCursor ?? 1) : 0;

  // While walking to (or waiting at) the next boarding point, show its live
  // departure board so the rider knows if their service is next.
  const nextTransitLeg = legs.slice(currentLegIndex).find((l) => l.mode !== "walking" && l.route);
  const boardingSoon =
    currentLeg?.mode === "walking" && nextTransitLeg && nextTransitLeg !== currentLeg;

  return (
    <Box sx={scroll ? { maxHeight: "56vh", overflowY: "auto" } : undefined}>
      {isTransitLeg && (
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
      {currentLegIndex > 0 && (
        <Button
          size="small"
          color="inherit"
          startIcon={showPrevious ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          aria-expanded={showPrevious}
          onClick={() => setShowPrevious((shown) => !shown)}
          sx={{ mx: 1, mt: 0.5, color: "text.secondary" }}
        >
          {t(showPrevious ? "hidePreviousSteps" : "showPreviousSteps")}
        </Button>
      )}
      <TransitLegTimeline
        itinerary={itinerary}
        originLabel={labels.origin}
        destinationLabel={labels.destination}
        selectedAttributions={itineraryContributors(itinerary)}
        live={browserAuthority}
        fromLegIndex={showPrevious ? 0 : currentLegIndex}
        legPlatform={(leg, index, event) => selectLegPlatform(leg, index, captures, event)}
        renderStops={(leg, index) =>
          index === currentLegIndex && legStops.length > 0 ? (
            <RideStops stops={legStops} nextIdx={nextIdx} leg={leg} />
          ) : undefined
        }
      />
      {boardingSoon && nextTransitLeg?.from.stopId && (
        <TransitBoardingDepartures
          stopId={nextTransitLeg.from.stopId}
          stopName={nextTransitLeg.from.name}
          targetTripId={nextTransitLeg.tripId}
          targetRouteShortName={nextTransitLeg.route?.shortName}
        />
      )}
    </Box>
  );
}
