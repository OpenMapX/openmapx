"use client";

import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { Route } from "@openmapx/core";
import { formatDistance, formatDuration } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { TEAL } from "@/lib/theme";

export function RouteCard({
  route,
  index,
  active,
  onSelect,
  onDetails,
  units,
}: {
  route: Route;
  index: number;
  active: boolean;
  onSelect: () => void;
  onDetails: () => void;
  units: "metric" | "imperial";
}) {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const dist =
    units === "imperial"
      ? `${(route.distance / 1609.34).toFixed(1)} mi`
      : formatDistance(route.distance);

  const modeIcon =
    route.mode === "driving" ? (
      <DirectionsCarIcon sx={{ fontSize: 22, color: active ? TEAL : "text.disabled" }} />
    ) : route.mode === "walking" ? (
      <DirectionsWalkIcon sx={{ fontSize: 22, color: active ? TEAL : "text.disabled" }} />
    ) : (
      <DirectionsBikeIcon sx={{ fontSize: 22, color: active ? TEAL : "text.disabled" }} />
    );

  return (
    <Box
      onClick={onSelect}
      sx={{
        display: "flex",
        gap: 1.5,
        px: 2,
        py: 1.5,
        cursor: "pointer",
        borderLeft: active ? `4px solid ${TEAL}` : "4px solid transparent",
        bgcolor: active ? "rgba(0,123,139,0.04)" : "transparent",
        "&:hover": { bgcolor: active ? "rgba(0,123,139,0.07)" : "action.hover" },
        transition: "background-color 0.15s",
      }}
    >
      <Box sx={{ flexShrink: 0, mt: 0.25 }}>{modeIcon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <Typography
            variant="body2"
            noWrap
            sx={{
              fontWeight: 600,
              color: "text.primary",
              flex: 1,
              mr: 1,
            }}
          >
            {route.summary ?? t("bestRoute")}
          </Typography>
          <Typography
            variant="body2"
            color={active ? TEAL : "text.primary"}
            sx={{
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {formatDuration(route.duration)}
          </Typography>
        </Box>
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {dist}
        </Typography>
        {active && index === 0 && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              display: "block",
            }}
          >
            {t("fastestRoute")}
          </Typography>
        )}
        {active && (
          <Box sx={{ mt: 0.5, ml: -1.5 }}>
            <Typography
              component="span"
              variant="caption"
              sx={{
                color: TEAL,
                cursor: "pointer",
                fontWeight: 500,
                px: 1.5,
                py: 0.75,
                borderRadius: 99,
                "&:hover": { bgcolor: `${TEAL}18` },
                transition: "background-color 0.15s",
              }}
              onClick={(e) => {
                e.stopPropagation();
                onDetails();
              }}
            >
              {tc("details")}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
