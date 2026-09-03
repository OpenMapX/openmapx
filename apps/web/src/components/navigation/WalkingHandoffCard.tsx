"use client";

import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import {
  formatDuration,
  formatMeasurementDistance,
  type Route,
  useSettingsStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";

interface Props {
  route: Route | null;
  isLoading: boolean;
  onStartWalking: () => void;
  disabled?: boolean;
}

export function WalkingHandoffCard({ route, isLoading, onStartWalking, disabled = false }: Props) {
  const t = useTranslations("navigation");
  const units = useSettingsStore((s) => s.units);

  if (isLoading) {
    return (
      <Box
        sx={{ width: "100%", p: 1.5, bgcolor: "action.hover", borderRadius: 2 }}
        role="status"
        aria-busy="true"
        aria-label={t("walkToDestination")}
      >
        <Skeleton variant="text" width="60%" height={24} />
        <Skeleton variant="rectangular" width="100%" height={40} sx={{ mt: 1, borderRadius: 1 }} />
      </Box>
    );
  }

  if (!route) return null;

  return (
    <Box
      sx={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 1,
        p: 2,
        bgcolor: "action.hover",
        borderRadius: 2,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {t("walkToDestination")}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {formatDuration(route.duration)} · {formatMeasurementDistance(route.distance, units)}
        </Typography>
      </Box>
      <Button
        variant="contained"
        color="primary"
        fullWidth
        startIcon={<DirectionsWalkIcon />}
        onClick={onStartWalking}
        disabled={disabled}
        sx={{ minHeight: 48 }}
      >
        {t("startWalking")}
      </Button>
    </Box>
  );
}
