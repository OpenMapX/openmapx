"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { formatMeasurementDistance } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { type Maneuver, maneuverIconFor } from "@/lib/navigation/maneuverIcon";

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
  units: "metric" | "imperial";
}

export function ManeuverBanner({
  instruction,
  distanceToManeuver,
  maneuver,
  nextInstruction,
  nextManeuver,
  units,
}: Props) {
  const t = useTranslations("navigation");
  const Icon = maneuverIconFor(maneuver).component;
  const NextIcon = nextInstruction ? maneuverIconFor(nextManeuver).component : null;
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        bgcolor: "primary.main",
        color: "primary.contrastText",
        borderRadius: 3,
        overflow: "hidden",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, p: 2 }}>
        <Icon sx={{ fontSize: 44 }} />
        <Box>
          <Typography variant="h6" sx={{ lineHeight: 1.1 }}>
            {t("in", { distance: formatMeasurementDistance(distanceToManeuver, units) })}
          </Typography>
          <Typography variant="body1">{instruction}</Typography>
        </Box>
      </Box>
      {NextIcon && nextInstruction && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2,
            py: 1,
            bgcolor: "rgba(0, 0, 0, 0.18)",
          }}
        >
          <NextIcon sx={{ fontSize: 20, opacity: 0.85 }} />
          <Typography variant="body2" sx={{ opacity: 0.85 }} noWrap>
            {t("then", { instruction: lowercaseFirstWord(nextInstruction) })}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
