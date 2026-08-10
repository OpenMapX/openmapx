"use client";

import { type TransitProgress, useNavigationStore } from "@openmapx/core";
import {
  composeWalkInstruction,
  walkLegStepProgress,
  walkStepInfo,
} from "@openmapx/core/navigation";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";
import { useNavigationVoice } from "@/lib/navigation/useNavigationVoice";
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
  const t = useTranslations("navigation");
  const locale = useLocale();
  const speak = useNavigationVoice(locale);
  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);

  const steps = leg.steps ?? [];
  const fraction = transitProgress?.fractionAlongLeg ?? 0;
  const { currentStepIndex, distanceToNextStepMeters } = walkLegStepProgress(steps, fraction);

  // The maneuver you're approaching sits at the END of the current step, i.e. the
  // next step's turn; past the last step you're arriving at the leg destination.
  const upcoming = steps[currentStepIndex + 1];
  const nextAfter = steps[currentStepIndex + 2];
  const upcomingInfo = upcoming ? walkStepInfo(upcoming) : null;
  const maneuver = upcomingInfo ? upcomingInfo.maneuver : { type: "arrive" };
  const instruction = upcomingInfo
    ? composeWalkInstruction(upcomingInfo, t)
    : t("walkDir.arrive", { place: leg.to.name });
  const nextInfo = nextAfter ? walkStepInfo(nextAfter) : null;
  const nextInstruction = nextInfo ? composeWalkInstruction(nextInfo, t) : undefined;

  // Announce each instruction as the step advances (keyed on the step index).
  // biome-ignore lint/correctness/useExhaustiveDependencies: speak once per step.
  useEffect(() => {
    if (voiceEnabled) speak(instruction);
  }, [currentStepIndex]);

  return (
    <ManeuverBanner
      instruction={instruction}
      distanceToManeuver={distanceToNextStepMeters}
      maneuver={maneuver}
      nextInstruction={nextInstruction}
      nextManeuver={nextInfo?.maneuver}
      units={units}
    />
  );
}
