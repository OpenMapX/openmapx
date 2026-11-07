"use client";
import { type TransitProgress, useNavigationStore } from "@openmapx/core";
import {
  isApproachingTransitAlight,
  selectLegPlatform,
  type TransitTransfer,
} from "@openmapx/core/navigation";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { haptics } from "@/lib/haptics";
import { useMobileRuntime } from "@/lib/mobile/useMobileRuntime";
import { notifyGetOff, playAlarmTone } from "@/lib/navigation/navNotify";
import { claimBrowserTransitCue } from "@/lib/navigation/transitCueLedger";
import { useNavigationVoice } from "@/lib/navigation/useNavigationVoice";
import { collectTransitNavigationAlerts } from "./TransitAlertBanner";

/** Session-level cues. Moving or expanding presentation cannot replay them. */
export function TransitGuidanceCues({
  itinerary,
  legIndex,
  transitProgress,
  transfer,
  active = true,
}: {
  itinerary: TripItinerary;
  legIndex: number;
  transitProgress: TransitProgress | null;
  transfer?: TransitTransfer | null;
  active?: boolean;
}) {
  const leg = itinerary.legs[legIndex];
  const t = useTranslations("navigation");
  const locale = useLocale();
  const speak = useNavigationVoice(locale);
  const { browserAuthority } = useMobileRuntime();
  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);
  const captures = useNavigationStore((s) => s.transitCaptures);
  const alertedRef = useRef(false);
  const isTransitLeg = leg?.mode !== "walking" && !!leg?.route;
  const departed = transitProgress?.phase === "riding";
  const line = leg?.route?.shortName || leg?.route?.longName || "";
  const capture = captures.find(
    (c) => c.legIndex === legIndex && c.tripId === leg?.tripId && c.status === "captured",
  );
  const alightSoon =
    !!leg &&
    departed &&
    transitProgress?.confidence === "gps" &&
    !leg.cancelled &&
    isApproachingTransitAlight(
      capture?.stops ?? [],
      transitProgress.stopCursor ?? 1,
      transitProgress.position,
    );
  const boardingPlatform = leg
    ? selectLegPlatform(leg, legIndex, captures, "departure").code
    : undefined;
  // The session ledger keeps alight cues single-shot across remounts and
  // transient confidence changes. The ref also avoids repeated work in-window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce on the alightSoon transition only.
  useEffect(() => {
    if (!browserAuthority || !active || !leg) return;
    if (alightSoon && !alertedRef.current && claimBrowserTransitCue(`alight:${legIndex}`)) {
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
          transfer && !transfer.nextLeg.cancelled
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
  }, [alightSoon, active]);

  // Speak the boarding cue once when a transit leg becomes current, before you've
  // boarded (it's moot once under way).
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce once per current leg, including rides without trip IDs.
  useEffect(() => {
    if (
      !leg ||
      !active ||
      !browserAuthority ||
      !isTransitLeg ||
      !voiceEnabled ||
      departed ||
      leg.cancelled
    )
      return;
    if (!claimBrowserTransitCue(`boarding:${legIndex}`)) return;
    speak(
      boardingPlatform
        ? t("voiceBoardPlatform", { line, destination: leg.to.name, platform: boardingPlatform })
        : t("voiceBoard", { line, destination: leg.to.name }),
    );
  }, [leg?.tripId, legIndex, active]);

  const topAlert = collectTransitNavigationAlerts(itinerary, legIndex, transitProgress, t)[0];
  // biome-ignore lint/correctness/useExhaustiveDependencies: the session ledger owns each alert identity.
  useEffect(() => {
    if (
      active &&
      browserAuthority &&
      voiceEnabled &&
      topAlert &&
      claimBrowserTransitCue(`alert:${topAlert.id}`)
    )
      speak(topAlert.ttsTitle ?? topAlert.title);
  }, [topAlert?.id, active]);
  return null;
}
