"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { formatMeasurementDistance } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { maneuverIconFor } from "@/lib/navigation/maneuverIcon";

interface Props {
  instruction: string;
  distanceToManeuver: number;
  maneuver?: { type: string; modifier?: string };
  units: "metric" | "imperial";
}

export function ManeuverBanner({ instruction, distanceToManeuver, maneuver, units }: Props) {
  const t = useTranslations("navigation");
  const Icon = maneuverIconFor(maneuver).component;
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        p: 2,
        bgcolor: "primary.main",
        color: "primary.contrastText",
        borderRadius: 3,
      }}
    >
      <Icon sx={{ fontSize: 44 }} />
      <Box>
        <Typography variant="h6" sx={{ lineHeight: 1.1 }}>
          {t("in", { distance: formatMeasurementDistance(distanceToManeuver, units) })}
        </Typography>
        <Typography variant="body1">{instruction}</Typography>
      </Box>
    </Box>
  );
}
