"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { Route } from "@openmapx/core";
import { formatDistance, formatDuration } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { ElevationProfile } from "@/components/elevation/ElevationProfile";
import { StepRow } from "@/components/panels/directions/StepRow";

export function DetailsView({
  route,
  originLabel,
  destinationLabel,
  units,
  onBack,
}: {
  route: Route;
  originLabel: string;
  destinationLabel: string;
  units: "metric" | "imperial";
  onBack: () => void;
}) {
  const t = useTranslations("directions");
  const dist =
    units === "imperial"
      ? `${(route.distance / 1609.34).toFixed(1)} mi`
      : formatDistance(route.distance);

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, px: 1.5, pt: 2, pb: 1 }}>
        <IconButton size="small" onClick={onBack} sx={{ mt: 0.25, flexShrink: 0 }}>
          <ArrowBackIcon sx={{ fontSize: 20 }} />
        </IconButton>
        <Box>
          <Typography variant="caption" color="text.secondary">
            {t("from")}{" "}
            <Box component="span" fontWeight={600} color="text.primary">
              {originLabel || t("origin")}
            </Box>
          </Typography>
          <br />
          <Typography variant="caption" color="text.secondary">
            {t("to")}{" "}
            <Box component="span" fontWeight={600} color="text.primary">
              {destinationLabel || t("destination")}
            </Box>
          </Typography>
        </Box>
      </Box>
      <Divider />
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography variant="h6" fontWeight={600} color="success.main" component="span">
          {formatDuration(route.duration)}{" "}
        </Typography>
        <Typography variant="body1" color="text.secondary" component="span">
          ({dist})
        </Typography>
        {route.summary && (
          <Typography variant="body2" color="text.secondary" display="block">
            {route.summary}
          </Typography>
        )}
      </Box>
      <Divider />
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography variant="body2" fontWeight={700}>
          {originLabel || t("origin")}
        </Typography>
      </Box>
      {route.steps.map((step, i) => (
        <StepRow
          // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable id
          key={i}
          instruction={step.instruction}
          distance={step.distance}
          duration={step.duration}
          units={units}
        />
      ))}
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography variant="body2" fontWeight={700}>
          {destinationLabel || t("destination")}
        </Typography>
      </Box>
      {route.mode !== "transit" && <ElevationProfile route={route} units={units} />}
    </Box>
  );
}
