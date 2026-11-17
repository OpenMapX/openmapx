"use client";

import { type TransitProgress, useNavigationStore } from "@openmapx/core";
import {
  composeWalkInstruction,
  nextWalkManeuver,
  transitWalkVoiceCue,
  walkLegStepProgress,
  walkStepInfo,
} from "@openmapx/core/navigation";
import { formatNavigationCue } from "@openmapx/i18n/navigationCuesCompact";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";
import { tripPlaceName } from "@/components/panels/directions/transitSummary";
import { useMobileRuntime } from "@/lib/mobile/useMobileRuntime";
import { claimBrowserTransitCue } from "@/lib/navigation/transitCueLedger";
import { useNavigationVoice } from "@/lib/navigation/useNavigationVoice";
import { useTripEndLabels } from "@/lib/navigation/useTripEndLabels";
import { ManeuverBanner } from "./ManeuverBanner";

/**
 * Turn-by-turn guidance for a transit WALK leg (access to the first stop, egress,
 * or a transfer walk). Reuses the driving {@link ManeuverBanner} — same card,
 * icons, "In {distance}" countdown and "Then…" preview — by mapping the MOTIS
 * walk steps onto its maneuver/instruction props. Tracks which step you're on
 * from the leg progress; speaks each instruction when voice is on.
 */
export function TransitWalkBanner({
  leg,
  transitProgress,
  units,
}: {
  leg: TripLeg;
  transitProgress: TransitProgress | null;
  units: "metric" | "imperial";
}) {
  const { browserAuthority } = useMobileRuntime();
  const t = useTranslations("navigation");
  const locale = useLocale();
  const speak = useNavigationVoice(locale);
  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);

  const destination = tripPlaceName(leg.to, useTripEndLabels().destination);
  const steps = leg.steps ?? [];
  const fraction = transitProgress?.fractionAlongLeg ?? 0;
  const fallback = walkLegStepProgress(steps, fraction);
  const currentStepIndex = transitProgress?.currentWalkStepIndex ?? fallback.currentStepIndex;
  const distanceToNextStepMeters =
    transitProgress?.distanceToNextStepMeters ?? fallback.distanceToNextStepMeters;

  // The maneuver you're approaching sits at the END of the current step, i.e. the
  // next step's turn; past the last step you're arriving at the leg destination.
  const upcoming = steps[currentStepIndex + 1];
  // What the banner shows skips the planner's bare "continue" steps, so it
  // counts down to the next real turn (or the stop) rather than to a
  // "Continue, then continue".
  const shown = nextWalkManeuver(steps, currentStepIndex, distanceToNextStepMeters);
  const then = shown.index === null ? null : nextWalkManeuver(steps, shown.index, 0);
  const shownInfo = shown.index === null ? null : walkStepInfo(steps[shown.index]);
  const maneuver = shownInfo ? shownInfo.maneuver : { type: "arrive" };
  const shownInstruction = shownInfo
    ? composeWalkInstruction(shownInfo, t)
    : t("walkDir.arrive", { place: destination });
  const nextInfo = then?.index != null ? walkStepInfo(steps[then.index]) : null;
  const nextInstruction = nextInfo
    ? composeWalkInstruction(nextInfo, t)
    : then
      ? t("walkDir.arrive", { place: destination })
      : undefined;
  // The voice cue still follows each step, which carries its own geometry.
  const upcomingInfo = upcoming ? walkStepInfo(upcoming) : null;
  const instruction = upcomingInfo
    ? composeWalkInstruction(upcomingInfo, t)
    : t("walkDir.arrive", { place: destination });

  useEffect(() => {
    if (!browserAuthority || !transitProgress || transitProgress.confidence !== "gps" || !upcoming)
      return;
    const tick = useNavigationStore.getState().transitTickState;
    const prefix = `walk:${transitProgress.currentLegIndex}:${transitProgress.walkRevision ?? 0}:`;
    const cue = transitWalkVoiceCue(
      upcoming,
      currentStepIndex,
      distanceToNextStepMeters,
      tick?.lastAcceptedFix?.speed ?? 0,
      instruction,
      (tick?.spokenCueIds ?? [])
        .filter((id) => id.startsWith(prefix))
        .map((id) => id.slice(prefix.length)),
    );
    if (!cue || !claimBrowserTransitCue(prefix + cue.key) || !voiceEnabled) return;
    speak(
      formatNavigationCue(
        {
          kind: "ground-maneuver",
          tier: cue.tier,
          instruction,
          ...(cue.tier === "now" ? {} : { distanceMeters: cue.distance }),
        },
        locale === "de" ? "de" : "en",
        { units },
      ),
    );
  }, [
    browserAuthority,
    transitProgress,
    upcoming,
    currentStepIndex,
    distanceToNextStepMeters,
    instruction,
    voiceEnabled,
    speak,
    locale,
    units,
  ]);

  return (
    <ManeuverBanner
      instruction={shownInstruction}
      distanceToManeuver={shown.distanceMeters}
      maneuver={maneuver}
      nextInstruction={nextInstruction}
      nextManeuver={nextInfo?.maneuver ?? (then ? { type: "arrive" } : undefined)}
      units={units}
    />
  );
}
