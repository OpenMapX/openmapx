"use client";

import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TerrainIcon from "@mui/icons-material/Terrain";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import type { Route } from "@openmapx/core";
import { useElevation } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { TEAL } from "@/lib/theme";
import { ElevationChart } from "./ElevationChart";
import { useElevationHover } from "./ElevationHoverContext";
import { ElevationStats } from "./ElevationStats";

interface ElevationProfileProps {
  route: Route;
  units: "metric" | "imperial";
}

export function ElevationProfile({ route, units }: ElevationProfileProps) {
  const t = useTranslations("elevation");
  const [expanded, setExpanded] = useState(false);
  const { setPoints } = useElevationHover();

  // Auto-expand for walking/cycling when significant elevation
  const shouldAutoExpand = route.mode !== "driving";

  const { data: profile, isLoading } = useElevation({
    route,
    enabled: expanded || shouldAutoExpand,
  });

  // Auto-expand for walking/cycling if there's significant elevation change
  useEffect(() => {
    if (shouldAutoExpand && profile && profile.stats.totalAscent > 50) {
      setExpanded(true);
    }
  }, [shouldAutoExpand, profile]);

  // Sync points to hover context whenever profile changes
  useEffect(() => {
    setPoints(profile?.points ?? []);
    return () => setPoints([]);
  }, [profile, setPoints]);

  // If no elevation data is available and not loading, hide entirely
  if (!isLoading && !profile && expanded) return null;

  const hasData = profile && profile.points.length >= 2;

  return (
    <Box>
      <Divider />
      <Box
        onClick={() => setExpanded((v) => !v)}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 2,
          py: 1,
          cursor: "pointer",
          "&:hover": { bgcolor: "action.hover" },
          transition: "background-color 0.15s",
          userSelect: "none",
        }}
      >
        <TerrainIcon sx={{ fontSize: 18, color: TEAL }} />
        <Typography variant="body2" fontWeight={500} sx={{ flex: 1 }}>
          {t("title")}
        </Typography>
        {hasData && !expanded && <ElevationStats stats={profile.stats} units={units} compact />}
        {isLoading && <CircularProgress size={14} sx={{ color: TEAL }} />}
        {expanded ? (
          <ExpandLessIcon sx={{ fontSize: 18, color: "text.secondary" }} />
        ) : (
          <ExpandMoreIcon sx={{ fontSize: 18, color: "text.secondary" }} />
        )}
      </Box>
      {expanded && hasData && (
        <Box sx={{ px: 1, pb: 1 }}>
          <Box sx={{ px: 1, pb: 0.75 }}>
            <ElevationStats stats={profile.stats} units={units} />
          </Box>
          <ElevationChart
            points={profile.points}
            mode={route.mode as "driving" | "walking" | "cycling"}
            units={units}
          />
        </Box>
      )}
      {expanded && isLoading && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
          <CircularProgress size={24} sx={{ color: TEAL }} />
        </Box>
      )}
    </Box>
  );
}
