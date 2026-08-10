"use client";

import Box from "@mui/material/Box";
import { type TransitProgress, useNavigationStore } from "@openmapx/core";
import { changedFromPlatform, collectActiveAlerts } from "@openmapx/core/navigation";
import type { ServiceAlert, TripItinerary } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";
import { AlertCard } from "@/components/panels/transit/AlertCard";
import { useNavigationVoice } from "@/lib/navigation/useNavigationVoice";

/** Cap so a noisy feed can't push the banner over the map. */
const MAX_CARDS = 2;

/**
 * Surfaces service alerts/disruptions for the rest of the trip during transit
 * navigation — reusing the planning {@link AlertCard} — plus a prominent
 * cancellation card when a current/upcoming ride is cancelled. Shows the most
 * severe alerts first, capped. Renders nothing when there's nothing to say.
 */
export function TransitAlertBanner({
  itinerary,
  currentLegIndex,
  transitProgress,
}: {
  itinerary: TripItinerary;
  currentLegIndex: number;
  transitProgress: TransitProgress | null;
}) {
  const t = useTranslations("navigation");
  const locale = useLocale();
  const speak = useNavigationVoice(locale);
  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);
  const legs = itinerary.legs;
  const alerts = collectActiveAlerts(legs, currentLegIndex);

  const cards: ServiceAlert[] = [];

  // A cancelled ride is the most urgent thing to say — synthesize a severe card
  // when the feed doesn't already carry an explicit alert for it.
  const cancelledLeg = legs.slice(Math.max(0, currentLegIndex)).find((l) => l.cancelled && l.route);
  if (cancelledLeg?.route) {
    cards.push({
      id: `cancel:${cancelledLeg.tripId ?? cancelledLeg.route.shortName}`,
      providers: [],
      severity: "severe",
      title: t("legCancelled", {
        line: cancelledLeg.route.shortName || cancelledLeg.route.longName || "",
      }),
      affectedRouteIds: [],
      affectedStopIds: [],
      activePeriods: [],
    });
  }

  // Boarding platform changed for the ride you're about to catch: prominent while
  // you haven't boarded yet (it's moot once under way).
  const currentLeg = legs[currentLegIndex];
  const departed = (transitProgress?.fractionAlongLeg ?? 0) > 0.12;
  const wasPlatform = currentLeg ? changedFromPlatform(currentLeg.from) : undefined;
  if (currentLeg?.route && !departed && wasPlatform && currentLeg.from.platformCode) {
    cards.push({
      id: `platform:${currentLeg.tripId ?? currentLeg.route.shortName}`,
      providers: [],
      severity: "warning",
      title: t("platformChanged", {
        line: currentLeg.route.shortName || currentLeg.route.longName || "",
        platform: currentLeg.from.platformCode,
        scheduled: wasPlatform,
      }),
      affectedRouteIds: [],
      affectedStopIds: [],
      activePeriods: [],
    });
  }

  cards.push(...alerts);

  const shown = cards.slice(0, MAX_CARDS);

  // Announce the most urgent alert once (keyed on its id), using the feed's
  // TTS-optimized text when present. Effect must precede the early return.
  const topAlert = shown[0];
  const topId = topAlert?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce once per distinct alert.
  useEffect(() => {
    if (topAlert && voiceEnabled) speak(topAlert.ttsTitle ?? topAlert.title);
  }, [topId]);

  if (shown.length === 0) return null;

  return (
    <Box
      sx={{
        pointerEvents: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      {shown.map((alert) => (
        <AlertCard key={alert.id} alert={alert} expandable={false} />
      ))}
    </Box>
  );
}
