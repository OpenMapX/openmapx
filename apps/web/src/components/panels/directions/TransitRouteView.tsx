"use client";

import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsRunIcon from "@mui/icons-material/DirectionsRun";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import NavigationIcon from "@mui/icons-material/Navigation";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import type { TransitReplanOptions } from "@openmapx/core";
import {
  formatDistance,
  formatDuration,
  tzOffsetLabel,
  useRefreshTransitItinerary,
  useSettingsStore,
  useVehicleJourney,
} from "@openmapx/core";
import { itineraryTransferRisk } from "@openmapx/core/navigation";
import { apiClient } from "@openmapx/core/navigation/api";
import type { OccupancyLevel, TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { OccupancyIndicator } from "@/components/panels/transit/OccupancyIndicator";
import { RemarkChip } from "@/components/panels/transit/RemarkChip";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { extractFareSummary, formatFare } from "@/lib/fareUtils";
import { useStartNavigation } from "@/lib/mobile/useStartNavigation";
import { ensureNotificationPermission } from "@/lib/navigation/navNotify";
import { primeSpeechSynthesis } from "@/lib/navigation/useNavigationVoice";
import { BRAND, BRAND_HEX } from "@/lib/theme";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";
import { formatCo2Emission } from "../../../lib/formatCo2";

const OCCUPANCY_RANK: Record<OccupancyLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  overcrowded: 3,
};

function worstOccupancy(itinerary: TripItinerary): OccupancyLevel | null {
  let worst: OccupancyLevel | null = null;
  for (const leg of itinerary.legs) {
    if (leg.occupancy && (!worst || OCCUPANCY_RANK[leg.occupancy] > OCCUPANCY_RANK[worst])) {
      worst = leg.occupancy;
    }
  }
  return worst;
}

function LegBadge({ leg }: { leg: TripLeg }) {
  if (leg.mode === "walking") {
    return <DirectionsWalkIcon sx={{ fontSize: 16, color: "text.secondary" }} />;
  }
  if (leg.mode === "cycling") {
    return <DirectionsBikeIcon sx={{ fontSize: 16, color: "text.secondary" }} />;
  }
  if (leg.mode === "driving") {
    return <DirectionsCarIcon sx={{ fontSize: 16, color: "text.secondary" }} />;
  }
  if (leg.route) {
    return (
      <RouteBadge
        shortName={leg.route.shortName}
        color={leg.route.color}
        textColor={leg.route.textColor}
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
        bgcolor: `${BRAND_HEX}1a`,
      }}
    >
      <Box sx={{ width: 5, height: 5, borderRadius: "50%", bgcolor: "#4caf50", flexShrink: 0 }} />
      <Typography
        variant="caption"
        sx={{
          fontWeight: 600,
          color: BRAND,
          fontSize: 10,
        }}
      >
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
  const fmt = useDateTimeFormat();
  const { data: journey } = useVehicleJourney(tripId ?? null);
  const stop = stopId ? journey?.stops.find((s) => s.stopId === stopId) : undefined;
  const delayMin = stop ? Math.round((stop.delaySeconds ?? 0) / 60) : 0;
  const hasDelay = delayMin > 0;

  const displayTime =
    hasDelay && stop
      ? fmt.time(
          stop.expectedDeparture ??
            stop.expectedArrival ??
            stop.scheduledDeparture ??
            stop.scheduledArrival ??
            scheduledTime,
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
          sx={{
            fontWeight: 600,
            display: "block",
            color: "error.main",
            fontSize: "0.7rem",
          }}
        >
          +{delayMin}m
        </Typography>
      )}
    </>
  );
}

function TransitEmissionsBadge({
  co2Grams,
  isLowest,
}: {
  co2Grams: number | null | undefined;
  isLowest?: boolean;
}) {
  const t = useTranslations("directions");
  const locale = useLocale();
  const emission = formatCo2Emission(co2Grams, locale);
  if (!emission) return null;

  return (
    <Box
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
        px: 0.75,
        py: 0.35,
        borderRadius: 99,
        bgcolor: isLowest ? "rgba(15, 157, 88, 0.12)" : "action.hover",
        border: "1px solid",
        borderColor: isLowest ? "rgba(15, 157, 88, 0.24)" : "divider",
      }}
    >
      <Box
        sx={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          bgcolor: isLowest ? BRAND : "text.secondary",
          flexShrink: 0,
        }}
      />
      <Typography
        variant="caption"
        sx={{
          fontWeight: 600,
          color: isLowest ? BRAND : "text.secondary",
          fontSize: 10.5,
        }}
      >
        {isLowest ? t("lowestCo2") : t("co2Emissions")}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          fontWeight: 600,
          fontSize: 10.5,
        }}
      >
        {emission}
      </Typography>
    </Box>
  );
}

