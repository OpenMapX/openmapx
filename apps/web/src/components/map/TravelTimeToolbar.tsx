"use client";

import CloseIcon from "@mui/icons-material/Close";
import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { IsochroneTravelMode, LngLat } from "@openmapx/core";
import { TRAVEL_TIME_PRESETS, useIsochrone, useTravelTimeStore } from "@openmapx/core";
import { useTranslations } from "next-intl";

function formatPresetLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m}`;
}

export function TravelTimeToolbar() {
  const t = useTranslations("travelTime");
  const isActive = useTravelTimeStore((s) => s.isActive);
  const origin = useTravelTimeStore((s) => s.origin);
  const mode = useTravelTimeStore((s) => s.mode);
  const selectedMinutes = useTravelTimeStore((s) => s.selectedMinutes);
  const setMode = useTravelTimeStore((s) => s.setMode);
  const toggleMinutes = useTravelTimeStore((s) => s.toggleMinutes);
  const setOrigin = useTravelTimeStore((s) => s.setOrigin);
  const deactivate = useTravelTimeStore((s) => s.deactivate);

  const { isFetching } = useIsochrone({
    origin,
    mode,
    contourMinutes: selectedMinutes,
    enabled: isActive,
  });

  if (!isActive) return null;

  const presets = TRAVEL_TIME_PRESETS[mode];

  const handleMyLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lngLat: LngLat = [pos.coords.longitude, pos.coords.latitude];
        setOrigin(lngLat);
      },
      () => {},
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  return (
    <Paper
      elevation={3}
      sx={{
        px: 1.5,
        py: 1,
        borderRadius: "12px",
        display: "flex",
        flexDirection: "column",
        gap: 1,
        maxWidth: { xs: "calc(100vw - 24px)", sm: 480 },
      }}
    >
      {/* Top row: mode + my location + status + close */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <ToggleButtonGroup
          value={mode}
          exclusive
          size="small"
          onChange={(_, v: IsochroneTravelMode | null) => {
            if (v) setMode(v);
          }}
          sx={{ "& .MuiToggleButton-root": { px: 1, py: 0.5 } }}
        >
          <ToggleButton value="driving" aria-label={t("driving")}>
            <Tooltip title={t("driving")}>
              <DirectionsCarIcon sx={{ fontSize: 20 }} />
            </Tooltip>
          </ToggleButton>
          <ToggleButton value="walking" aria-label={t("walking")}>
            <Tooltip title={t("walking")}>
              <DirectionsWalkIcon sx={{ fontSize: 20 }} />
            </Tooltip>
          </ToggleButton>
          <ToggleButton value="cycling" aria-label={t("cycling")}>
            <Tooltip title={t("cycling")}>
              <DirectionsBikeIcon sx={{ fontSize: 20 }} />
            </Tooltip>
          </ToggleButton>
        </ToggleButtonGroup>

        <Tooltip title={t("myLocation")}>
          <IconButton size="small" onClick={handleMyLocation} aria-label={t("myLocation")}>
            <MyLocationIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </Tooltip>

        <Box sx={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {isFetching ? (
            <CircularProgress size={16} />
          ) : (
            <Typography sx={{ fontSize: 12, color: "text.secondary", textAlign: "center" }}>
              {origin ? t("dragToMove") : t("clickToPlace")}
            </Typography>
          )}
        </Box>

        <Tooltip title={t("close")}>
          <IconButton size="small" onClick={deactivate} aria-label={t("close")}>
            <CloseIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </Tooltip>
      </Box>

      <Divider />

      {/* Bottom row: time preset chips */}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, justifyContent: "center" }}>
        {presets.map((minutes) => {
          const selected = selectedMinutes.includes(minutes);
          return (
            <Chip
              key={minutes}
              label={formatPresetLabel(minutes)}
              size="small"
              variant={selected ? "filled" : "outlined"}
              color={selected ? "primary" : "default"}
              onClick={() => toggleMinutes(minutes)}
              sx={{
                fontWeight: selected ? 600 : 400,
                fontSize: 12,
              }}
            />
          );
        })}
      </Box>
    </Paper>
  );
}
