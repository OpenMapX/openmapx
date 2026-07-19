"use client";

import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import NotificationImportantIcon from "@mui/icons-material/NotificationImportant";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { stopsUntilAlight, type TransitProgress, useVehicleJourney } from "@openmapx/core";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { haptics } from "@/lib/haptics";
import { sliceJourneyToLeg } from "@/lib/navigation/legJourneyStops";
import { changedFromPlatform } from "@/lib/navigation/platformChange";
import type { TransitTransfer } from "@/lib/navigation/transitTransfer";
import { NavBannerShell } from "./NavBannerShell";
import { PlatformBadge } from "./PlatformBadge";
import { TransitTransferCard } from "./TransitTransferCard";

/**
 * Slice the full vehicle journey down to the stops for this leg (board → alight)
 * and project to the shape stopsUntilAlight needs, so the countdown matches the
 * itinerary detail view.
 */
function legStopsFor(
  stops: { stopId: string; name: string; lat: number; lng: number }[],
  leg: TripLeg,
): { lat: number; lng: number; name: string }[] {
  return sliceJourneyToLeg(stops, leg.from.stopId, leg.to.stopId).map((s) => ({
    lat: s.lat,
    lng: s.lng,
    name: s.name,
  }));
}

/**
 * Transit follow-along banner for the current leg. Reuses {@link NavBannerShell}
 * so it matches the driving {@link ManeuverBanner}: a teal card with the mode
 * badge + "{line} to {destination}" + a leg counter, the live next-stop preview
 * in the darkened sub-row (the transit analogue of the driving "Then …" line),
 * and — when the alight stop is one away — a prominent "get off now" card below
 * (mirroring how the driving banner surfaces an approach alert beneath itself).
 */
export function TransitLegBanner({
  leg,
  legIndex,
  totalLegs,
  transitProgress,
  transfer,
}: {
  leg: TripLeg;
  legIndex: number;
  totalLegs: number;
  transitProgress: TransitProgress | null;
  /** The upcoming change onto another line, when this ride is not the last. */
  transfer?: TransitTransfer | null;
}) {
  const t = useTranslations("navigation");
  const isTransitLeg = leg.mode !== "walking" && !!leg.route;
  const { data: journey } = useVehicleJourney(isTransitLeg ? (leg.tripId ?? null) : null);
  const alertedRef = useRef(false);

  const legStops =
    isTransitLeg && journey?.stops && transitProgress ? legStopsFor(journey.stops, leg) : [];
  const { nextStopName, stopsRemaining } =
    transitProgress && legStops.length > 0
      ? stopsUntilAlight(leg.geometry.coordinates, legStops, transitProgress.snapped)
      : { nextStopName: null as string | null, stopsRemaining: 0 };

  const alightSoon = legStops.length > 0 && stopsRemaining > 0 && stopsRemaining <= 1;
  // Boarding platform is only relevant until you're on board; once under way the
  // alight platform (surfaced on the "get off" card) is what matters.
  const departed = (transitProgress?.fractionAlongLeg ?? 0) > 0.12;
  const boardingPlatform = leg.from.platformCode;
  const alightPlatform = leg.to.platformCode;
  // Show the vehicle's destination sign when it adds information beyond the
  // alight stop already named in the title.
  const headsign = leg.headsign && leg.headsign !== leg.to.name ? leg.headsign : undefined;

  // Fire the haptic pulse once per entry into the alight window; reset when we
  // leave it so a re-entry can buzz again.
  useEffect(() => {
    if (alightSoon && !alertedRef.current) {
      alertedRef.current = true;
      haptics.warn();
    } else if (!alightSoon) {
      alertedRef.current = false;
    }
  }, [alightSoon]);

  const leading =
    leg.mode === "walking" || !leg.route ? (
      <DirectionsWalkIcon sx={{ fontSize: 40 }} />
    ) : (
      <RouteBadge
        shortName={leg.route.shortName}
        color={leg.route.color}
        textColor={leg.route.textColor}
        mode={leg.mode}
        size="medium"
      />
    );

  const title =
    leg.mode === "walking"
      ? t("walkTo", { place: leg.to.name })
      : t("ride", {
          line: leg.route?.shortName ?? leg.route?.longName ?? "",
          to: leg.to.name,
        });

  // Sub-row: the live next-stop / alight preview for transit legs. Hidden while
  // `alightSoon`, since the prominent card below carries that message instead.
  const secondary =
    isTransitLeg && !alightSoon ? (
      <Typography variant="body2" sx={{ opacity: 0.9 }} noWrap>
        {nextStopName
          ? t("nextStop", { stop: nextStopName })
          : stopsRemaining > 0
            ? t("alightAtCount", { place: leg.to.name, count: stopsRemaining })
            : t("alightAt", { place: leg.to.name })}
      </Typography>
    ) : undefined;

  return (
    <>
      <NavBannerShell leading={leading} secondary={secondary}>
        <Typography variant="h6" sx={{ lineHeight: 1.15 }} noWrap>
          {title}
        </Typography>
        {isTransitLeg && (headsign || (!departed && boardingPlatform)) && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.25, minWidth: 0 }}>
            {headsign && (
              <Typography variant="caption" sx={{ opacity: 0.9 }} noWrap>
                {t("towards", { headsign })}
              </Typography>
            )}
            {!departed && boardingPlatform && (
              <PlatformBadge
                code={boardingPlatform}
                tone="onBanner"
                changed={!!changedFromPlatform(leg.from)}
              />
            )}
          </Box>
        )}
        <Typography variant="caption" sx={{ opacity: 0.85, display: "block", mt: 0.25 }}>
          {t("legCounter", { current: legIndex + 1, total: totalLegs })}
        </Typography>
      </NavBannerShell>
      {alightSoon && transfer ? (
        <TransitTransferCard
          fromLeg={leg}
          nextLeg={transfer.nextLeg}
          walkSeconds={transfer.walkSeconds}
        />
      ) : alightSoon ? (
        <Box
          role="status"
          aria-live="polite"
          sx={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            px: 2,
            py: 1.25,
            bgcolor: "error.main",
            color: "error.contrastText",
            borderRadius: 2,
            boxShadow: 2,
          }}
        >
          <NotificationImportantIcon sx={{ fontSize: 28 }} />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {t("alightSoon")}
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
              <Typography variant="caption" noWrap>
                {t("alightAt", { place: leg.to.name })}
              </Typography>
              {alightPlatform && <PlatformBadge code={alightPlatform} tone="onBanner" />}
            </Box>
          </Box>
        </Box>
      ) : null}
    </>
  );
}
