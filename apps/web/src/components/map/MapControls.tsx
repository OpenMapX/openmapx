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
import { useEffect, useState } from "react";
import { useMyLocation } from "@/components/command-palette/useMyLocation";
import { MOBILE_SHEET_FOLLOW_CAP_FRACTION } from "@/components/panels/MobileBottomSheet";
import { useMap } from "@/lib/MapContext";
import { useMapAttributionExpanded } from "@/lib/mapAttributionExpanded";
import { useMobilePanelMaxHeight } from "@/lib/mobilePanelHeight";
import { Pegman } from "./Pegman";

const BASE_BOTTOM = 48;
const PANEL_GAP = 12;

export function MapControls() {
  const t = useTranslations("map");
  const { zoomIn, zoomOut, resetBearing } = useMap();
  const bearing = useMapStore((s) => s.bearing);
  const pitch = useMapStore((s) => s.pitch);
  const handleMyLocation = useMyLocation();
  const mobilePanelHeight = useMobilePanelMaxHeight();
  const attributionExpanded = useMapAttributionExpanded();
  const [vh, setVh] = useState(0);
  useEffect(() => {
    const update = () => setVh(window.innerHeight);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  // Cap how far the controls follow the sheet — when the user drags above the
  // medium snap, the sheet covers the controls anyway, so freezing the offset
  // here keeps them in their last reachable position rather than scrolling
  // them off the top of the visible map area.
  const followHeight =
    vh > 0 ? Math.min(mobilePanelHeight, vh * MOBILE_SHEET_FOLLOW_CAP_FRACTION) : mobilePanelHeight;

  return (
    <Box
      sx={{
        position: "absolute",
        bottom: {
          xs:
            followHeight > 0
              ? `calc(${followHeight + PANEL_GAP}px + var(--omx-safe-bottom))`
              : `calc(${BASE_BOTTOM}px + var(--omx-safe-bottom))`,
          sm: `calc(${BASE_BOTTOM}px + var(--omx-safe-bottom))`,
        },
        right: "calc(12px + var(--omx-safe-right))",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 1,
        zIndex: 10,
        opacity: { xs: attributionExpanded ? 0 : 1, sm: 1 },
        pointerEvents: { xs: attributionExpanded ? "none" : "auto", sm: "auto" },
        transition: "bottom 0.25s ease, opacity 0.18s ease",
      }}
    >
      {/* My location */}
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
