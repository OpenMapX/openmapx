"use client";

import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import NotificationImportantIcon from "@mui/icons-material/NotificationImportant";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import {
  stopsUntilAlight,
  type TransitProgress,
  useNavigationStore,
  useVehicleJourney,
} from "@openmapx/core";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { OccupancyIndicator } from "@/components/panels/transit/OccupancyIndicator";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { haptics } from "@/lib/haptics";
import { sliceJourneyToLeg } from "@/lib/navigation/legJourneyStops";
import { notifyGetOff, playAlarmTone } from "@/lib/navigation/navNotify";
import { changedFromPlatform } from "@/lib/navigation/platformChange";
import type { TransitTransfer } from "@/lib/navigation/transitTransfer";
import { useNavigationVoice } from "@/lib/navigation/useNavigationVoice";
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
  const locale = useLocale();
  const speak = useNavigationVoice(locale);
  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);
  const isTransitLeg = leg.mode !== "walking" && !!leg.route;
  const { data: journey } = useVehicleJourney(isTransitLeg ? (leg.tripId ?? null) : null);
  const alertedRef = useRef(false);
  const line = leg.route?.shortName || leg.route?.longName || "";

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
  // Prefer the live vehicle's crowding, falling back to the planned leg value.
  const occupancy = journey?.occupancy ?? leg.occupancy;
  // Specific vehicle identity ("RE 10123 · DB Regio") to find the right train.
  const identity = [
    [leg.category, leg.tripShortName].filter(Boolean).join(" ").trim(),
    leg.operatorName,
  ]
    .filter(Boolean)
    .join(" · ");
  // Bus-stop signage code, shown while boarding when there's no platform.
  const boardingStopCode = leg.from.stopCode;

  // Fire the haptic pulse — and, when voice is on, the alight/transfer cue —
  // once per entry into the alight window; reset when we leave it so a re-entry
  // can announce again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce on the alightSoon transition only.
  useEffect(() => {
    if (alightSoon && !alertedRef.current) {
      alertedRef.current = true;
      haptics.warn();
      // Get-off alarm: an attention tone always, and a system notification when
      // the app is backgrounded / screen locked so the rider is woken in time.
      playAlarmTone();
      if (typeof document !== "undefined" && document.hidden) {
        void notifyGetOff(t("alightSoon"), t("alightAt", { place: leg.to.name }));
      }
      if (voiceEnabled) {
        speak(
          transfer
            ? t("voiceTransfer", {
                stop: leg.to.name,
                line: transfer.nextLeg.route?.shortName || transfer.nextLeg.route?.longName || "",
              })
            : t("voiceAlight", { stop: leg.to.name }),
        );
      }
    } else if (!alightSoon) {
      alertedRef.current = false;
    }
  }, [alightSoon]);

  // Speak the boarding cue once when a transit leg becomes current, before you've
  // boarded (it's moot once under way).
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce once per leg (keyed on tripId).
  useEffect(() => {
    if (!isTransitLeg || !voiceEnabled || departed) return;
    speak(
      boardingPlatform
        ? t("voiceBoardPlatform", { line, destination: leg.to.name, platform: boardingPlatform })
        : t("voiceBoard", { line, destination: leg.to.name }),
    );
  }, [leg.tripId]);

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
      <NavBannerShell
        leading={leading}
        secondary={secondary}
        trailing={
          isTransitLeg && occupancy ? <OccupancyIndicator level={occupancy} size={24} /> : undefined
        }
      >
        <Typography variant="h6" sx={{ lineHeight: 1.15 }} noWrap>
          {title}
        </Typography>
        {isTransitLeg && (headsign || (!departed && (boardingPlatform || boardingStopCode))) && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.25, minWidth: 0 }}>
            {headsign && (
              <Typography variant="caption" sx={{ opacity: 0.9 }} noWrap>
                {t("towards", { headsign })}
              </Typography>
            )}
            {!departed && boardingPlatform ? (
              <PlatformBadge
                code={boardingPlatform}
                tone="onBanner"
                changed={!!changedFromPlatform(leg.from)}
              />
            ) : !departed && boardingStopCode ? (
              <Typography variant="caption" sx={{ opacity: 0.9 }} noWrap>
                {t("stopCode", { code: boardingStopCode })}
              </Typography>
            ) : null}
          </Box>
        )}
        {isTransitLeg && identity && (
          <Typography variant="caption" sx={{ opacity: 0.8, display: "block", mt: 0.25 }} noWrap>
            {identity}
          </Typography>
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
