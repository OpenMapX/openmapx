"use client";

import AddIcon from "@mui/icons-material/Add";
import ExploreIcon from "@mui/icons-material/Explore";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import RemoveIcon from "@mui/icons-material/Remove";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import { useMapStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMap } from "@/lib/MapContext";
import { Pegman } from "./Pegman";

export function MapControls() {
  const t = useTranslations("map");
  const { zoomIn, zoomOut, resetBearing, flyTo } = useMap();
  const bearing = useMapStore((s) => s.bearing);
  const pitch = useMapStore((s) => s.pitch);
  const setUserLocation = useMapStore((s) => s.setUserLocation);

  const handleMyLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lngLat: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        setUserLocation(lngLat);
        flyTo(lngLat, 14);
      },
      () => {
        // permission denied or unavailable — silently ignore
      },
    );
  };

  return (
    <Box
      sx={{
        position: "absolute",
        bottom: 48,
        right: 12,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 1,
        zIndex: 10,
      }}
    >
      {/* My location — topmost, matches Google Maps order */}
      <Tooltip title={t("myLocation")} placement="left">
        <Paper elevation={2} sx={{ borderRadius: "12px", overflow: "hidden" }}>
          <IconButton
            size="small"
            onClick={handleMyLocation}
            sx={{ width: 36, height: 36 }}
            aria-label={t("goToMyLocationAriaLabel")}
          >
            <MyLocationIcon sx={{ fontSize: 18, color: "primary.main" }} />
          </IconButton>
        </Paper>
      </Tooltip>

      {/* Zoom in / zoom out */}
      <Paper elevation={2} sx={{ borderRadius: "12px", overflow: "hidden" }}>
        <Tooltip title={t("zoomIn")} placement="left">
          <IconButton
            size="small"
            onClick={zoomIn}
            sx={{ width: 36, height: 36, borderRadius: 0 }}
            aria-label={t("zoomInAriaLabel")}
          >
            <AddIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        <Box sx={{ height: "1px", bgcolor: "divider", mx: 1 }} />
        <Tooltip title={t("zoomOut")} placement="left">
          <IconButton
            size="small"
            onClick={zoomOut}
            sx={{ width: 36, height: 36, borderRadius: 0 }}
            aria-label={t("zoomOutAriaLabel")}
          >
            <RemoveIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Paper>

      <Pegman />

      {/* Compass — only visible when map is rotated */}
      {(Math.abs(bearing) > 0.5 || pitch > 0.5) && (
        <Tooltip title={t("resetBearing")} placement="left">
          <Paper elevation={2} sx={{ borderRadius: "50%", overflow: "hidden" }}>
            <IconButton
              size="medium"
              onClick={resetBearing}
              sx={{ width: 40, height: 40 }}
              aria-label={t("resetBearingAriaLabel")}
            >
              <ExploreIcon
                sx={{
                  transform: `rotate(${-bearing}deg)`,
                  transition: "transform 0.2s",
                  color: "error.main",
                  fontSize: 22,
                }}
              />
            </IconButton>
          </Paper>
        </Tooltip>
      )}
    </Box>
  );
}