export function TransitItineraryCard({
  itinerary,
  active,
  isLowestCo2 = false,
  replanOptions,
  originTimeZone = null,
  destinationTimeZone = null,
  onSelect,
  onDetails,
  onRefreshed,
}: {
  itinerary: TripItinerary;
  active: boolean;
  isLowestCo2?: boolean;
  replanOptions?: TransitReplanOptions;
  /**
   * Set only when the origin's zone differs from the viewer's; renders the
   * departure in that zone instead of the viewer's. No offset chip — a
   * departure board reads in the zone you're standing in, so this exists to
   * keep the pair internally consistent (matching `destinationTimeZone`'s
   * zone, not the viewer's), not to add a second annotation.
   */
  originTimeZone?: string | null;
  /** Set only when the trip crosses a time-zone boundary; renders the arrival in that zone with an offset chip. */
  destinationTimeZone?: string | null;
  onSelect: () => void;
  onDetails: () => void;
  onRefreshed?: (itinerary: TripItinerary, changed: boolean, fallbackOccurred: boolean) => void;
}) {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const tNav = useTranslations("navigation");
  const locale = useLocale();
  const fmt = useDateTimeFormat();
  const { startTransit } = useStartNavigation();
  const units = useSettingsStore((s) => s.units);
  // Only meaningful under native authority, where Start captures each ridden
  // leg's stops before the session exists.
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const refreshMutation = useRefreshTransitItinerary();
  const fareSummary = extractFareSummary(itinerary.fare);
  const occupancy = worstOccupancy(itinerary);
  // Plan-time robustness cue: a very short scheduled transfer buffer.
  const tightTransfer = itineraryTransferRisk(itinerary.legs) !== null;
  // Resolve each offset label before formatting the time it gates: unlike
  // these helpers, `fmt.time({ timeZone })` throws (rather than degrading)
  // for a zone id the platform doesn't recognise, so the label doubles as
  // the validity check that keeps the call below from taking the panel down.
  const originOffsetLabel = originTimeZone
    ? tzOffsetLabel(new Date(itinerary.startTime), originTimeZone)
    : null;
  const startTime = fmt.time(
    itinerary.startTime,
    originOffsetLabel ? { timeZone: originTimeZone as string } : undefined,
  );
  const destinationOffsetLabel = destinationTimeZone
    ? tzOffsetLabel(new Date(itinerary.endTime), destinationTimeZone)
    : null;
  const endTime = fmt.time(
    itinerary.endTime,
    destinationOffsetLabel ? { timeZone: destinationTimeZone as string } : undefined,
  );
  /**
   * Starts the trip and reports why it could not be, if it could not be.
   *
   * `finally` rather than a happy-path reset: an exception here would otherwise
   * leave Start disabled with no way back.
   */
  const begin = async (planned: TripItinerary) => {
    try {
      const result = await startTransit({
        itinerary: planned,
        client: apiClient,
        replanOptions,
        locale: locale === "de" ? "de" : "en",
        units,
      });
      setStartError(result.ok ? null : result.code);
    } finally {
      setStarting(false);
    }
  };

  const metaBits: string[] = [];
  if (itinerary.transfers > 0) metaBits.push(t("transfers", { count: itinerary.transfers }));
  if (itinerary.walkDistance > 0) {
    metaBits.push(t("walkDistance", { distance: formatDistance(itinerary.walkDistance) }));
  }

  return (
    <Box
      onClick={onSelect}
      role="button"
      sx={{
        px: 2,
        py: 1.5,
        cursor: "pointer",
        borderLeft: active ? `4px solid ${BRAND}` : "4px solid transparent",
        bgcolor: active ? "rgba(0,123,139,0.04)" : "transparent",
        "&:hover": { bgcolor: active ? "rgba(0,123,139,0.07)" : "action.hover" },
        transition: "background-color 0.15s",
      }}
    >
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <DirectionsTransitIcon sx={{ fontSize: 18, color: active ? BRAND : "text.disabled" }} />
          <Typography
            variant="body2"
            sx={{
              fontWeight: 600,
            }}
          >
            {startTime} – {endTime}
          </Typography>
          {destinationOffsetLabel && (
            <Typography component="span" sx={{ fontSize: 11, color: "text.secondary", ml: 0.5 }}>
              {destinationOffsetLabel}
            </Typography>
          )}
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {occupancy && <OccupancyIndicator level={occupancy} size={16} />}
          <Typography
            variant="body2"
            color={active ? BRAND : "text.primary"}
            sx={{
              fontWeight: 600,
            }}
          >
            {formatDuration(itinerary.duration)}
          </Typography>
        </Box>
      </Box>
      {/* Leg summary + fare */}
      <Box
        sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mt: 0.75 }}
      >
        <Box
          sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap", minWidth: 0 }}
        >
          {itinerary.legs.map((leg, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable id
            <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              {i > 0 && <ChevronRightIcon sx={{ fontSize: 14, color: "text.disabled" }} />}
              <LegBadge leg={leg} />
            </Box>
          ))}
        </Box>
        {fareSummary && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              bgcolor: "action.hover",
              px: 0.75,
              py: 0.125,
              borderRadius: 0.75,
              fontSize: "0.7rem",
              lineHeight: 1.4,
              flexShrink: 0,
              ml: 1,
            }}
          >
            {t("fareApprox", {
              amount: formatFare(fareSummary.amount, fareSummary.currency, locale),
            })}
          </Typography>
        )}
      </Box>
      {metaBits.length > 0 && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            mt: 0.5,
            display: "block",
          }}
        >
          {metaBits.join(" · ")}
        </Typography>
      )}
      {tightTransfer && (
        <Box
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0.5,
            mt: 0.75,
            px: 0.75,
            py: 0.25,
            borderRadius: 99,
            bgcolor: "warning.main",
            color: "warning.contrastText",
          }}
        >
          <DirectionsRunIcon sx={{ fontSize: 14 }} />
          <Typography variant="caption" sx={{ fontWeight: 600, fontSize: 10.5 }}>
            {tNav("tightTransfer")}
          </Typography>
        </Box>
      )}
      {itinerary.co2Grams !== undefined && (
        <Box sx={{ mt: metaBits.length > 0 ? 0.75 : 0.5 }}>
          <TransitEmissionsBadge co2Grams={itinerary.co2Grams} isLowest={isLowestCo2} />
        </Box>
      )}
      {active && (
        <Box sx={{ mt: 0.5, ml: -1.5, display: "flex", alignItems: "center", gap: 0.5 }}>
          <Typography
            component="span"
            variant="caption"
            sx={{
              color: BRAND,
              cursor: "pointer",
              fontWeight: 500,
              px: 1.5,
              py: 0.75,
              borderRadius: 99,
              "&:hover": { bgcolor: `${BRAND}18` },
              transition: "background-color 0.15s",
            }}
            onClick={(e) => {
              e.stopPropagation();
              onDetails();
            }}
          >
            {tc("details")}
          </Typography>
          <Button
            size="small"
            variant="contained"
            startIcon={<NavigationIcon />}
            disabled={refreshMutation.isPending || starting}
            onClick={async (e) => {
              e.stopPropagation();
              // Unlock TTS from this gesture so board/alight cues can speak on iOS.
              // A no-op inside the shell, where native owns the voice.
              primeSpeechSynthesis();
              // Ask for notification permission so the background get-off alarm
              // can fire when the screen is locked. Also a no-op in the shell,
              // which already holds the OS permission.
              void ensureNotificationPermission();
              if (starting) return;
              setStarting(true);
              const plannedAt = itinerary.refreshedAt ?? itinerary.plannedAt;
              const oldEnough = !plannedAt || Date.now() - new Date(plannedAt).getTime() >= 60_000;
              if (itinerary.refreshToken && oldEnough) {
                try {
                  const response = await refreshMutation.mutateAsync(itinerary.refreshToken);
                  const next = response.data.itinerary;
                  const changed =
                    next.startTime !== itinerary.startTime ||
                    next.endTime !== itinerary.endTime ||
                    next.legs.length !== itinerary.legs.length ||
                    next.legs.some(
                      (leg, index) =>
                        leg.startTime !== itinerary.legs[index]?.startTime ||
                        leg.endTime !== itinerary.legs[index]?.endTime ||
                        leg.from.platformCode !== itinerary.legs[index]?.from.platformCode ||
                        leg.to.platformCode !== itinerary.legs[index]?.to.platformCode,
                    );
                  onRefreshed?.(next, changed, response.data.fallbackOccurred);
                  await begin(next);
                  return;
                } catch {
                  // A failed optional refresh must not block navigation; the
                  // existing missed-connection path still performs a full replan.
                }
              }
              await begin(itinerary);
            }}
            sx={{
              bgcolor: BRAND,
              textTransform: "none",
              borderRadius: 99,
              "&:hover": { bgcolor: BRAND },
            }}
          >
            {tNav("start")}
          </Button>
          {startError && (
            <Typography role="alert" sx={{ fontSize: 12, color: "error.main", ml: 1 }}>
              {tNav(startError === "incompatible" ? "startUpdateRequired" : "startFailed")}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}

// Re-export internal helpers needed by TransitDetailsView
export { LegBadge, LegRemarks, LiveStopTime, TransitEmissionsBadge, TransitLiveBadge };
