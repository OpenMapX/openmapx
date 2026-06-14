"use client";

import AddIcon from "@mui/icons-material/Add";
import ExploreIcon from "@mui/icons-material/Explore";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import RemoveIcon from "@mui/icons-material/Remove";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import { useMapStore, useNavigationStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useMyLocation } from "@/components/command-palette/useMyLocation";
import { MOBILE_SHEET_FOLLOW_CAP_FRACTION } from "@/components/panels/MobileBottomSheet";
import { useMap } from "@/lib/MapContext";
import { useMobilePanelMaxHeight } from "@/lib/mobilePanelHeight";
import { useRouteSearchStore } from "@/lib/navigation/routeSearchStore";
import { Pegman } from "./Pegman";

const BASE_BOTTOM = 48;
const PANEL_GAP = 12;
// Clearance above the navigation bottom bar so the controls don't sit under it.
const NAV_BOTTOM = 150;

export function MapControls() {
  const t = useTranslations("map");
  const tNav = useTranslations("navigation");
  const { zoomIn, zoomOut, resetBearing } = useMap();
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const navKind = useNavigationStore((s) => s.kind);
  const navCameraMode = useNavigationStore((s) => s.cameraMode);
  const setCameraMode = useNavigationStore((s) => s.setCameraMode);
  // Search-along-route is ground-nav only; its button joins this control stack.
  const routeSearchOpen = useRouteSearchStore((s) => s.open);
  const openRouteSearch = useRouteSearchStore((s) => s.openPicker);
  const showRouteSearchButton = navigating && navKind === "ground" && !routeSearchOpen;
  const bearing = useMapStore((s) => s.bearing);
  const pitch = useMapStore((s) => s.pitch);
  const handleMyLocation = useMyLocation();
  const mobilePanelHeight = useMobilePanelMaxHeight();
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
        bottom: navigating
          ? `calc(${NAV_BOTTOM}px + var(--omx-safe-bottom))`
          : {
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
        transition: "bottom 0.25s ease",
      }}
    >
      {/* Search along route (ground navigation only) — top of the stack. */}
      {showRouteSearchButton && (
        <Tooltip title={tNav("searchAlongRoute")} placement="left">
          <Paper elevation={2} sx={{ borderRadius: "50%", overflow: "hidden" }}>
            <IconButton
              size="medium"
              onClick={openRouteSearch}
              sx={{ width: 40, height: 40 }}
              aria-label={tNav("searchAlongRoute")}
            >
              <SearchIcon sx={{ fontSize: 22, color: "primary.main" }} />
            </IconButton>
          </Paper>
        </Tooltip>
      )}

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

      {/* Street View pegman is irrelevant during turn-by-turn navigation. */}
      {!navigating && <Pegman />}

      {/* Compass — while navigating it appears only when the user has panned
          off-track and recenters/resumes tracking; otherwise it resets bearing
          and is only visible when the map is rotated. */}
      {(navigating ? navCameraMode === "free" : Math.abs(bearing) > 0.5 || pitch > 0.5) && (
        <Tooltip title={navigating ? tNav("recenter") : t("resetBearing")} placement="left">
          <Paper elevation={2} sx={{ borderRadius: "50%", overflow: "hidden" }}>
            <IconButton
              size="medium"
              onClick={navigating ? () => setCameraMode("follow") : resetBearing}
              sx={{ width: 40, height: 40 }}
              aria-label={navigating ? tNav("recenter") : t("resetBearingAriaLabel")}
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
