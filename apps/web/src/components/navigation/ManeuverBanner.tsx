"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import {
  formatMeasurementDistance,
  type LaneDestinations,
  type ManeuverLane,
  type ManeuverSign,
  signHeadline,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { bannerInstruction, emphasizeRoadNames } from "@/lib/navigation/emphasizeRoadNames";
import { type Maneuver, maneuverIconFor } from "@/lib/navigation/maneuverIcon";
import { LaneGuidance } from "./LaneGuidance";
import { NavBannerShell } from "./NavBannerShell";
import { ExitSignStrip } from "./signs/ExitSignStrip";

/**
 * De-capitalize the leading word so a routing-engine instruction (which always
 * starts with a capitalized verb, e.g. "Take exit 21.") reads naturally when
 * embedded mid-sentence after "Then …". Only a normal Capitalized word is
 * lowercased; refs/acronyms like "B 477" (no lowercase second letter) are left
 * alone. Handles German umlauts.
 */
export function lowercaseFirstWord(instruction: string): string {
  if (/^[A-ZÄÖÜ][a-zäöüß]/.test(instruction)) {
    return instruction.charAt(0).toLowerCase() + instruction.slice(1);
  }
  return instruction;
}

/** Keep the full instruction; suppress sign text only when every name already appears there. */
function instructionRepeatsSignHeadline(instruction: string, sign?: ManeuverSign): boolean {
  const headline = signHeadline(sign);
  if (headline.length === 0) return false;
  const normalize = (text: string) =>
    text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedInstruction = normalize(instruction);
  return headline.every((name) => {
    const normalizedName = normalize(name);
    if (!normalizedName) return false;
    const escapedName = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Separators such as /, · and commas delimit names. Letters, marks, numbers,
    // hyphens and apostrophes do not: Aachen-West must not match just Aachen.
    return new RegExp(
      `(?:^|[^\\p{L}\\p{M}\\p{N}\\p{Pd}'’])${escapedName}(?=$|[^\\p{L}\\p{M}\\p{N}\\p{Pd}'’])`,
      "u",
    ).test(normalizedInstruction);
  });
}

export interface ManeuverBannerProps {
  instruction: string;
  distanceToManeuver: number;
  maneuver?: Maneuver;
  /** The step after the current one, previewed as "Then …". Omitted at the end. */
  nextInstruction?: string;
  nextManeuver?: Maneuver;
  /**
   * Turn-lane guidance for the upcoming maneuver. When present it takes the
   * banner's sub-row, replacing the "Then …" preview.
   */
  lanes?: ManeuverLane[];
  /** OSM destinations per lane on the approach, to pick the lanes toward the sign. */
  laneDestinations?: LaneDestinations[];
  laneSource?: "engine" | "osm";
  /** Interchange signage for the upcoming maneuver, when the engine supplies it. */
  sign?: ManeuverSign;
  /** Country of the route origin, for the sign palette. */
  country?: string | null;
  units: "metric" | "imperial";
  /** The roads the step follows, set in bold where the instruction names them. */
  roadNames?: string[];
}

export function ManeuverBanner({
  instruction,
  distanceToManeuver,
  maneuver,
  nextInstruction,
  nextManeuver,
  lanes,
  laneDestinations,
  laneSource,
  sign,
  country,
  units,
  roadNames,
}: ManeuverBannerProps) {
  const t = useTranslations("navigation");
  const Icon = maneuverIconFor(maneuver).component;
  const NextIcon = nextInstruction ? maneuverIconFor(nextManeuver).component : null;
  const hasLanes = !!lanes && lanes.length > 0;
  const hasNext = NextIcon && nextInstruction;
  // Lane guidance takes the sub-row. When there's also a following maneuver, the
  // "Then …" preview can't share the row, so it becomes a compact badge pinned
  // top-right of the main line (its arrow still shows which way it goes). With no
  // lanes, the preview keeps the full sub-row line.
  const secondary = hasLanes ? (
    <LaneGuidance
      variant="banner"
      lanes={lanes}
      maneuver={maneuver}
      sign={sign}
      laneDestinations={laneDestinations}
      source={laneSource}
    />
  ) : hasNext ? (
    <>
      <NextIcon sx={{ fontSize: 20, opacity: 0.85 }} />
      <Typography variant="body2" sx={{ opacity: 0.85 }} noWrap>
        {t("then", { instruction: lowercaseFirstWord(bannerInstruction(nextInstruction)) })}
      </Typography>
    </>
  ) : undefined;
  const trailing =
    hasLanes && hasNext ? (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0.25,
          px: 1,
          py: 0.5,
          borderRadius: 2,
          flexShrink: 0,
          bgcolor: "rgba(0, 0, 0, 0.18)",
        }}
      >
        <Typography
          variant="caption"
          sx={{ fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase", opacity: 0.7 }}
        >
          {t("thenLabel")}
        </Typography>
        <NextIcon sx={{ fontSize: 26 }} />
      </Box>
    ) : undefined;
  return (
    <NavBannerShell
      leading={
        // The arrow with the distance to it underneath, read together at a glance.
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            minWidth: 56,
            flexShrink: 0,
          }}
        >
          <Icon sx={{ fontSize: 44 }} />
          <Typography
            sx={{ fontSize: 18, fontWeight: 600, lineHeight: 1.2, whiteSpace: "nowrap" }}
            aria-label={t("in", { distance: formatMeasurementDistance(distanceToManeuver, units) })}
          >
            {formatMeasurementDistance(distanceToManeuver, units)}
          </Typography>
        </Box>
      }
      secondary={secondary}
      trailing={trailing}
    >
      {sign && (
        <ExitSignStrip
          sign={sign}
          country={country}
          size="banner"
          hideHeadline={instructionRepeatsSignHeadline(instruction, sign)}
        />
      )}
      <Typography sx={{ fontSize: 20, lineHeight: 1.25 }}>
        {emphasizeRoadNames(bannerInstruction(instruction), roadNames).map((part, index) =>
          part.road ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and static per render
            <Box key={index} component="span" sx={{ fontWeight: 700 }}>
              {part.text}
            </Box>
          ) : (
            part.text
          ),
        )}
      </Typography>
    </NavBannerShell>
  );
}
