"use client";

import Typography from "@mui/material/Typography";
import { formatMeasurementDistance, type ManeuverLane } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { type Maneuver, maneuverIconFor } from "@/lib/navigation/maneuverIcon";
import { LaneGuidance } from "./LaneGuidance";
import { NavBannerShell } from "./NavBannerShell";

/**
 * De-capitalize the leading word so a routing-engine instruction (which always
 * starts with a capitalized verb, e.g. "Take exit 21.") reads naturally when
 * embedded mid-sentence after "Then …". Only a normal Capitalized word is
 * lowercased; refs/acronyms like "B 477" (no lowercase second letter) are left
 * alone. Handles German umlauts.
 */
export function lowercaseFirstWord(instruction: string): string {
  if (
    instruction.length >= 2 &&
    /[A-ZÄÖÜ]/.test(instruction[0]) &&
    /[a-zäöüß]/.test(instruction[1])
  ) {
    return instruction[0].toLowerCase() + instruction.slice(1);
  }
  return instruction;
}

interface Props {
  instruction: string;
  distanceToManeuver: number;
  maneuver?: Maneuver;
  /** The step after the current one, previewed as "Then …". Omitted at the end. */
  nextInstruction?: string;
  nextManeuver?: Maneuver;
  /**
   * Turn-lane guidance for the upcoming maneuver. When present it takes the
   * banner's sub-row (like Google Maps), replacing the "Then …" preview.
   */
  lanes?: ManeuverLane[];
  units: "metric" | "imperial";
}

export function ManeuverBanner({
  instruction,
  distanceToManeuver,
  maneuver,
  nextInstruction,
  nextManeuver,
  lanes,
  units,
}: Props) {
  const t = useTranslations("navigation");
  const Icon = maneuverIconFor(maneuver).component;
  const NextIcon = nextInstruction ? maneuverIconFor(nextManeuver).component : null;
  // Lane guidance wins the sub-row over the "Then …" preview when we have it.
  const secondary =
    lanes && lanes.length > 0 ? (
      <LaneGuidance variant="banner" lanes={lanes} maneuver={maneuver} />
    ) : NextIcon && nextInstruction ? (
      <>
        <NextIcon sx={{ fontSize: 20, opacity: 0.85 }} />
        <Typography variant="body2" sx={{ opacity: 0.85 }} noWrap>
          {t("then", { instruction: lowercaseFirstWord(nextInstruction) })}
        </Typography>
      </>
    ) : undefined;
  return (
    <NavBannerShell leading={<Icon sx={{ fontSize: 44 }} />} secondary={secondary}>
      <Typography variant="h6" sx={{ lineHeight: 1.1 }}>
        {t("in", { distance: formatMeasurementDistance(distanceToManeuver, units) })}
      </Typography>
      <Typography variant="body1">{instruction}</Typography>
    </NavBannerShell>
  );
}
